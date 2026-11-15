import { File, Paths } from 'expo-file-system';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import type { Song } from '@/sources';
import { fold, matchesQuery, SearchField } from './SearchField';
import { showSheet } from './sheets/store';
import { albumName, artistName } from './theme';

export type SongSort = 'original' | 'title' | 'artist' | 'album' | 'recent' | 'duration';

export const SORT_LABELS: Record<SongSort, string> = {
  original: 'Orden de la playlist',
  title: 'Título',
  artist: 'Artista',
  album: 'Álbum',
  recent: 'Añadidas recientemente',
  duration: 'Duración',
};

/** Cómo se lee cada sentido: [ascendente, descendente]. */
export const DIRECTION_LABELS: Record<SongSort, [string, string]> = {
  original: ['Primera a última', 'Última a primera'],
  title: ['A → Z', 'Z → A'],
  artist: ['A → Z', 'Z → A'],
  album: ['A → Z', 'Z → A'],
  recent: ['Más recientes primero', 'Más antiguas primero'],
  duration: ['Más cortas primero', 'Más largas primero'],
};

export type SortState = { sort: SongSort; descending: boolean };

/** Canción con su posición en la lista original (las acciones de una playlist van por posición). */
export type IndexedSong = { song: Song; index: number };

const compare = (a: string | null | undefined, b: string | null | undefined) => fold(a).localeCompare(fold(b), 'es');

// El orden elegido en cada lista se guarda en el teléfono y se mantiene hasta que el usuario lo cambie.
const FILE = new File(Paths.document, 'song-sorts.json');
let remembered: Record<string, SortState> | null = null;

function loadSorts(): Record<string, SortState> {
  if (remembered) return remembered;
  remembered = {};
  try {
    if (FILE.exists) {
      const parsed: unknown = JSON.parse(FILE.textSync());
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
          if (value && typeof value.sort === 'string' && value.sort in SORT_LABELS) {
            remembered[key] = { sort: value.sort, descending: value.descending === true };
          }
        }
      }
    }
  } catch {
    // Archivo dañado: cada lista vuelve a su orden habitual.
  }
  return remembered;
}

function saveSort(key: string, state: SortState, initial: SongSort) {
  const next = { ...loadSorts() };
  // El orden habitual no se guarda: así una lista sin cambios no ocupa sitio.
  if (state.sort === initial && !state.descending) delete next[key];
  else next[key] = state;
  remembered = next;
  try {
    FILE.write(JSON.stringify(next));
  } catch (e) {
    console.warn('No se pudo guardar el orden de la lista', e);
  }
}

/** El orden guardado para la lista `key` (o el habitual si no hay ninguno o ya no se ofrece). */
export function savedSort(key: string, sorts: SongSort[], initial: SongSort): SortState {
  const stored = loadSorts()[key];
  return stored && sorts.includes(stored.sort) ? stored : { sort: initial, descending: false };
}

function sortIndexed(list: IndexedSong[], state: SortState): IndexedSong[] {
  const sorted = (() => {
    switch (state.sort) {
      case 'title':
        return list.sort((a, b) => compare(a.song.title, b.song.title));
      case 'artist':
        return list.sort((a, b) => compare(artistName(a.song.artist), artistName(b.song.artist)) || compare(a.song.album, b.song.album) || (a.song.track ?? 0) - (b.song.track ?? 0));
      case 'album':
        return list.sort((a, b) => compare(albumName(a.song.album), albumName(b.song.album)) || (a.song.track ?? 0) - (b.song.track ?? 0));
      case 'recent':
        return list.sort((a, b) => (b.song.created ?? '').localeCompare(a.song.created ?? ''));
      case 'duration':
        return list.sort((a, b) => (a.song.duration ?? 0) - (b.song.duration ?? 0));
      default:
        return list;
    }
  })();
  return state.descending ? sorted.reverse() : sorted;
}

/** Las canciones de una playlist en el orden que el usuario guardó para ella (al reproducirla sin abrirla). */
export function sortPlaylistSongs(playlistId: string, songs: Song[]): Song[] {
  const state = savedSort(`playlist:${playlistId}`, PLAYLIST_SORTS, 'original');
  return sortIndexed(songs.map((song, index) => ({ song, index })), state).map((i) => i.song);
}

/** Órdenes que ofrece una playlist. */
export const PLAYLIST_SORTS: SongSort[] = ['original', 'title', 'artist', 'album', 'recent', 'duration'];

/**
 * Búsqueda y orden para una lista de canciones (playlists, Canciones). Solo cambia lo que se ve y
 * el orden en que se reproduce; el orden guardado de la playlist no se toca. El orden se elige en
 * una hoja (openSortSheet), desde el menú … de la lista.
 */
export function useSongFilter(songs: Song[], { key, sorts, initial }: { key: string; sorts: SongSort[]; initial: SongSort }) {
  const [query, setQuery] = useState('');
  const [state, setStateRaw] = useState<SortState>(() => savedSort(key, sorts, initial));
  const setSort = (next: SortState) => {
    saveSort(key, next, initial);
    setStateRaw(next);
  };

  const items = useMemo(() => {
    const list = songs.map((song, index) => ({ song, index })).filter(({ song }) => matchesQuery(query, song.title, song.artist, song.album));
    return sortIndexed(list, state);
  }, [songs, query, state]);

  const isDefault = state.sort === initial && !state.descending;
  return { items, query, setQuery, sort: state, setSort, sorts, initial, isDefault, filtering: query.trim().length > 0 || !isDefault };
}

export type SongFilter = ReturnType<typeof useSongFilter>;

/** Hoja flotante para elegir el orden (y el sentido) de la lista. */
export function openSortSheet(filter: SongFilter) {
  showSheet({ kind: 'sort', sorts: filter.sorts, value: filter.sort, onChange: filter.setSort, initial: filter.initial });
}

/**
 * Campo de búsqueda de la cabecera de la lista. El orden elegido no se anuncia aquí: se ve y se
 * cambia en la hoja de orden (menú … de la lista).
 */
export function SongFilterBar({ filter, placeholder = 'Buscar en la lista' }: { filter: SongFilter; placeholder?: string }) {
  return (
    <View className="pb-3">
      <SearchField value={filter.query} onChangeText={filter.setQuery} placeholder={placeholder} />
    </View>
  );
}
