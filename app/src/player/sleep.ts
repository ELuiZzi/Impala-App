import { useEffect, useState, useSyncExternalStore } from 'react';
import ImpalaPlayer, { type SleepTimerEvent } from '../../modules/impala-player';

/**
 * Temporizador de reposo. Lo lleva el código nativo (junto al servicio de reproducción), así que
 * sigue contando con la app minimizada o tras recargar el JS; aquí solo se refleja su estado.
 */
export const SLEEP_OPTIONS = [
  { label: '5 minutos', minutes: 5 },
  { label: '15 minutos', minutes: 15 },
  { label: '30 minutos', minutes: 30 },
  { label: '45 minutos', minutes: 45 },
  { label: '1 hora', minutes: 60 },
] as const;

let state: SleepTimerEvent = { endsAt: null, endOfTrack: false };
let loaded = false;
const listeners = new Set<() => void>();

function set(next: SleepTimerEvent) {
  state = next;
  listeners.forEach((l) => l());
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    state = ImpalaPlayer.getSleepTimer();
  } catch {
    // Módulo nativo antiguo (build sin el temporizador): se queda desactivado.
  }
  ImpalaPlayer.addListener('onSleepTimer', set);
}

export function useSleepTimer(): SleepTimerEvent {
  ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
}

export function getSleepTimer(): SleepTimerEvent {
  ensureLoaded();
  return state;
}

export const isSleepTimerActive =(s: SleepTimerEvent) => s.endOfTrack || s.endsAt !== null;

export const startSleepTimer = (minutes: number) => ImpalaPlayer.setSleepTimer(minutes * 60_000);
export const sleepAtEndOfTrack = () => ImpalaPlayer.setSleepTimer(-1);
export const cancelSleepTimer = () => ImpalaPlayer.setSleepTimer(0);

/** Tiempo restante formateado ("12:05", "1:02:30"), actualizado cada segundo. */
export function useSleepRemaining(endsAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  if (endsAt === null) return null;
  const total = Math.max(0, Math.round((endsAt - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
