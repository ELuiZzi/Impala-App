import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';

/**
 * Cómo se maneja el reproductor a pantalla completa: con gestos (deslizar para cambiar de canción,
 * tocar para pausar, doble toque para favorita) o con los botones de siempre. Gestos por defecto;
 * en Ajustes se vuelve a los botones.
 */
export type PlayerControls = 'gestos' | 'botones';

const KEY = 'impala.playerControls';
const HINT_KEY = 'impala.gestureHintSeen';
let cached: PlayerControls | null = null;
let hintSeen: boolean | null = null;
const listeners = new Set<(c: PlayerControls) => void>();

async function load(): Promise<PlayerControls> {
  if (cached) return cached;
  const stored = await SecureStore.getItemAsync(KEY).catch(() => null);
  cached = stored === 'botones' ? 'botones' : 'gestos';
  return cached;
}
// Se lee al arrancar para que el reproductor abra ya en el modo guardado, sin parpadeo.
void load();

export async function setPlayerControls(c: PlayerControls) {
  cached = c;
  listeners.forEach((l) => l(c));
  await SecureStore.setItemAsync(KEY, c).catch(() => {});
}

export function usePlayerControls(): PlayerControls {
  const [c, setC] = useState<PlayerControls>(cached ?? 'gestos');
  useEffect(() => {
    load().then(setC);
    listeners.add(setC);
    return () => void listeners.delete(setC);
  }, []);
  return c;
}

/** La explicación de los gestos se muestra una sola vez. */
export async function shouldShowGestureHint(): Promise<boolean> {
  if (hintSeen === null) hintSeen = (await SecureStore.getItemAsync(HINT_KEY).catch(() => null)) === '1';
  return !hintSeen;
}

export async function markGestureHintSeen() {
  hintSeen = true;
  await SecureStore.setItemAsync(HINT_KEY, '1').catch(() => {});
}
