import { useCSSVariable } from 'uniwind';

export type ThemeColor = 'background' | 'card' | 'foreground' | 'muted' | 'separator' | 'accent' | 'accent-foreground';

/** Valor de un color del tema (global.css) para props que no aceptan className, como íconos o la barra de pestañas. */
export function useThemeColor(name: ThemeColor): string {
  return String(useCSSVariable(`--color-${name}`) ?? '#888888');
}

/** Navidrome rellena los tags vacíos con estos marcadores en inglés. */
const UNKNOWN_ARTIST = '[Unknown Artist]';
const UNKNOWN_ALBUM = '[Unknown Album]';

export function artistName(name?: string): string {
  return !name || name === UNKNOWN_ARTIST ? 'Artista desconocido' : name;
}

/** null si el álbum es el marcador de "sin álbum", para poder ocultarlo. */
export function albumName(name?: string): string | null {
  return !name || name === UNKNOWN_ALBUM ? null : name;
}

/** "1 canción", "3 canciones" */
export function songCount(n: number): string {
  return `${n} ${n === 1 ? 'canción' : 'canciones'}`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatTotalDuration(seconds?: number): string {
  if (!seconds) return '';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
