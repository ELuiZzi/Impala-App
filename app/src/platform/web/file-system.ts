/**
 * Sustituto de `expo-file-system` en PC (Metro lo usa solo al compilar para web, ver metro.config.js).
 *
 * La app usa la API síncrona (exists, textSync, write) como en el teléfono. En la ventana de Tauri todos los
 * archivos de texto se cargan en memoria antes de arrancar (`loadFileSystem`, desde index.web.ts) y cada
 * cambio se guarda en disco por detrás, en orden (`%APPDATA%\com.luizzi.impala`, ver storage.rs). En un
 * navegador, sin Tauri, se usa localStorage.
 * Descargar o subir archivos binarios no está disponible todavía (Fase 4).
 */
import { Channel } from '@tauri-apps/api/core';
import { invoke, isTauri } from './tauri';

type Entry = { text: string | null; size: number };
type Snapshot = { files: { uri: string; text: string | null; size: number }[]; dirs: string[] };

const PREFIX = 'impala-fs:';
const notAvailable = (what: string) => new Error(`${what} no está disponible en PC todavía`);

/** null hasta loadFileSystem en Tauri; en un navegador se queda así y se usa localStorage. */
let memory: Map<string, Entry> | null = null;
const dirs = new Set<string>();

/** Las escrituras a disco van de una en una: el último cambio de un archivo es el que queda. */
let queue: Promise<unknown> = Promise.resolve();
function persist(cmd: string, args: Record<string, unknown>) {
  queue = queue.then(() => invoke(cmd, args)).catch((e) => console.warn(`No se pudo guardar (${cmd}):`, e));
}

/**
 * Un archivo que escribió Rust (recortes, copia del original…): se apunta para que exists/delete lo vean. Sin esto,
 * la app no encontraba la copia del original hasta reiniciar y los temporales se quedaban en la caché.
 */
export function noteWrittenFile(uri: string, size = 0) {
  memory?.set(uri, { text: null, size });
}

export async function loadFileSystem(): Promise<void> {
  if (!isTauri()) return;
  const snapshot = await invoke<Snapshot>('fs_snapshot');
  memory = new Map(snapshot.files.map((f) => [f.uri, { text: f.text, size: f.size }]));
  snapshot.dirs.forEach((d) => dirs.add(d));
  migrateLocalStorage();
}

/** La Fase 0 guardaba los archivos en localStorage: pasan a disco una vez (lo que ya está en disco gana). */
function migrateLocalStorage() {
  const s = storage();
  if (!s) return;
  const keys = Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => !!k?.startsWith(PREFIX));
  for (const key of keys) {
    const uri = key.slice(PREFIX.length);
    const text = s.getItem(key);
    if (text != null && !memory!.has(uri)) store.set(uri, text);
    s.removeItem(key);
  }
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const store = {
  get(uri: string): Entry | null {
    if (memory) return memory.get(uri) ?? null;
    const text = storage()?.getItem(PREFIX + uri);
    return text == null ? null : { text, size: text.length };
  },
  set(uri: string, text: string) {
    if (memory) {
      memory.set(uri, { text, size: new TextEncoder().encode(text).length });
      persist('fs_write', { uri, text });
    } else {
      storage()?.setItem(PREFIX + uri, text);
    }
  },
  remove(uri: string) {
    if (memory) {
      memory.delete(uri);
      persist('fs_delete', { uri });
    } else {
      storage()?.removeItem(PREFIX + uri);
    }
  },
  /** Archivos dentro de una carpeta (y sus subcarpetas). */
  under(dir: string): string[] {
    const prefix = dir + '/';
    if (memory) return [...memory.keys()].filter((k) => k.startsWith(prefix));
    const s = storage();
    if (!s) return [];
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX + prefix)) keys.push(key.slice(PREFIX.length));
    }
    return keys;
  },
};

function join(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .filter(Boolean)
    .join('/');
}

type Parent = string | Directory;
const pathOf = (parent: Parent) => (typeof parent === 'string' ? parent : parent.uri);

