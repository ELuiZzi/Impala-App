/** En el teléfono el volumen es el de Android: esto solo existe en PC (volume.web.ts). */
export const useVolume = (): number => 1;
export const changeVolume = (_delta: number) => {};
export const toggleMute = () => {};
export const setVolume = (_volume: number) => {};
