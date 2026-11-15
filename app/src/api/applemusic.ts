import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { serverSession, useMaybeServerSession, useSource, type MusicSource } from '@/sources';
import {
  cancelLocalAppleImport,
  createLocalAppleImport,
  deleteLocalAppleImport,
  retryLocalAppleImport,
  startLocalAppleImport,
  useLocalAppleImports,
  type AppleImportOptions,
} from './appleMusicLocal';
import { invalidateLibrary, queryClient } from './queryClient';
import { request, uploaderUrl, type Session } from './subsonic';

const POLL_MS = 1500;

export type ImportStatus = 'reading' | 'matching' | 'review' | 'downloading' | 'saving' | 'done' | 'error';

/**
 * library: ya estaba en la biblioteca · youtube: falta y se encontró en YouTube Music · notFound: no se
 * encontró · skipped: el usuario no la quiso · downloading/indexing → added o failed durante la importación.
 */
export type ImportTrackState = 'pending' | 'library' | 'youtube' | 'notFound' | 'skipped' | 'downloading' | 'indexing' | 'added' | 'failed';

export type ImportTrack = {
  index: number;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  explicit: boolean;
  artwork: string | null;
  state: ImportTrackState;
  match:
    | { source: 'library'; songId: string; title: string; artist: string | null }
    | { source: 'youtube'; videoId: string; title: string; artist: string | null; album: string | null; durationSec: number | null; thumbnail: string }
    | null;
  error: string | null;
  progress: number | null;
  /** La cola de YouTube está en pausa (control anti-bots) hasta esta hora. */
  waitingUntil: number | null;
};

export type ImportJob = {
  id: string;
  url: string;
  status: ImportStatus;
  progress: number;
  name: string | null;
  curator: string | null;
  artwork: string | null;
  trackCount: number;
  warning: string | null;
  error: string | null;
  playlistId: string | null;
  createdAt: number;
  counts: { library: number; youtube: number; notFound: number; skipped: number; added: number; failed: number };
  tracks?: ImportTrack[];
};

export const IMPORT_STATUS: Record<ImportStatus, string> = {
  reading: 'Leyendo la playlist…',
  matching: 'Buscando las canciones…',
  review: 'Lista para importar',
  downloading: 'Descargando las que faltan…',
  saving: 'Creando la playlist…',
  done: 'Importada',
  error: 'Error',
};

export const isImportBusy = (status: ImportStatus) => status !== 'review' && status !== 'done' && status !== 'error';

const importsKey = (s: Session | null) => [s?.server, s?.username, 'youtube', 'imports'];

/** Lo que las pantallas usan de una consulta: igual si viene del servidor o del propio teléfono. */
export type ImportQuery<T> = { data: T | undefined; isError: boolean; error: Error | null; refetch: () => unknown };

const localQuery = <T,>(data: T | undefined): ImportQuery<T> => ({ data, isError: false, error: null, refetch: () => {} });

/**
 * Importaciones recientes del usuario: en modo servidor viven en el servidor (siguen aunque se cierre la
 * app); en modo local, en el teléfono (api/appleMusicLocal.ts).
 */
export function useAppleImports(): ImportQuery<ImportJob[]> {
  const session = useMaybeServerSession();
  const local = useLocalAppleImports();
  const server = useQuery({
    queryKey: importsKey(session),
    queryFn: () => request<{ imports: ImportJob[] }>(uploaderUrl(session!, 'applemusic/imports')).then((r) => r.imports),
    refetchInterval: (q) => (q.state.data?.some((j) => isImportBusy(j.status)) ? POLL_MS : false),
    staleTime: 0,
    enabled: !!session,
  });
  return session ? server : localQuery(local);
}

export function useAppleImport(id: string): ImportQuery<ImportJob> {
  const source = useSource();
  const session = useMaybeServerSession();
  const local = useLocalAppleImports().find((j) => j.id === id);
  const job = useQuery({
    queryKey: [...importsKey(session), id],
    queryFn: () => request<{ import: ImportJob }>(uploaderUrl(session!, `applemusic/imports/${encodeURIComponent(id)}`)).then((r) => r.import),
    refetchInterval: (q) => (!q.state.data || isImportBusy(q.state.data.status) ? POLL_MS : false),
    staleTime: 0,
    enabled: !!session,
  });

  // Al terminar, la nueva playlist y las canciones descargadas aparecen en la biblioteca.
  const status = session ? job.data?.status : local?.status;
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current && previous.current !== 'done' && status === 'done') {
      // Incluye las playlists.
      invalidateLibrary(source);
    }
    previous.current = status;
  }, [status, source]);

  if (session) return job;
  return local ? localQuery(local) : { ...localQuery<ImportJob>(undefined), isError: true, error: new Error('No existe esa importación') };
}

export async function createAppleImport(source: MusicSource, url: string): Promise<ImportJob> {
  if (source.kind === 'local') return createLocalAppleImport(url);
  const r = await request<{ import: ImportJob }>(uploaderUrl(serverSession(source), 'applemusic/imports'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return r.import;
}

/** appendTo: id de una playlist existente a la que añadir, en lugar de crear (o actualizar) la del nombre. */
export async function startAppleImport(source: MusicSource, id: string, options: AppleImportOptions): Promise<ImportJob> {
  if (source.kind === 'local') return startLocalAppleImport(id, options);
  const r = await request<{ import: ImportJob }>(uploaderUrl(serverSession(source), `applemusic/imports/${encodeURIComponent(id)}/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return r.import;
}

/** Vuelve a descargar las que fallaron y actualiza la playlist ya creada. */
export async function retryAppleImport(source: MusicSource, id: string): Promise<ImportJob> {
  if (source.kind === 'local') return retryLocalAppleImport(id);
  const r = await request<{ import: ImportJob }>(uploaderUrl(serverSession(source), `applemusic/imports/${encodeURIComponent(id)}/retry`), { method: 'POST' });
  return r.import;
}

/** Cancela las descargas pendientes; lo ya descargado se guarda igual en la playlist. */
export async function cancelAppleImport(source: MusicSource, id: string): Promise<void> {
  if (source.kind === 'local') return cancelLocalAppleImport(id);
  await request<{ import: ImportJob }>(uploaderUrl(serverSession(source), `applemusic/imports/${encodeURIComponent(id)}/cancel`), { method: 'POST' });
}

/** Descarta una importación de la lista (lo descargado y la playlist se quedan). */
export async function deleteAppleImport(source: MusicSource, id: string): Promise<void> {
  if (source.kind === 'local') return deleteLocalAppleImport(id);
  const session = serverSession(source);
  await request<null>(uploaderUrl(session, `applemusic/imports/${encodeURIComponent(id)}`), { method: 'DELETE' });
  await queryClient.invalidateQueries({ queryKey: importsKey(session), exact: true });
}
