import { File, Paths } from 'expo-file-system';
import type { GymSettings, PlaybackTuning } from '../index';

/**
 * Ajustes del reproductor en PC (en Android viven en SharedPreferences): un JSON en la carpeta de la app.
 * La API es síncrona, como la del módulo nativo.
 */
type Prefs = {
  crossfadeMs: number;
  boostDb: number;
  /** Volumen de la app (0 a 1): en PC el volumen gradual del gym sube este, no el de Windows. */
  volume: number;
  gym: GymSettings;
  tuningScope: string;
  tuningGlobal: PlaybackTuning | null;
  /** Por «fuente|canción»: los ids de canción solo son únicos dentro de una fuente. */
  tuningSongs: Record<string, PlaybackTuning>;
};

const DEFAULTS: Prefs = {
  crossfadeMs: 0,
  boostDb: 0,
  volume: 1,
  gym: { maxPercent: 85, minutes: 20 },
  tuningScope: '',
  tuningGlobal: null,
  tuningSongs: {},
};

const FILE = new File(Paths.document, 'reproductor.json');
let cache: Prefs | null = null;

export function prefs(): Prefs {
  if (!cache) {
    try {
      cache = { ...DEFAULTS, ...(FILE.exists ? JSON.parse(FILE.textSync()) : {}) };
    } catch {
      cache = { ...DEFAULTS };
    }
  }
  return cache!;
}

export function updatePrefs(patch: Partial<Prefs>) {
  cache = { ...prefs(), ...patch };
  FILE.write(JSON.stringify(cache));
}

// --- Velocidad y tono (como PlaybackTuning.kt) -------------------------------------------------

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const MAX_SEMITONES = 12;
const NEUTRAL: PlaybackTuning = { speed: 1, semitones: 0, vinyl: false, reverb: 0 };
/** Lo que reciben los ajustes viejos con la reverb encendida (antes era un sí/no). */
const DEFAULT_REVERB = 40;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function clampTuning(t: PlaybackTuning): PlaybackTuning {
  return {
    speed: clamp(Number(t.speed) || 1, MIN_SPEED, MAX_SPEED),
    semitones: clamp(Number(t.semitones) || 0, -MAX_SEMITONES, MAX_SEMITONES),
    vinyl: !!t.vinyl,
    reverb: typeof t.reverb === 'boolean' ? (t.reverb ? DEFAULT_REVERB : 0) : clamp(Math.round(Number(t.reverb) || 0), 0, 100),
  };
}

const songKey = (songId: string) => `${prefs().tuningScope}|${songId}`;

/** Los de la canción si tiene propios; si no, los globales. */
export function tuningFor(songId: string | null | undefined): PlaybackTuning & { perSong: boolean } {
  const own = songId ? prefs().tuningSongs[songKey(songId)] : undefined;
  return { ...clampTuning(own ?? prefs().tuningGlobal ?? NEUTRAL), perSong: !!own };
}

export function saveTuning(songId: string | null, tuning: PlaybackTuning) {
  const t = clampTuning(tuning);
  if (songId) updatePrefs({ tuningSongs: { ...prefs().tuningSongs, [songKey(songId)]: t } });
  else updatePrefs({ tuningGlobal: t });
}

export function clearSongTuning(songId: string) {
  const songs = { ...prefs().tuningSongs };
  delete songs[songKey(songId)];
  updatePrefs({ tuningSongs: songs });
}
