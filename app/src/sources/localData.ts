import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

/**
 * Lo que la fuente «Este dispositivo» guarda por su cuenta (Android solo sabe de archivos): playlists,
 * favoritas, escuchas y las carpetas elegidas. Un JSON en los documentos de la app, como song-sorts.json.
 * Las canciones se identifican por su id del índice de Android.
 */

export type LocalPlaylist = { id: string; name: string; songIds: string[]; created: string; changed: string };

type LocalData = {
  /** Rutas relativas a la raíz del almacenamiento, con barra final ("Music/Impala/"); incluyen subcarpetas. */
  folders: string[];
  playlists: LocalPlaylist[];
  /** id de canción → fecha ISO en que se marcó. */
  favorites: Record<string, string>;
  /** Escuchas completas, para «Recientes» y «Más escuchadas». */
  plays: Record<string, { count: number; last: string }>;
};

/** En el PC la música suele estar en toda la carpeta Música (Music/Impala, la de las descargas, queda dentro). */
export const DEFAULT_FOLDER = Platform.OS === 'web' ? 'Music/' : 'Music/Impala/';
/** Donde se guardan las descargas de YouTube (en el PC, dentro de Música pero en su propia carpeta). */
export const DOWNLOAD_FOLDER = 'Music/Impala/';

const FILE = new File(Paths.document, 'local-library.json');
let data: LocalData | null = null;
const listeners = new Set<() => void>();

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function localData(): LocalData {
  if (data) return data;
  data = { folders: [DEFAULT_FOLDER], playlists: [], favorites: {}, plays: {} };
  try {
    if (FILE.exists) {
      const parsed = JSON.parse(FILE.textSync()) as Partial<LocalData> | null;
      if (parsed && typeof parsed === 'object') {
        if (isStringArray(parsed.folders)) data.folders = parsed.folders;
        // En PC, antes de la Fase 5 se guardaba la carpeta por defecto del teléfono sin que nadie la eligiera.
        if (Platform.OS === 'web' && data.folders.length === 1 && data.folders[0] === 'Music/Impala/') data.folders = [DEFAULT_FOLDER];
        if (Array.isArray(parsed.playlists)) {
          data.playlists = parsed.playlists.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && isStringArray(p.songIds));
        }
        if (parsed.favorites && typeof parsed.favorites === 'object') data.favorites = parsed.favorites;
        if (parsed.plays && typeof parsed.plays === 'object') data.plays = parsed.plays;
      }
    }
  } catch {
    // Archivo dañado: se empieza de cero antes que bloquear la app.
  }
  return data;
}

/** Aplica un cambio y lo guarda en el teléfono. */
export function updateLocalData(change: (current: LocalData) => Partial<LocalData>) {
  const current = localData();
  data = { ...current, ...change(current) };
  listeners.forEach((l) => l());
  try {
    FILE.write(JSON.stringify(data));
  } catch (e) {
    console.warn('No se pudo guardar la biblioteca local', e);
  }
}

/** Las carpetas elegidas (para Ajustes). */
export function useLocalFolders(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => localData().folders,
  );
}

export const newPlaylistId = () => `pl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
