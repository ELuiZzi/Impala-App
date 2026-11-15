import { useSyncExternalStore } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Permiso para leer la música del teléfono: «Música y audio» en Android 13+ y el almacenamiento en 12 y
 * anteriores. 'prompt': aún no se ha pedido (o no en esta sesión); 'denied': lo acaba de negar; 'blocked': lo negó
 * para siempre y solo se puede dar desde los ajustes de Android.
 */
export type AudioPermission = 'unknown' | 'prompt' | 'granted' | 'denied' | 'blocked';

const PERMISSION =
  Platform.OS === 'android' && Platform.Version >= 33
    ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO
    : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;

let status: AudioPermission = 'unknown';
const listeners = new Set<() => void>();

function set(next: AudioPermission) {
  if (next === status) return;
  status = next;
  listeners.forEach((l) => l());
}

/** Comprueba sin preguntar (al arrancar y al volver a la app: pudo darlo desde los ajustes de Android). */
export async function checkAudioPermission(): Promise<AudioPermission> {
  const granted = await PermissionsAndroid.check(PERMISSION).catch(() => false);
  // check() no distingue «aún no se pidió» de «negado»: se conserva lo que respondió la última petición.
  set(granted ? 'granted' : status === 'unknown' || status === 'granted' ? 'prompt' : status);
  return status;
}

/** Muestra el diálogo del sistema (si Android aún deja preguntar). */
export async function requestAudioPermission(): Promise<AudioPermission> {
  const result = await PermissionsAndroid.request(PERMISSION).catch(() => PermissionsAndroid.RESULTS.DENIED);
  set(
    result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied',
  );
  return status;
}

export function useAudioPermission(): AudioPermission {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      if (status === 'unknown') void checkAudioPermission();
      return () => void listeners.delete(l);
    },
    () => status,
  );
}
