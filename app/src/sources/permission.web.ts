import type { AudioPermission } from './permission';

export type { AudioPermission } from './permission';

/** En PC no hay permiso que pedir: la app lee las carpetas que elige el usuario. */
export async function checkAudioPermission(): Promise<AudioPermission> {
  return 'granted';
}

export async function requestAudioPermission(): Promise<AudioPermission> {
  return 'granted';
}

export function useAudioPermission(): AudioPermission {
  return 'granted';
}
