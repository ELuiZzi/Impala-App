import { useSyncExternalStore } from 'react';
import ImpalaPlayer, { type PlaybackTuning } from '../../modules/impala-player';

/**
 * Velocidad y tono ("sped up" / "slowed"), aplicados por el reproductor nativo (Sonic de ExoPlayer) al
 * principal y al fader del crossfade. Natural: cambia la velocidad sin tocar el tono. Vinilo: el tono sigue
 * a la velocidad, como un disco a otras revoluciones (el sonido típico de los edits «sped up»).
 */
export type { PlaybackTuning };

export const SPEED_MIN = 0.75;
export const SPEED_MAX = 1.35;
export const SPEED_STEP = 0.05;
export const SEMITONES_MAX = 6;

export type TuningPreset = { id: 'normal' | 'spedup' | 'slowed' | 'slowedreverb'; label: string; speed: number; reverb: boolean };

export const TUNING_PRESETS: TuningPreset[] = [
  { id: 'normal', label: 'Normal', speed: 1, reverb: false },
  { id: 'spedup', label: 'Sped up', speed: 1.25, reverb: false },
  { id: 'slowed', label: 'Slowed', speed: 0.85, reverb: false },
  { id: 'slowedreverb', label: 'Slowed + reverb', speed: 0.85, reverb: true },
];

export const NORMAL: PlaybackTuning = { speed: 1, semitones: 0, vinyl: false, reverb: false };

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

export const isNormal = (t: PlaybackTuning) => near(t.speed, 1) && near(t.semitones, 0) && !t.reverb;

/** El preajuste que coincide (el modo de tono, natural o vinilo, no cuenta); null = personalizado. */
export function presetOf(t: PlaybackTuning): TuningPreset | null {
  if (isNormal(t)) return TUNING_PRESETS[0];
  if (!near(t.semitones, 0)) return null;
  return TUNING_PRESETS.find((p) => p.id !== 'normal' && near(p.speed, t.speed) && p.reverb === t.reverb) ?? null;
}

const formatSpeed = (speed: number) => `${String(Math.round(speed * 100) / 100).replace('.', ',')}×`;
const formatSemitones = (st: number) => `${st > 0 ? '+' : st < 0 ? '−' : '±'}${Math.abs(Math.round(st))} st`;
export { formatSemitones, formatSpeed };

/** "Normal", "Sped up 1,25×", "Personalizado 1,1× · +2 st"… para el menú y el indicador. */
export function tuningLabel(t: PlaybackTuning): string {
  if (isNormal(t)) return 'Normal';
  const preset = presetOf(t);
  const speed = formatSpeed(t.speed);
  if (preset) return `${preset.label} ${speed}`;
  return ['Personalizado', near(t.speed, 1) ? null : speed, near(t.semitones, 0) ? null : formatSemitones(t.semitones), t.reverb ? 'reverb' : null]
    .filter(Boolean)
    .join(' · ')
    .replace('Personalizado · ', 'Personalizado ');
}

// --- Estado (lectura síncrona del módulo nativo, con caché para useSyncExternalStore) ----------

let version = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, { version: number; value: PlaybackTuning & { perSong: boolean } }>();

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

export function getTuning(songId: string | null): PlaybackTuning & { perSong: boolean } {
  const key = songId ?? '';
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.value;
  const value = ImpalaPlayer.getPlaybackTuning(songId);
  cache.set(key, { version, value });
  return value;
}

/** Ajustes que se oyen con `songId` (los suyos si los tiene, si no los globales). */
export function useTuning(songId: string | null) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => getTuning(songId),
  );
}

/** Se aplica al momento. perSong: solo para `songId`; si no, como ajuste global (y la canción deja los suyos). */
export function setTuning(songId: string, t: PlaybackTuning, perSong: boolean) {
  const speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(t.speed * 100) / 100));
  const semitones = Math.min(SEMITONES_MAX, Math.max(-SEMITONES_MAX, Math.round(t.semitones)));
  if (perSong) {
    ImpalaPlayer.setPlaybackTuning(songId, speed, semitones, t.vinyl, t.reverb);
  } else {
    ImpalaPlayer.clearSongTuning(songId);
    ImpalaPlayer.setPlaybackTuning(null, speed, semitones, t.vinyl, t.reverb);
  }
  notify();
}
