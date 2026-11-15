import { useQuery } from '@tanstack/react-query';
import { sourceKey, useSource } from '@/sources';

/**
 * Recortar canciones (en el servidor con ffmpeg, o en el teléfono: sources/localTrim.ts): quitar la intro, el final o trozos intermedios. Se
 * sobrescribe el archivo, pero se guarda el original la primera vez para poder restaurarlo.
 */
export type { Range, TrimInfo } from '@/sources';

export function useTrimInfo(songId: string) {
  const source = useSource();
  return useQuery({
    queryKey: sourceKey(source, 'trim', songId),
    queryFn: () => source.trimInfo(songId),
    staleTime: 0,
    gcTime: 0,
  });
}

export function useWaveform(songId: string) {
  const source = useSource();
  return useQuery({
    queryKey: sourceKey(source, 'waveform', songId),
    queryFn: () => source.waveform(songId),
    staleTime: 0,
    gcTime: 60_000,
  });
}
