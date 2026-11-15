import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type { MusicSource } from '@/sources/types';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: 1 } },
});

/** Lo que va después del prefijo de la fuente en una clave, o null si es de otra fuente. */
function partOf(source: MusicSource, queryKey: QueryKey): unknown {
  return source.key.every((k, i) => queryKey[i] === k) ? queryKey[source.key.length] : null;
}

/** Las claves son [...source.key, 'playlists' | 'playlist', …] (ver queries.ts). */
export function invalidatePlaylists(source: MusicSource) {
  return queryClient.invalidateQueries({ predicate: ({ queryKey }) => String(partOf(source, queryKey)).startsWith('playlist') });
}

/** Toda la biblioteca de la fuente (tras añadir, borrar o recortar canciones), salvo lo de YouTube. */
export function invalidateLibrary(source: MusicSource) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      const part = partOf(source, queryKey);
      return part !== null && part !== 'youtube';
    },
  });
}
