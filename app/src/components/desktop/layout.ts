import { Platform, useWindowDimensions } from 'react-native';

/**
 * Diseño de escritorio (app de PC): a partir de este ancho, barra lateral a la izquierda y barra de
 * reproducción abajo en vez de pestañas y mini reproductor. En el teléfono nunca se activa.
 */
export const DESKTOP_MIN_WIDTH = 900;
export const SIDEBAR_WIDTH = 236;
export const PLAYER_BAR_HEIGHT = 88;

export function useDesktop(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= DESKTOP_MIN_WIDTH;
}

/**
 * Columnas de una cuadrícula de carátulas: 2 en el teléfono; en el PC, las que quepan con tiles de al menos
 * `minTile` px. Devuelve también el ancho de cada tile (todas iguales, aunque la última fila no esté llena).
 */
export function useGridColumns(minTile = 176, gap = 16, padding = 20) {
  const { width } = useWindowDimensions();
  const desktop = useDesktop();
  const content = (desktop ? width - SIDEBAR_WIDTH : width) - padding * 2;
  const columns = desktop ? Math.max(2, Math.floor((content + gap) / (minTile + gap))) : 2;
  const tileWidth = Math.floor((content - gap * (columns - 1)) / columns);
  return { columns, tileWidth, gap, padding };
}
