import { Platform } from 'react-native';

/**
 * Clic derecho en el PC: abre el mismo menú que el botón «…» (o la pulsación larga en el teléfono) y evita
 * el menú del navegador. React Native Web pasa `onContextMenu` al elemento, aunque los tipos no lo recojan.
 */
export function contextMenu(open?: () => void): object {
  if (Platform.OS !== 'web' || !open) return {};
  return {
    onContextMenu: (e: { preventDefault(): void; stopPropagation(): void }) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    },
  };
}
