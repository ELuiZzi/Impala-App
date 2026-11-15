import { Channel } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { uploadUrl, type Session, type UploadResponse } from '@/api/subsonic';
import { invoke } from '@/platform/web/tauri';
import type { UploadStatus } from './store';

/**
 * Importar en la app de PC: archivos o carpetas del equipo (elegidos o arrastrados a la ventana) que se suben al
 * uploader del servidor. Lo pesado (huella MD5 y subida) lo hace Rust (desktop/src-tauri/src/files.rs). A
 * diferencia del teléfono, los originales nunca se borran: en el PC son tu música, no una carpeta de paso.
 */
export type PcFile = { path: string; name: string; size: number };
export type PcUploadItem = PcFile & { status: UploadStatus };

type State = { items: PcUploadItem[]; running: boolean };

let state: State = { items: [], running: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function usePcUploads<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => selector(state),
  );
}

/** Añade a la lista (sin repetir rutas). Devuelve cuántos eran nuevos. */
export function addPcFiles(files: PcFile[]): number {
  const known = new Set(state.items.map((it) => it.path));
  const fresh = files.filter((f) => !known.has(f.path));
  if (fresh.length > 0) set({ items: [...state.items, ...fresh.map((f) => ({ ...f, status: { kind: 'pending' } as const }))] });
  return fresh.length;
}

export async function pickPcFiles(folder: boolean): Promise<number> {
  return addPcFiles(await invoke<PcFile[]>('pick_audio', { folder }));
}

export function removePcFile(path: string) {
  if (state.running) return;
  set({ items: state.items.filter((it) => it.path !== path) });
}

/** Quita de la lista lo que ya se subió. */
export function clearDone() {
  if (state.running) return;
  set({ items: state.items.filter((it) => it.status.kind !== 'done') });
}

function update(path: string, status: UploadStatus) {
  set({ items: state.items.map((it) => (it.path === path ? { ...it, status } : it)) });
}

/** Sube los pendientes uno a uno; solo cuenta como subido si el servidor confirma el mismo tamaño y MD5. */
export async function uploadPcFiles(session: Session): Promise<{ uploaded: number; failed: number }> {
  if (state.running) return { uploaded: 0, failed: 0 };
  set({ running: true });
  let uploaded = 0;
  let failed = 0;
  for (const item of state.items.filter((it) => it.status.kind !== 'done')) {
    try {
      update(item.path, { kind: 'hashing' });
      const onProgress = new Channel<{ done: number; total: number }>();
      onProgress.onmessage = ({ done, total }) => update(item.path, { kind: 'uploading', progress: total > 0 ? done / total : 0 });
      const result = await invoke<{ status: number; body: string; md5: string }>('upload_file', { path: item.path, url: uploadUrl(session), onProgress });
      let body: ({ error?: string } & Partial<UploadResponse>) | null = null;
      try {
        body = JSON.parse(result.body);
      } catch {
        // Respuesta que no es JSON: se informa con el código HTTP.
      }
      if (result.status !== 200 && result.status !== 201) throw new Error(body?.error ?? `El servidor respondió HTTP ${result.status}`);
      if (body?.md5 !== result.md5 || body?.size !== item.size) throw new Error('La copia del servidor no coincide con el archivo');
      update(item.path, { kind: 'done', duplicate: !!body.duplicate });
      uploaded++;
    } catch (e) {
      update(item.path, { kind: 'error', message: e instanceof Error ? e.message : String(e) });
      failed++;
    }
  }
  set({ running: false });
  return { uploaded, failed };
}
