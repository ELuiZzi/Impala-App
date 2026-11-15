import { useEffect, useState, type RefObject } from 'react';
import { Platform, type GestureResponderEvent, type View } from 'react-native';

/**
 * Dónde está (o estuvo por última vez) el dedo, para que en las listas solo se muevan los textos largos de la fila
 * que se toca y de sus vecinas (ver Marquee). La raíz de la app (_layout) avisa al empezar y al mover un toque;
 * cuando la lista empieza a desplazarse Android deja de mandar movimientos, pero las filas que estaban bajo el dedo
 * se mueven con él, así que la ventana lo sigue. Al soltar, esas filas siguen animándose hasta el siguiente toque.
 * En el PC hace lo mismo el puntero del ratón.
 */
type Listener = (pageY: number) => void;
const listeners = new Set<Listener>();
let lastY: number | null = null;
/** Movimientos más pequeños que esto no vuelven a medir las filas. */
const MOVE_STEP = 24;

function setFocus(pageY: number, force: boolean) {
  if (!force && lastY !== null && Math.abs(pageY - lastY) < MOVE_STEP) return;
  lastY = pageY;
  listeners.forEach((l) => l(pageY));
}

/** Para `onTouchStartCapture` / `onTouchMoveCapture` de la vista raíz. */
export const touchFocusHandlers = {
  onTouchStartCapture: (e: GestureResponderEvent) => setFocus(e.nativeEvent.pageY, true),
  onTouchMoveCapture: (e: GestureResponderEvent) => setFocus(e.nativeEvent.pageY, false),
};

if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.addEventListener('pointermove', (e) => setFocus(e.pageY, false), { passive: true });
  document.addEventListener('pointerdown', (e) => setFocus(e.pageY, true), { passive: true });
}

/**
 * true mientras la vista está a menos de fila y media del último toque (la fila tocada y la de arriba y la de
 * abajo, con filas de `rowHeight`). Solo mide cuando hay un toque nuevo y `enabled` (textos que no caben).
 */
export function useNearTouch(ref: RefObject<View | null>, enabled: boolean, rowHeight: number): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const listener: Listener = (y) => {
      ref.current?.measure((_x, _y, _w, height, _pageX, pageY) => {
        if (height > 0) setNear(Math.abs(pageY + height / 2 - y) <= rowHeight * 1.5);
      });
    };
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, [enabled, rowHeight, ref]);
  return enabled && near;
}
