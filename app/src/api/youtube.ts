import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import type { PreviewSource } from '@/player/preview';
import { serverSession, sourceKey, useMaybeServerSession, useSource, type MusicSource, type Song } from '@/sources';
import { SubsonicSource } from '@/sources/subsonic';
import { audioStream, resetVisitor, setAudioClient, warmUp, type InnertubeClient } from './innertube';
import { invalidateLibrary, queryClient } from './queryClient';
import { request, uploaderUrl, type Session } from './subsonic';
import { cancelLocal, enqueueLocal, useLocalYoutubeJobs, waitForLocalJob, type LocalDownloadItem } from './youtubeLocal';
import { findInLibrary } from './youtubeMatch';
import * as ytmusic from './ytmusic';
import type { ArtistPage, SearchResponse, YoutubeAlbumDetail, YoutubeAlbumTrack, YoutubeArtist, YoutubeResult } from './ytmusic';

export { fold } from './youtubeMatch';
export type { YoutubeAlbum, YoutubeAlbumDetail, YoutubeAlbumTrack, YoutubeArtist, YoutubeArtistResult, YoutubeResult } from './ytmusic';

/** Navidrome detecta los archivos nuevos en ~2 s; esperamos un poco antes de refrescar la biblioteca. */
const LIBRARY_REFRESH_DELAY_MS = 4000;
const POLL_MS = 1500;

export type YoutubeJob = {
  id: string;
  videoId: string;
  title: string | null;
  artist: string | null;
  status: 'queued' | 'downloading' | 'processing' | 'done' | 'error' | 'cancelled';
  progress: number;
  error?: string;
  file?: string;
  duplicate?: boolean;
  /** YouTube pidió confirmar que no es un bot: la cola espera hasta esta hora y reintenta. */
  waitingUntil?: number | null;
};

/** Rutas de YouTube del microservicio de ingestión (yt-dlp en el servidor). */
function youtubeUrl(session: Session, path: string, params: Record<string, string> = {}): string {
  return uploaderUrl(session, `youtube/${path}`, params);
}

/**
 * Búsquedas, álbumes, artistas y vistas previas se piden a YouTube desde el teléfono (ytmusic.ts): sin
 * pasar por Tailscale ni esperar a Python en el servidor. Si eso falla (YouTube cambió algo), se pide
 * lo mismo al servidor, donde ytmusicapi y yt-dlp se actualizan solos. Las descargas siguen en el servidor.
 */
async function deviceFirst<T>(what: string, device: () => Promise<T>, server: (() => Promise<T>) | null, signal?: AbortSignal): Promise<T> {
  try {
    return await device();
  } catch (err) {
    // En modo local no hay servidor de respaldo.
    if (signal?.aborted || !server) throw err;
    console.warn(`YouTube desde el teléfono (${what}) falló; se usa el servidor:`, err instanceof Error ? err.message : err);
    return server();
  }
}

// --- Cliente del audio ---------------------------------------------------------------------------
// El yt-dlp del servidor se actualiza cada día y sabe qué cliente de YouTube sigue dando audio sin PO
// token; la app lo pregunta (como mucho cada 6 h, o tras un fallo) en vez de esperar a una versión nueva.

const AUDIO_CLIENT_TTL_MS = 6 * 60 * 60_000;
let audioClientSync: { at: number; promise: Promise<void> } | null = null;

const validClient = (c: any): InnertubeClient | null =>
  c && typeof c.name === 'string' && Number.isInteger(c.id) && typeof c.version === 'string' && typeof c.userAgent === 'string' ? c : null;

function syncAudioClient(session: Session | null, force = false): Promise<void> {
  if (!session) return Promise.resolve();
  if (!force && audioClientSync && Date.now() - audioClientSync.at < AUDIO_CLIENT_TTL_MS) return audioClientSync.promise;
  const promise = request<{ client: unknown }>(youtubeUrl(session, 'client'))
    .then((r) => setAudioClient(validClient(r.client)))
    // Sin respuesta (o un servidor sin esta ruta): se queda el cliente que trae la app.
    .catch(() => {});
  audioClientSync = { at: Date.now(), promise };
  return promise;
}

