import { useQuery } from '@tanstack/react-query';
import { sourceKey, useSource, type LyricLine } from '@/sources';

export type { LyricLine, Lyrics } from '@/sources';

/** Letra de una canción de la biblioteca (la fuente la busca y, en el servidor, la guarda en caché). */
export function useLyrics(songId: string | undefined, enabled: boolean) {
  const source = useSource();
  return useQuery({
    queryKey: sourceKey(source, 'lyrics', songId),
    queryFn: () => source.lyrics(songId!),
    enabled: enabled && source.capabilities.lyrics && !!songId,
    staleTime: Infinity,
    retry: 1,
  });
}

/** Índice de la línea que suena en `positionMs` (−1 antes de la primera). */
export function currentLine(lines: LyricLine[], positionMs: number): number {
  'worklet'; // también se llama desde el hilo de UI (letra sincronizada a 60 fps)
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid].timeMs ?? 0) <= positionMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
