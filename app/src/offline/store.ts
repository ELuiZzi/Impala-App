import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import type { MusicSource, Song } from '@/sources';

/**
 * Descargas para escuchar sin conexión.
 *
 * Archivos en <documentos>/offline: el audio original (`source.downloadUrl`) y su carátula.
 * El índice es un JSON pequeño junto a ellos: guarda los metadatos para mostrar la biblioteca
 * descargada sin servidor. Un archivo solo cuenta como descargado cuando está en el índice; los
 * restos de descargas interrumpidas se borran al arrancar.
 */
export type OfflineSong = Song & { file: string; bytes: number; downloadedAt: number };

export type OfflineIndex = Index;
type Index = { version: 1; songs: Record<string, OfflineSong>; covers: Record<string, string> };

type OfflineState = {
  index: Index;
  /** Cola de descargas pendientes (incluye la activa en primera posición). */
  pending: Song[];
  active: { id: string; progress: number } | null;
  errors: Record<string, string>;
};

const ROOT = new Directory(Paths.document, 'offline');
const INDEX_FILE = new File(ROOT, 'index.json');
const emptyIndex = (): Index => ({ version: 1, songs: {}, covers: {} });

let state: OfflineState = { index: emptyIndex(), pending: [], active: null, errors: {} };
const listeners = new Set<() => void>();
const set = (patch: Partial<OfflineState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useOffline<T>(selector: (s: OfflineState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// --- Consultas síncronas (para el reproductor y la UI) ----------------------------------------

export const localSongUri = (id: string): string | undefined => state.index.songs[id]?.file;
export const localCoverUri = (coverArt?: string): string | undefined => (coverArt ? state.index.covers[coverArt] : undefined);
export const isDownloaded = (id: string) => id in state.index.songs;
export const isDownloading = (id: string) => state.pending.some((song) => song.id === id);

export type DownloadStatus = { kind: 'none' } | { kind: 'queued' } | { kind: 'downloading'; progress: number } | { kind: 'downloaded' };

export function downloadStatusOf(s: OfflineState, id: string): DownloadStatus['kind'] {
  if (id in s.index.songs) return 'downloaded';
  if (s.active?.id === id) return 'downloading';
  if (s.pending.some((p) => p.id === id)) return 'queued';
  return 'none';
}

export const offlineSongs = (index: Index): OfflineSong[] =>
  Object.values(index.songs).sort((a, b) => b.downloadedAt - a.downloadedAt);

export const totalBytes = (index: Index) => Object.values(index.songs).reduce((sum, song) => sum + song.bytes, 0);

// --- Persistencia ---------------------------------------------------------------------------

let loaded = false;

export function loadOffline() {
  if (loaded) return;
  loaded = true;
  try {
    ROOT.create({ intermediates: true, idempotent: true });
    const index: Index = INDEX_FILE.exists ? JSON.parse(INDEX_FILE.textSync()) : emptyIndex();

    // Quita entradas cuyo archivo desapareció y archivos que no están en el índice.
    for (const [id, song] of Object.entries(index.songs)) {
      if (!new File(song.file).exists) delete index.songs[id];
    }
    const referenced = new Set([INDEX_FILE.uri, ...Object.values(index.songs).map((s) => s.file), ...Object.values(index.covers)]);
    for (const entry of ROOT.list()) {
      if (entry instanceof File && !referenced.has(entry.uri)) entry.delete();
    }
    set({ index });
  } catch (e) {
    console.warn('No se pudo leer el índice de descargas', e);
    set({ index: emptyIndex() });
  }
}

function saveIndex(index: Index) {
  INDEX_FILE.write(JSON.stringify(index));
  set({ index });
}

const safeName = (id: string) => id.replace(/[^\w-]/g, '_');

// --- Descargas ------------------------------------------------------------------------------

let source: MusicSource | null = null;
let working = false;
/** Corta la descarga activa (Cancelar). */
let abort: AbortController | null = null;

/** Encola canciones para descargar (ignora las ya descargadas o en cola). */
export function downloadSongs(s: MusicSource, songs: Song[]) {
  source = s;
  const known = new Set([...Object.keys(state.index.songs), ...state.pending.map((p) => p.id)]);
  const fresh = songs.filter((song) => !known.has(song.id));
  if (fresh.length === 0) return;
  const errors = { ...state.errors };
  fresh.forEach((song) => delete errors[song.id]);
  set({ pending: [...state.pending, ...fresh], errors });
  if (!working) void work();
}

async function work() {
  working = true;
  while (state.pending.length > 0 && source) {
    const song = state.pending[0];
    set({ active: { id: song.id, progress: 0 } });
    abort = new AbortController();
    const signal = abort.signal;
    try {
      await downloadOne(source, song, signal);
    } catch (e) {
      if (!signal.aborted) set({ errors: { ...state.errors, [song.id]: e instanceof Error ? e.message : 'Error de descarga' } });
    }
    abort = null;
    // Si se canceló, la canción ya no está en la cola (cancelDownloads la quitó).
    set({ pending: state.pending[0]?.id === song.id ? state.pending.slice(1) : state.pending, active: null });
  }
  working = false;
}

async function downloadOne(s: MusicSource, song: Song, signal: AbortSignal) {
  const ext = song.suffix?.toLowerCase() || 'audio';
  const dest = new File(ROOT, `${safeName(song.id)}.${ext}`);
  try {
    await File.downloadFileAsync(s.downloadUrl(song.id), dest, {
      idempotent: true,
      signal,
    onProgress: ({ bytesWritten, totalBytes: total }) =>
        set({ active: { id: song.id, progress: total > 0 ? bytesWritten / total : 0 } }),
    });
  } catch (e) {
    // En Android puede quedar un archivo a medias.
    deleteQuietly(dest.uri);
    throw e;
  }

  const index: Index = { ...state.index, songs: { ...state.index.songs }, covers: { ...state.index.covers } };
  if (song.coverArt && !index.covers[song.coverArt]) {
    try {
      const cover = await File.downloadFileAsync(s.coverUrl(song.coverArt, 600)!, new File(ROOT, `cover-${safeName(song.coverArt)}.jpg`), {
        idempotent: true,
      });
      index.covers[song.coverArt] = cover.uri;
    } catch {
      // Sin carátula offline: se mostrará el ícono por defecto.
    }
  }
  index.songs[song.id] = { ...song, file: dest.uri, bytes: dest.size ?? 0, downloadedAt: Date.now() };
  saveIndex(index);
}

/** Cancela descargas en curso o en cola: las indicadas o, sin ids, todas. */
export function cancelDownloads(ids?: string[]) {
  const cancel = (id: string) => !ids || ids.includes(id);
  const activeId = state.active?.id;
  set({ pending: state.pending.filter((song) => !cancel(song.id)) });
  if (activeId && cancel(activeId)) abort?.abort();
}

export function removeDownload(id: string) {
  const song = state.index.songs[id];
  if (!song) return;
  const index: Index = { ...state.index, songs: { ...state.index.songs }, covers: { ...state.index.covers } };
  delete index.songs[id];
  deleteQuietly(song.file);
  // La carátula se conserva mientras otra canción descargada la use.
  if (song.coverArt && !Object.values(index.songs).some((s) => s.coverArt === song.coverArt)) {
    deleteQuietly(index.covers[song.coverArt]);
    delete index.covers[song.coverArt];
  }
  saveIndex(index);
}

export function removeAllDownloads() {
  set({ pending: [] });
  for (const song of Object.values(state.index.songs)) deleteQuietly(song.file);
  for (const cover of Object.values(state.index.covers)) deleteQuietly(cover);
  saveIndex(emptyIndex());
}

function deleteQuietly(uri?: string) {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Ya no existe.
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
