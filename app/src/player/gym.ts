import { useSyncExternalStore } from 'react';
import ImpalaPlayer, { type GymRampEvent, type GymSettings } from '../../modules/impala-player';

/**
 * Volumen gradual para sesiones de gym. Lo lleva el código nativo junto al servicio de reproducción
 * (sigue subiendo con la app minimizada); aquí solo se refleja su estado.
 */
export const GYM_MAX_OPTIONS = [60, 70, 80, 85, 90, 100] as const;
export const GYM_MINUTES_OPTIONS = [5, 10, 15, 20, 30, 45] as const;

const idle: GymRampEvent = { active: false, lastEnd: null, progress: 0, startPercent: 0, targetPercent: 0, currentPercent: 0, remainingMs: 0 };
let state: GymRampEvent = idle;
let loaded = false;
const listeners = new Set<() => void>();

function set(next: GymRampEvent) {
  state = next;
  listeners.forEach((l) => l());
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    state = ImpalaPlayer.getGymRamp();
  } catch {
    // Módulo nativo antiguo (build sin volumen gradual).
  }
  ImpalaPlayer.addListener('onGymRamp', set);
}

export function useGymRamp(): GymRampEvent {
  ensureLoaded();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
}

export function getGymRamp(): GymRampEvent {
  ensureLoaded();
  return state;
}

export const startGymRamp = () => ImpalaPlayer.startGymRamp();
export const stopGymRamp = () => ImpalaPlayer.stopGymRamp();

export function getGymSettings(): GymSettings {
  try {
    return ImpalaPlayer.getGymSettings();
  } catch {
    return { maxPercent: 85, minutes: 20 };
  }
}

export const setGymSettings = (s: GymSettings) => ImpalaPlayer.setGymSettings(s.maxPercent, s.minutes);

/** "Volumen gradual: 45 % → 85 % · faltan 12 min" */
export function describeGymRamp(s: GymRampEvent): string {
  const minutes = Math.max(1, Math.ceil(s.remainingMs / 60_000));
  return `${s.currentPercent} % → ${s.targetPercent} % · faltan ${minutes} min de música`;
}
