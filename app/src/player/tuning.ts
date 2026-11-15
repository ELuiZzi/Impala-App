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
/** Reverberación en %: 0 = apagada. */
export const REVERB_MAX = 100;
export const REVERB_STEP = 10;
/** La de «Slowed + reverb»: presente pero sin tapar la canción. */
export const REVERB_DEFAULT = 40;

export type TuningPreset = { id: 'normal' | 'spedup' | 'slowed' | 'slowedreverb'; label: string; speed: number; reverb: number };

export const TUNING_PRESETS: TuningPreset[] = [
  { id: 'normal', label: 'Normal', speed: 1, reverb: 0 },
  { id: 'spedup', label: 'Sped up', speed: 1.25, reverb: 0 },
  { id: 'slowed', label: 'Slowed', speed: 0.85, reverb: 0 },
  { id: 'slowedreverb', label: 'Slowed + reverb', speed: 0.85, reverb: REVERB_DEFAULT },
];

export const NORMAL: PlaybackTuning = { speed: 1, semitones: 0, vinyl: false, reverb: 0 };

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

export const isNormal = (t: PlaybackTuning) => near(t.speed, 1) && near(t.semitones, 0) && t.reverb <= 0;

/** El preajuste que coincide (el modo de tono, natural o vinilo, no cuenta); null = personalizado. */
export function presetOf(t: PlaybackTuning): TuningPreset | null {
  if (isNormal(t)) return TUNING_PRESETS[0];
  if (!near(t.semitones, 0)) return null;
  return TUNING_PRESETS.find((p) => p.id !== 'normal' && near(p.speed, t.speed) && near(p.reverb, t.reverb)) ?? null;
}

const formatSpeed = (speed: number) => `${String(Math.round(speed * 100) / 100).replace('.', ',')}×`;
const formatSemitones = (st: number) => `${st > 0 ? '+' : st < 0 ? '−' : '±'}${Math.abs(Math.round(st))} st`;
const formatReverb = (r: number) => (r <= 0 ? 'Apagada' : `${Math.round(r)} %`);
export { formatReverb, formatSemitones, formatSpeed };

/** "Normal", "Sped up 1,25×", "Personalizado 1,1× · +2 st · reverb 60 %"… para el menú y el indicador. */
export function tuningLabel(t: PlaybackTuning): string {
  if (isNormal(t)) return 'Normal';
  const preset = presetOf(t);
  const speed = formatSpeed(t.speed);
  if (preset) return `${preset.label} ${speed}${preset.reverb > 0 ? ` · ${formatReverb(preset.reverb)}` : ''}`;
  return ['Personalizado', near(t.speed, 1) ? null : speed, near(t.semitones, 0) ? null : formatSemitones(t.semitones), t.reverb > 0 ? `reverb ${formatReverb(t.reverb)}` : null]
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
  const reverb = Math.min(REVERB_MAX, Math.max(0, Math.round(t.reverb)));
  if (perSong) {
    ImpalaPlayer.setPlaybackTuning(songId, speed, semitones, t.vinyl, reverb);
  } else {
    ImpalaPlayer.clearSongTuning(songId);
    ImpalaPlayer.setPlaybackTuning(null, speed, semitones, t.vinyl, reverb);
  }
  notify();
}