/** Audio ya resuelto por el teléfono: vale horas, pero solo para su IP; se reutiliza un rato. */
const AUDIO_CACHE_MS = 10 * 60_000;
const audioCache = new Map<string, { url: string; until: number }>();

/**
 * Vista previa de un video: el audio directo de YouTube pedido desde el teléfono (suena en ~1-2 s) y, si
 * no se puede, el que reenvía el servidor con yt-dlp (sin servidor, en modo local, no hay ese respaldo).
 */
export function youtubePreviewSource(session: Session | null, videoId: string): PreviewSource {
  return {
    direct: async (retry) => {
      void syncAudioClient(session);
      const cached = audioCache.get(videoId);
      if (!retry && cached && cached.until > Date.now()) return cached.url;
      // El audio no sonó: con otra identidad (YouTube a veces exige PO token a un visitante concreto).
      if (retry) resetVisitor();
      const { url, expiresAt } = await audioStream(videoId);
      audioCache.set(videoId, { url, until: Math.min(expiresAt - 60_000, Date.now() + AUDIO_CACHE_MS) });
      return url;
    },
    server: session ? youtubeUrl(session, `preview/${videoId}`) : null,
    onDirectFailed: (err) => {
      audioCache.delete(videoId);
      console.warn('El audio directo de la vista previa falló:', err instanceof Error ? err.message : err);
      void syncAudioClient(session, true);
    },
  };
}

/** Enlaces de YouTube (watch?v=, youtu.be/, shorts/, music.youtube.com…): se buscan tal cual en YouTube. */
export const isYoutubeLink = (text: string) =>
  /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/))[A-Za-z0-9_-]{11}/i.test(text);

/**
 * Búsqueda en dos partes: la música de YouTube Music (canciones, álbumes y artistas) llega en ~0,5 s y
 * se muestra en seguida; los videos de la búsqueda general se añaden después.
 */
