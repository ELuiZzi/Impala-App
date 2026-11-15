import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { sourceKey, useSource, type AlbumListType } from '@/sources';

const PAGE_SIZE = 100;

/** Las claves empiezan por las de la fuente (servidor y usuario) para no mezclar cachés entre cuentas. */
function useKey(...parts: (string | number)[]) {
  const source = useSource();
  return { source, key: sourceKey(source, ...parts) };
}

export function useServerInfo() {
  const { source, key } = useKey('ping');
  return useQuery({ queryKey: key, queryFn: () => source.info() });
}

export function useArtists() {
  const { source, key } = useKey('artists');
  return useQuery({ queryKey: key, queryFn: () => source.getArtists() });
}

export function useArtist(id: string, enabled = true) {
  const { source, key } = useKey('artist', id);
  return useQuery({ queryKey: key, queryFn: () => source.getArtist(id), enabled });
}

export function useAlbum(id: string) {
  const { source, key } = useKey('album', id);
  return useQuery({ queryKey: key, queryFn: () => source.getAlbum(id) });
}

export function useAlbumList(type: AlbumListType, size = 20) {
  const { source, key } = useKey('albumList', type, size);
  return useQuery({ queryKey: key, queryFn: () => source.getAlbumList(type, size) });
}

/**
 * Canciones de un artista en la biblioteca (Subsonic no tiene un endpoint para esto: se buscan por su
 * nombre y se quedan las suyas, también colaboraciones donde aparece).
 */
export function useArtistSongs(name: string | undefined, artistId: string | undefined) {
  const { source, key } = useKey('artistSongs', artistId ?? '', name ?? '');
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const { songs } = await source.search(name!, { songCount: 500, albumCount: 0, artistCount: 0 });
      const n = name!.toLowerCase();
      return songs.filter((s) => (artistId && s.artistId === artistId) || (s.artist ?? '').toLowerCase().includes(n));
    },
    enabled: !!name,
  });
}

/** El artista de la biblioteca con ese nombre (sin distinguir mayúsculas), para enlazar uno de YouTube. */
export function useLibraryArtistByName(name: string | undefined) {
  const { source, key } = useKey('artistByName', name ?? '');
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const { artists } = await source.search(name!, { songCount: 0, albumCount: 0, artistCount: 10 });
      return artists.find((a) => a.name.toLowerCase() === name!.toLowerCase()) ?? null;
    },
    enabled: !!name,
  });
}

export function useAllAlbums() {
  const { source, key } = useKey('albums', 'all');
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => source.getAlbumList('alphabeticalByName', PAGE_SIZE, pageParam),
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
  });
}

export function useAllSongs() {
  const { source, key } = useKey('songs', 'all');
  return useInfiniteQuery({
    queryKey: key,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await source.search('', { songCount: PAGE_SIZE, songOffset: pageParam, albumCount: 0, artistCount: 0 })).songs,
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
  });
}

export function useSearch(text: string) {
  const { source, key } = useKey('search', text);
  return useQuery({
    queryKey: key,
    queryFn: () => source.search(text, { songCount: 30, albumCount: 12, artistCount: 8 }),
    enabled: text.trim().length > 0,
    placeholderData: (previous) => previous,
  });
}

export function usePlaylists() {
  const { source, key } = useKey('playlists');
  return useQuery({ queryKey: key, queryFn: () => source.getPlaylists() });
}

export function usePlaylist(id: string) {
  const { source, key } = useKey('playlist', id);
  return useQuery({ queryKey: key, queryFn: () => source.getPlaylist(id) });
}
