import { useSyncExternalStore } from 'react';
import { getVolume, setVolume } from '../../../modules/impala-player/web/engine';
import { addListener } from '../../../modules/impala-player/web/events';

/** Volumen de la app de PC (0 a 1). Solo existe en web: lo usan la barra de reproducción y los atajos. */
export function useVolume(): number {
  return useSyncExternalStore((l) => addListener('onVolumeChange', l).remove, getVolume);
}

let beforeMute = 1;

export function changeVolume(delta: number) {
  setVolume(Math.round((getVolume() + delta) * 100) / 100);
}

export function toggleMute() {
  const v = getVolume();
  if (v > 0) {
    beforeMute = v;
    setVolume(0);
  } else {
    setVolume(beforeMute || 1);
  }
}

export { setVolume };