export function useYoutubeSearch(q: string) {
  const source = useSource();
  const session = useMaybeServerSession();
  // Mientras se escribe la primera búsqueda, la conexión con YouTube ya queda abierta.
  useEffect(() => warmUp(), []);
  const part = (scope: 'music' | 'videos') => ({
    queryKey: sourceKey(source, 'youtube', 'search', scope, q),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      void syncAudioClient(session);
      return deviceFirst(
        'búsqueda',
        () => ytmusic.search(q, scope, signal),
        session && (() => request<SearchResponse>(youtubeUrl(session, 'search', { q, scope }))),
        signal,
      );
    },
    enabled: source.capabilities.youtube && q.length > 0,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const music = useQuery(part('music'));
  const videos = useQuery(part('videos'));
  return { music, videos };
}

/** La sesión del servidor si la fuente es uno; null en modo local. */
const maybeSession = (source: MusicSource) => (source instanceof SubsonicSource ? source.session : null);

const albumKey = (source: MusicSource, id: string) => sourceKey(source, 'youtube', 'album', id);
const fetchAlbum = (session: Session | null, id: string, signal?: AbortSignal) =>
  deviceFirst(
    'álbum',
    () => ytmusic.getAlbum(id, signal),
    session && (() => request<{ album: YoutubeAlbumDetail }>(youtubeUrl(session, `albums/${encodeURIComponent(id)}`)).then((r) => r.album)),
    signal,
  );

export function useYoutubeAlbum(id: string) {
  const source = useSource();
  return useQuery({
    queryKey: albumKey(source, id),
    queryFn: ({ signal }) => fetchAlbum(maybeSession(source), id, signal),
    enabled: source.capabilities.youtube,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
}

/** Pide un álbum por adelantado (los primeros de una búsqueda): al abrirlo ya está cargado. */
export function prefetchYoutubeAlbum(source: MusicSource, id: string) {
  return queryClient.prefetchQuery({ queryKey: albumKey(source, id), queryFn: () => fetchAlbum(maybeSession(source), id), staleTime: 30 * 60 * 1000 });
}

/**
 * Artista de YouTube Music por id de canal, o (artistas de la biblioteca) por nombre. La página se
 * enseña con la portada del artista (una petición: cabecera, 5 populares, álbumes y sencillos) y las
 * listas completas (25 populares, todos los sencillos) se añaden cuando llegan.
 */
export function useYoutubeArtist(by: { id: string } | { name: string } | null) {
  const source = useSource();
  const session = useMaybeServerSession();
  const key = by ? ('id' in by ? `id:${by.id}` : `name:${by.name.toLowerCase()}`) : '';
  const page = useQuery({
    queryKey: sourceKey(source, 'youtube', 'artist', key),
    queryFn: ({ signal }) =>
      deviceFirst<ArtistPage>(
        'artista',
        async () => {
          const id = by && 'id' in by ? by.id : await ytmusic.findArtistId(by && 'name' in by ? by.name : '', signal);
          if (!id) throw new Error('Ese artista no está en YouTube Music');
          return ytmusic.getArtistPage(id, signal);
        },
        session &&
          (() =>
            request<{ artist: YoutubeArtist }>(
              by && 'id' in by ? youtubeUrl(session, `artists/${encodeURIComponent(by.id)}`) : youtubeUrl(session, 'artists', { name: by && 'name' in by ? by.name : '' }),
            ).then((r) => ({ artist: r.artist, more: {} }))),
        signal,
      ),
    enabled: source.capabilities.youtube && !!by,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const more = useQuery({
    queryKey: sourceKey(source, 'youtube', 'artist-more', key),
    queryFn: ({ signal }) => ytmusic.getArtistMore(page.data!, signal),
    enabled: !!page.data && Object.keys(page.data.more).length > 0,
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
  const data = useMemo<YoutubeArtist | undefined>(() => page.data && { ...page.data.artist, ...more.data }, [page.data, more.data]);
  // Si la fuente no ofrece YouTube no se consulta: no queda «cargando» para siempre.
  return { data, isPending: source.capabilities.youtube && page.isPending, isError: page.isError, error: page.error, refetch: page.refetch };
}

/** Carátula de YouTube Music a otro tamaño (las URLs llevan "=w226-h226"). */
export const resizeYoutubeThumbnail = (url: string | null, size: number) => url?.replace(/=w\d+-h\d+/, `=w${size}-h${size}`) ?? null;

export const isActive = (j: YoutubeJob) => j.status === 'queued' || j.status === 'downloading' || j.status === 'processing';

/** Una canción suelta para la cola local: los tags salen del resultado (título y artista ya limpios). */
const localItem = (r: YoutubeResult): LocalDownloadItem => ({
  videoId: r.id,
  title: r.title,
  artist: r.artist,
  album: r.album,
  durationSec: r.durationSec,
  cover: r.thumbnail,
});

/**
 * Descargas en curso y recientes. Con un servidor se consultan cada 1,5 s mientras haya alguna activa; en
 * modo local las lleva la cola del teléfono (youtubeLocal.ts).
 */
export function useYoutubeDownloads() {
  const source = useSource();
  const maybeSession = useMaybeServerSession();
  const localJobs = useLocalYoutubeJobs();
  const local = source.kind === 'local';
  const downloads = useQuery({
    queryKey: sourceKey(source, 'youtube', 'downloads'),
    queryFn: () => request<{ jobs: YoutubeJob[] }>(youtubeUrl(maybeSession!, 'downloads')).then((r) => r.jobs),
    enabled: !!maybeSession,
    refetchInterval: (q) => (q.state.data?.some(isActive) ? POLL_MS : false),
    staleTime: 0,
  });

  // Cuando una descarga termina, la biblioteca la incorpora tras el escaneo de Navidrome.
  const seenDone = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = new Set((downloads.data ?? []).filter((j) => j.status === 'done').map((j) => j.id));
    const previous = seenDone.current;
    seenDone.current = done;
    if (maybeSession && previous && [...done].some((id) => !previous.has(id))) {
      setTimeout(() => invalidateLibrary(source), LIBRARY_REFRESH_DELAY_MS);
    }
  }, [downloads.data, source, maybeSession]);

  /** Las acciones solo existen con un servidor (las pantallas que las ofrecen dependen de `capabilities.youtube`). */
  const server = () => serverSession(source);

  async function start(result: YoutubeResult) {
    if (local) return void enqueueLocal([localItem(result)]);
    const session = server();
    await request(youtubeUrl(session, 'downloads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: result.id, title: result.title, artist: result.artist }),
    });
    await downloads.refetch();
  }

  /** Un álbum entero: con los datos del álbum en los tags, para que Navidrome lo agrupe. */
  async function startAlbum(album: YoutubeAlbumDetail, tracks: YoutubeAlbumTrack[]) {
    if (local) {
      enqueueLocal(
        tracks.map((t) => ({
          videoId: t.id,
          title: t.title,
          artist: t.artist ?? album.artist,
          album: album.title,
          albumArtist: album.artist,
          trackNumber: t.trackNumber,
          year: album.year,
          durationSec: t.durationSec,
          cover: album.cover ?? album.thumbnail ?? t.thumbnail,
        })),
      );
      return;
    }
    const session = server();
    await request(youtubeUrl(session, 'downloads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: tracks.map((t) => ({
          id: t.id,
          title: t.title,
          artist: t.artist ?? album.artist,
          album: album.title,
          albumArtist: album.artist,
          trackNumber: t.trackNumber,
          year: album.year,
        })),
      }),
    });
    await downloads.refetch();
  }

  /** Varias canciones sueltas en tanda (p. ej. las populares de un artista que faltan). */
  async function startMany(results: YoutubeResult[]) {
    if (results.length === 0) return;
    if (local) return void enqueueLocal(results.map(localItem));
    const session = server();
    await request(youtubeUrl(session, 'downloads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: results.map((r) => ({ id: r.id, title: r.title, artist: r.artist })) }),
    });
    await downloads.refetch();
  }

  async function cancel(jobIds: string[]) {
    if (local) return cancelLocal(jobIds);
    const session = server();
    await Promise.all(jobIds.map((id) => cancelYoutubeJob(session, id).catch(() => {})));
    await downloads.refetch();
  }

  return { jobs: local ? localJobs : (downloads.data ?? []), error: local ? null : downloads.error, start, startAlbum, startMany, cancel };
}