export class File {
  readonly uri: string;

  constructor(parent: Parent, ...names: string[]) {
    this.uri = join(pathOf(parent), ...names);
  }

  get name(): string {
    return this.uri.split('/').pop() ?? '';
  }

  get exists(): boolean {
    return store.get(this.uri) != null;
  }

  get size(): number {
    return store.get(this.uri)?.size ?? 0;
  }

  textSync(): string {
    const entry = store.get(this.uri);
    if (entry == null) throw new Error(`No existe ${this.uri}`);
    if (entry.text == null) throw notAvailable(`Leer ${this.name}`);
    return entry.text;
  }

  async text(): Promise<string> {
    return this.textSync();
  }

  write(content: string): void {
    store.set(this.uri, content);
  }

  create(): void {
    if (!this.exists) this.write('');
  }

  delete(): void {
    store.remove(this.uri);
  }

  createUploadTask(): never {
    throw notAvailable('Subir archivos');
  }

  /**
   * En PC lo descarga Rust (fs_download), con progreso y cancelación por `signal`. El archivo queda en la carpeta
   * de la app y su `uri` es la URL con la que lo reproducen el reproductor y las imágenes.
   */
  static async downloadFileAsync(
    url: string,
    destination: File | Directory,
    options: { signal?: AbortSignal; onProgress?: (p: { bytesWritten: number; totalBytes: number }) => void } = {},
  ): Promise<File> {
    if (!memory) throw notAvailable('Descargar archivos');
    const dest = destination instanceof File ? destination : new File(destination, url.split('/').pop()?.split('?')[0] || 'descarga');
    const onProgress = new Channel<{ done: number; total: number }>();
    onProgress.onmessage = (p) => options.onProgress?.({ bytesWritten: p.done, totalBytes: p.total });
    const cancel = () => void invoke('fs_cancel', { key: dest.uri }).catch(() => {});
    options.signal?.addEventListener('abort', cancel);
    try {
      if (options.signal?.aborted) throw new Error('Descarga cancelada');
      const size = await invoke<number>('fs_download', { url, uri: dest.uri, onProgress });
      memory.set(dest.uri, { text: null, size });
      return dest;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}

export class Directory {
  readonly uri: string;

  constructor(parent: Parent, ...names: string[]) {
    this.uri = join(pathOf(parent), ...names);
  }

  get name(): string {
    return this.uri.split('/').pop() ?? '';
  }

  get exists(): boolean {
    return dirs.has(this.uri) || store.under(this.uri).length > 0;
  }

  create(): void {
    if (dirs.has(this.uri)) return;
    dirs.add(this.uri);
    if (memory) persist('fs_mkdir', { uri: this.uri });
  }

  delete(): void {
    if (memory) {
      for (const uri of store.under(this.uri)) memory.delete(uri);
      persist('fs_rmdir', { uri: this.uri });
    } else {
      for (const uri of store.under(this.uri)) store.remove(uri);
    }
    for (const d of [...dirs]) if (d === this.uri || d.startsWith(this.uri + '/')) dirs.delete(d);
  }

  /** Solo los archivos que están directamente en la carpeta. */
  list(): File[] {
    const prefix = this.uri + '/';
    return store
      .under(this.uri)
      .filter((uri) => !uri.slice(prefix.length).includes('/'))
      .map((uri) => new File(uri));
  }
}

/**
 * En la ventana de Tauri, las rutas son las URL del protocolo propio de la app (desktop/src-tauri/src/files.rs):
 * la misma uri sirve para leer el archivo y para dársela al reproductor o a una imagen.
 */
const ROOT = isTauri() ? 'http://impala.localhost' : 'impala:/';

export const Paths = {
  document: new Directory(`${ROOT}/document`),
  cache: new Directory(`${ROOT}/cache`),
  /** Desconocido en PC por ahora. */
  availableDiskSpace: 0,
};

export enum UploadType {
  BINARY_CONTENT = 0,
  MULTIPART = 1,
}
