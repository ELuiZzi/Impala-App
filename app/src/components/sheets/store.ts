import type Ionicons from '@expo/vector-icons/Ionicons';
import { useSyncExternalStore } from 'react';
import type { Song } from '@/sources';
import type { SongSort, SortState } from '../SongFilter';

export type SheetOption = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void | Promise<void>;
};

/** Una sola hoja visible a la vez; Sheets.tsx la dibuja sobre toda la app. */
export type SheetState =
  | { kind: 'actions'; title: string; subtitle?: string; coverArt?: string; thumbnail?: string; options: SheetOption[] }
  | {
      kind: 'playlistPicker';
      songs: Song[];
      /** Canción que aún se está descargando (resultado de YouTube): se añade cuando esté en la biblioteca. */
      pending?: { title: string; resolve: () => Promise<Song[]> };
    }
  | {
      /** Orden de una lista: hoja flotante a media pantalla; los cambios se aplican al momento. */
      kind: 'sort';
      sorts: SongSort[];
      value: SortState;
      initial: SongSort;
      onChange: (value: SortState) => void;
    }
  | {
      /** Elegir el degradado de la carátula genérica de una playlist (null = automático). */
      kind: 'coverStyle';
      name: string;
      current: number | null;
      onSelect: (style: number | null) => void;
    }
  | {
      /** Velocidad y tono (sped up / slowed) de lo que suena; los cambios se aplican al momento. */
      kind: 'tuning';
      songId: string;
      title: string;
      coverArt?: string;
    }
  | {
      kind: 'prompt';
      title: string;
      placeholder?: string;
      initialValue?: string;
      confirmLabel: string;
      onSubmit: (text: string) => void | Promise<void>;
    };

let current: SheetState | null = null;
const listeners = new Set<() => void>();

function setSheet(sheet: SheetState | null) {
  current = sheet;
  listeners.forEach((l) => l());
}

export const showSheet = (sheet: SheetState) => setSheet(sheet);
export const closeSheet = () => setSheet(null);

export function useSheet(): SheetState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => current,
  );
}