/** Cancela una descarga en cola o en curso (si ya se está guardando, el servidor responde 409). */
export const cancelYoutubeJob = (session: Session, jobId: string) =>
  request<{ job: YoutubeJob }>(youtubeUrl(session, `downloads/${encodeURIComponent(jobId)}`), { method: 'DELETE' });

const RESOLVE_POLL_MS = 2500;
/** Con las pausas por el control anti-bots, una descarga puede tardar bastante. */
const RESOLVE_TIMEOUT_MS = 2 * 60 * 60_000;
const resolving = new Map<string, Promise<Song>>();

/**
 * La canción de un resultado de YouTube, ya en la biblioteca: la descarga en el servidor (si no lo
 * estaba) y espera a que Navidrome la indexe. Varias acciones sobre el mismo video comparten la espera.
 */
export function ensureInLibrary(source: MusicSource, result: YoutubeResult): Promise<Song> {
  const pending = resolving.get(result.id);
  if (pending) return pending;
  const promise = (async () => {
    if (source.kind === 'local') {
      const existing = await findInLibrary(source, result).catch(() => null);
      if (existing) return existing;
      const [job] = enqueueLocal([localItem(result)]);
      return source.getSong(await waitForLocalJob(job.id));
    }
    const session = serverSession(source);
    // Si ya está en la biblioteca (p. ej. de una playlist importada), se usa esa y no se duplica.
    const existing = await findInLibrary(source, result).catch(() => null);
    if (existing) return existing;
    const { job } = await request<{ job: YoutubeJob }>(youtubeUrl(session, 'downloads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: result.id, title: result.title, artist: result.artist }),
    });
    queryClient.invalidateQueries({ queryKey: sourceKey(source, 'youtube', 'downloads') });
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(youtubeUrl(session, `downloads/${encodeURIComponent(job.id)}/song`)).catch(() => null);
      const body = await res?.json().catch(() => null);
      if (res?.status === 200 && body?.song) {
        // La biblioteca ya la incluye: se refrescan las listas.
        invalidateLibrary(source);
        return body.song as Song;
      }
      if (res && res.status >= 400) throw new Error(body?.error ?? `El servidor respondió HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
    }
    throw new Error('La descarga está tardando demasiado; inténtalo más tarde');
  })().finally(() => resolving.delete(result.id));
  resolving.set(result.id, promise);
  return promise;
}
