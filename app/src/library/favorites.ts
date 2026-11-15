import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { invalidatePlaylists, queryClient } from '@/api/queryClient';
import { sourceKey, useSource, type MusicSource, type Playlist, type Song } from '@/sources';

/**
 * Canciones favoritas (la estrella). La fuente de verdad son las favoritas de la fuente (en Navidrome,
 * las estrellas); la playlist "Canciones Favoritas" se mantiene como espejo (de la más reciente a la más
 * antigua) para que aparezca junto a las demás y en cualquier otro cliente.
 */
export const FAVORITES_PLAYLIST = 'Canciones Favoritas';

export const starredKey = (s: MusicSource) => sourceKey(s, 'starred');

const byNewest = (songs: Song[]) => [...songs].sort((a, b) => (b.starred ?? '').localeCompare(a.starred ?? ''));

export function useFavorites() {
  const source = useSource();
  return useQuery({ queryKey: starredKey(source), queryFn: async () => byNewest(await source.getFavorites()) });
}

export function useIsFavorite(id: string | undefined): boolean {
  const source = useSource();
  const { data } = useQuery({
    queryKey: starredKey(source),
    queryFn: async () => byNewest(await source.getFavorites()),
    select: (songs) => !!id && songs.some((s) => s.id === id),
  });
  return data ?? false;
}

export const isFavoritesPlaylist = (p: Pick<Playlist, 'name' | 'owner'>, source: MusicSource) =>
  p.name === FAVORITES_PLAYLIST && source.isOwnPlaylist(p);

export async function setFavorite(source: MusicSource, song: Song, favorite: boolean) {
  const key = starredKey(source);
  const previous = queryClient.getQueryData<Song[]>(key);
  // Optimista: la estrella cambia al instante.
  queryClient.setQueryData<Song[]>(key, (songs = []) =>
    favorite ? [{ ...song, starred: new Date().toISOString() }, ...songs.filter((s) => s.id !== song.id)] : songs.filter((s) => s.id !== song.id),
  );
  try {
    await source.setFavorite(song.id, favorite);
  } catch (e) {
    queryClient.setQueryData(key, previous);
    throw e;
  }
  await syncFavoritesPlaylist(source);
}

export const toggleFavorite = (source: MusicSource, song: Song) =>
  setFavorite(source, song, !queryClient.getQueryData<Song[]>(starredKey(source))?.some((s) => s.id === song.id));

let syncing: Promise<void> = Promise.resolve();

/** Crea la playlist si falta y la iguala a las estrellas. Las llamadas se encadenan, nunca en paralelo. */
export function syncFavoritesPlaylist(source: MusicSource): Promise<void> {
  syncing = syncing.catch(() => {}).then(() => doSync(source));
  return syncing;
}

async function doSync(source: MusicSource) {
  const starred = byNewest(await source.getFavorites());
  queryClient.setQueryData(starredKey(source), starred);
  const ids = starred.map((s) => s.id);

  const existing = (await source.getPlaylists()).find((p) => isFavoritesPlaylist(p, source));
  if (!existing) {
    await source.createPlaylist(FAVORITES_PLAYLIST, ids);
  } else {
    const current = (await source.getPlaylist(existing.id)).entry?.map((s) => s.id) ?? [];
    if (current.join() === ids.join()) return;
    // Subsonic: sustituir por una lista vacía no vacía una playlist existente; se quitan por posición.
    if (ids.length === 0) await source.removeFromPlaylist(existing.id, current.map((_, i) => i));
    else await source.setPlaylistSongs(existing.id, ids);
  }
  await invalidatePlaylists(source);
}

let ensured = false;

/**
 * Si las playlists ya cargaron y falta "Canciones Favoritas", la crea. Cubre el caso de que la
 * sincronización del arranque fallara (p. ej. Tailscale aún conectando).
 */
export function useEnsureFavoritesPlaylist(playlists: Playlist[] | undefined) {
  const source = useSource();
  useEffect(() => {
    if (ensured || !playlists || playlists.some((p) => isFavoritesPlaylist(p, source))) return;
    ensured = true;
    syncFavoritesPlaylist(source).catch((e) => {
      ensured = false;
      console.warn('No se pudo crear la playlist de favoritas', e);
    });
  }, [playlists, source]);
}
