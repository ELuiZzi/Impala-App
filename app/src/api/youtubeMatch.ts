import type { MusicSource, Song } from '@/sources';
import type { YoutubeResult } from './ytmusic';

/** "Beyoncé — HALO!" → "beyonce halo" */
export const fold = (text: string | null | undefined) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** La misma canción ya en la biblioteca: mismo título y algún artista en común (y duración parecida). */
export async function findInLibrary(source: MusicSource, result: Pick<YoutubeResult, 'title' | 'artist' | 'durationSec'>): Promise<Song | null> {
  const title = fold(result.title);
  if (!title) return null;
  const artists = fold(result.artist).split(' ').filter((w) => w.length > 2);
  const { songs } = await source.search(result.title, { songCount: 30, albumCount: 0, artistCount: 0 });
  return (
    songs.find((song) => {
      if (fold(song.title) !== title) return false;
      const artist = fold(song.artist);
      if (artists.length > 0 && !artists.some((w) => artist.includes(w))) return false;
      return !result.durationSec || !song.duration || Math.abs(song.duration - result.durationSec) <= 5;
    }) ?? null
  );
}
