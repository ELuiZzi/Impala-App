import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

/**
 * Estilo elegido para la carátula genérica de cada playlist (índice en COVER_STYLES). Sin entrada,
 * el degradado sale del nombre. Se guarda en el teléfono.
 */
const FILE = new File(Paths.document, 'cover-styles.json');

let styles: Record<string, number> = {};
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (FILE.exists) {
      const parsed: unknown = JSON.parse(FILE.textSync());
      if (parsed && typeof parsed === 'object') styles = parsed as Record<string, number>;
    }
  } catch {
    // Archivo dañado: se vuelve a los degradados automáticos.
  }
}

export function useCoverStyle(playlistId: string | undefined): number | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => {
      load();
      return playlistId !== undefined && playlistId in styles ? styles[playlistId] : null;
    },
  );
}

export function getCoverStyle(playlistId: string): number | null {
  load();
  return playlistId in styles ? styles[playlistId] : null;
}

/** null vuelve al degradado automático. */
export function setCoverStyle(playlistId: string, style: number | null) {
  load();
  const next = { ...styles };
  if (style === null) delete next[playlistId];
  else next[playlistId] = style;
  styles = next;
  listeners.forEach((l) => l());
  try {
    FILE.write(JSON.stringify(next));
  } catch (e) {
    console.warn('No se pudo guardar el estilo de la portada', e);
  }
}
