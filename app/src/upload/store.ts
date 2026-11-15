import { Directory, File, UploadType } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import ImpalaPlayer from '../../modules/impala-player';
import { uploadUrl, type Session, type UploadResponse } from '@/api/subsonic';

/** Mismas extensiones que acepta el microservicio de ingestión. */
const AUDIO_EXTENSIONS = /\.(flac|mp3|opus|ogg|oga|m4a|aac|wav|aif|aiff|wma|ape|wv|dsf)$/i;
const FOLDER_KEY = 'impala.uploadFolder';

export type UploadStatus =
  | { kind: 'pending' }
  | { kind: 'hashing' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'done'; duplicate: boolean }
  | { kind: 'error'; message: string };

export type UploadItem = { uri: string; name: string; size: number; status: UploadStatus };

type UploadState = {
  folder: Directory | null;
  items: UploadItem[];
  running: boolean;
  /** Copiando o moviendo archivos elegidos hacia la carpeta. */
  adding: boolean;
  /** true si el permiso de la carpeta guardada se perdió (p. ej. la carpeta se borró). */
  folderLost: boolean;
};

let state: UploadState = { folder: null, items: [], running: false, adding: false, folderLost: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<UploadState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useUploads<T>(selector: (s: UploadState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

function updateItem(uri: string, status: UploadStatus) {
  set({ items: state.items.map((it) => (it.uri === uri ? { ...it, status } : it)) });
}

// --- Carpeta ------------------------------------------------------------------------------

/** Recupera la carpeta elegida anteriormente (el permiso SAF es persistente). */
export async function loadFolder() {
  if (state.folder) return;
  const uri = await SecureStore.getItemAsync(FOLDER_KEY).catch(() => null);
  if (!uri) return;
  const folder = new Directory(uri);
  if (folder.exists) {
    set({ folder, folderLost: false });
    refreshFiles();
  } else {
    set({ folderLost: true });
  }
}

export async function pickFolder() {
  const folder = await Directory.pickDirectoryAsync(state.folder?.uri);
  await SecureStore.setItemAsync(FOLDER_KEY, folder.uri);
  set({ folder, folderLost: false });
  refreshFiles();
}

/** Lista los audios de la carpeta (sin subcarpetas), conservando el estado de los que ya estaban. */
export function refreshFiles() {
  if (!state.folder || state.running) return;
  const previous = new Map(state.items.map((it) => [it.uri, it.status]));
  const files = state.folder
    .list()
    .filter((f): f is File => f instanceof File && AUDIO_EXTENSIONS.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  set({
    items: files.map((f) => {
      const old = previous.get(f.uri);
      return { uri: f.uri, name: f.name, size: f.size ?? 0, status: old?.kind === 'error' ? old : { kind: 'pending' } };
    }),
  });
}

// --- Añadir archivos a la carpeta ---------------------------------------------------------

export type AddResult = { added: number; skipped: string[]; failed: string[]; notDeleted: string[] };

/**
 * Elige archivos de audio en cualquier parte del teléfono y los copia a la carpeta de importación.
 * Con `cut`, el original solo se borra si la copia tiene la misma huella MD5. Algunos orígenes
 * (p. ej. "Audio" o "Recientes" del selector) no permiten borrar: ahí el original se conserva.
 */
export async function addFiles(cut: boolean): Promise<AddResult | null> {
  const folder = state.folder;
  if (!folder || state.adding || state.running) return null;
  const picked = await File.pickFileAsync({
    multipleFiles: true,
    // Muchos FLAC/Opus llegan sin tipo de audio; se filtran después por extensión.
    mimeTypes: ['audio/*', 'application/ogg', 'application/x-flac', 'application/octet-stream'],
  });
  if (picked.canceled) return null;

  set({ adding: true });
  const result: AddResult = { added: 0, skipped: [], failed: [], notDeleted: [] };
  try {
    const existing = new Set(folder.list().map((f) => f.name));
    for (const source of picked.result) {
      const name = source.name;
      if (!AUDIO_EXTENSIONS.test(name) || existing.has(name)) {
        result.skipped.push(name);
        continue;
      }
      try {
        await source.copy(folder);
        existing.add(name);
        result.added++;
      } catch {
        result.failed.push(name);
        continue;
      }
      if (!cut) continue;
      try {
        const copy = folder.list().find((f): f is File => f instanceof File && f.name === name);
        if (!copy || copy.size !== source.size) throw new Error('copia incompleta');
        const [a, b] = await Promise.all([ImpalaPlayer.md5(source.uri), ImpalaPlayer.md5(copy.uri)]);
        if (a !== b) throw new Error('huella distinta');
        source.delete();
      } catch {
        result.notDeleted.push(name);
      }
    }
  } finally {
    set({ adding: false });
    refreshFiles();
  }
  return result;
}

/** ".../tree/primary%3AMusic%2FSubir/" → "Music/Subir" */
export function folderLabel(folder: Directory): string {
  const tree = decodeURIComponent(folder.uri).split('/tree/').pop() ?? '';
  const path = tree.split(':').pop()?.replace(/\/+$/, '');
  return path || folder.name || 'Carpeta';
}

// --- Subida -------------------------------------------------------------------------------

/**
 * Sube los archivos pendientes uno a uno. Un archivo solo se borra del teléfono si el servidor
 * confirma tamaño y MD5 idénticos a los locales; ante cualquier duda se conserva.
 */
export async function uploadAll(session: Session): Promise<{ uploaded: number; failed: number }> {
  if (state.running) return { uploaded: 0, failed: 0 };
  set({ running: true });
  let uploaded = 0;
  let failed = 0;

  for (const item of state.items.filter((it) => it.status.kind !== 'done')) {
    try {
      updateItem(item.uri, { kind: 'hashing' });
      const localMd5 = await ImpalaPlayer.md5(item.uri);

      updateItem(item.uri, { kind: 'uploading', progress: 0 });
      const file = new File(item.uri);
      const task = file.createUploadTask(uploadUrl(session), {
        uploadType: UploadType.MULTIPART,
        fieldName: 'file',
        onProgress: ({ bytesSent, totalBytes }) =>
          updateItem(item.uri, { kind: 'uploading', progress: totalBytes > 0 ? bytesSent / totalBytes : 0 }),
      });
      const result = await task.uploadAsync();
      if (!result) throw new Error('Subida cancelada');

      const body = parseJson(result.body);
      if (result.status !== 200 && result.status !== 201) {
        throw new Error(body?.error ?? `El servidor respondió HTTP ${result.status}`);
      }
      const response = body as UploadResponse;
      if (response.md5 !== localMd5 || response.size !== item.size) {
        throw new Error('La copia del servidor no coincide; el archivo se conserva');
      }

      file.delete();
      updateItem(item.uri, { kind: 'done', duplicate: response.duplicate });
      uploaded++;
    } catch (e) {
      updateItem(item.uri, { kind: 'error', message: e instanceof Error ? e.message : 'Error desconocido' });
      failed++;
    }
  }

  set({ running: false });
  return { uploaded, failed };
}

function parseJson(text: string): { error?: string } & Partial<UploadResponse> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
