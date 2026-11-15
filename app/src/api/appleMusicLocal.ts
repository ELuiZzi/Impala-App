import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { localSource } from '@/sources/local';
import { localData } from '@/sources/localData';
import type { ImportJob, ImportTrack } from './applemusic';
import { invalidatePlaylists } from './queryClient';
import { bestMatch, coreTitle } from './songMatch';
import { cancelLocal, enqueueLocal, localJobs, subscribeLocalJobs, waitForLocalJob } from './youtubeLocal';
import { searchSongs } from './ytmusic';

/**
 * Importar playlists de Apple Music sin servidor (modo local): lo mismo que server/uploader/src/importer.js,
 * pero en el propio teléfono. Se lee la página pública de la playlist, cada canción se busca en la música del
 * teléfono y, las que faltan, en YouTube Music; al empezar se crea la playlist local y las que faltan van a la
 * cola de descargas del teléfono (youtubeLocal.ts), entrando en la playlist según terminan.
 *
 * Las importaciones se guardan en un JSON para verlas al volver a abrir la app; las descargas no sobreviven a
 * que se cierre (como la cola de YouTube local): lo pendiente queda como fallido y se puede reintentar.
 */

type Track = ImportTrack & { jobId?: string };
type Job = Omit<ImportJob, 'tracks' | 'counts'> & { tracks: Track[]; appendTo: string | null; base: string[] };
export type AppleImportOptions = { name: string; skip: number[]; appendTo?: string };

/** music.apple.com/{país}/playlist/{nombre opcional}/{pl.…}; los enlaces compartidos son iguales. */
const PLAYLIST_URL = /^https:\/\/(?:embed\.|beta\.)?music\.apple\.com\/([a-z]{2})\/playlist\/(?:[^/?#]+\/)?(pl\.[A-Za-z0-9_-]{8,80})(?:[/?#]|$)/i;
const PAGE_TIMEOUT_MS = 20_000;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
/** La API que usa la web de Apple Music para ir cargando las canciones de 100 en 100 al bajar por la lista. */
const AMP_API = 'https://amp-api.music.apple.com/v1/catalog';
const AMP_PAGE = 100;
/** La página web trae como mucho estas canciones (y su cabecera dice este mismo total aunque haya más). */
const PAGE_CAP = 300;
const MAX_PAGE_CHARS = 8 * 1024 ** 2;
const MAX_TRACKS = 1000;
/** " - Single", " - EP": Apple los añade al nombre del álbum; no forman parte del título real. */
const RELEASE_SUFFIX = /\s+-\s+(Single|EP)$/i;
/** Búsquedas en YouTube Music a la vez (el servidor las hace en tandas de 10 con un solo proceso). */
const MATCH_PARALLEL = 4;
const MAX_FINISHED = 10;
const MAX_NAME = 120;
const FILE = new File(Paths.document, 'apple-imports.json');

class ImportError extends Error {}

let jobs: Job[] | null = null;
let snapshot: ImportJob[] = [];
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// --- Estado --------------------------------------------------------------------------------------

function all(): Job[] {
  if (jobs) return jobs;
  jobs = [];
  try {
    if (FILE.exists) {
      const saved = JSON.parse(FILE.textSync()) as Job[];
      for (const job of Array.isArray(saved) ? saved : []) {
        if (!job?.id || !Array.isArray(job.tracks)) continue;
        // La app se cerró a medias: lo que se estaba leyendo se pide otra vez; lo que se descargaba, se reintenta.
        if (job.status === 'reading' || job.status === 'matching') {
          Object.assign(job, { status: 'error', error: 'Se interrumpió al cerrar la app; vuelve a pegar el enlace' });
        } else if (job.status === 'downloading' || job.status === 'saving') {
          for (const t of job.tracks) {
            if (t.state === 'downloading' || t.state === 'indexing') Object.assign(t, { state: 'failed', error: 'Se interrumpió al cerrar la app', progress: null });
          }
          Object.assign(job, { status: 'done', progress: 1 });
        }
        jobs.push(job);
      }
    }
  } catch {
    // Archivo dañado: se empieza sin importaciones antes que bloquear la app.
  }
  snapshot = jobs.map((j) => publicJob(j));
  return jobs;
}

/** Publica el cambio (las pantallas se repintan) y lo guarda poco después. */
function changed() {
  snapshot = all().map((j) => publicJob(j));
  listeners.forEach((l) => l());
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      FILE.write(JSON.stringify(all()));
    } catch (e) {
      console.warn('No se pudieron guardar las importaciones', e);
    }
  }, 1000);
}

function publicJob(job: Job): ImportJob {
  const { appendTo: _a, base: _b, tracks, ...rest } = job;
  const counts = { library: 0, youtube: 0, notFound: 0, skipped: 0, added: 0, failed: 0 };
  for (const t of tracks) if (t.state in counts) counts[t.state as keyof typeof counts]++;
  return { ...rest, counts, tracks: tracks.map(({ jobId: _j, ...t }) => t) };
}

function find(id: string): Job {
  const job = all().find((j) => j.id === id);
  if (!job) throw new ImportError('No existe esa importación');
  return job;
}

function subscribe(listener: () => void) {
  all();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Las importaciones del teléfono, la más reciente primero. */
export function useLocalAppleImports(): ImportJob[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

// --- Leer la playlist ----------------------------------------------------------------------------

function parsePlaylistUrl(input: string) {
  const text = input.trim();
  if (/music\.apple\.com\/library\//i.test(text)) {
    throw new ImportError('Es un enlace de tu biblioteca de Apple Music (privado). Usa Compartir playlist → Copiar para obtener el enlace público');
  }
  const m = PLAYLIST_URL.exec(text);
  if (!m) throw new ImportError('No es un enlace de playlist de Apple Music (music.apple.com/…/playlist/…)');
  const storefront = m[1].toLowerCase();
  return `https://music.apple.com/${storefront}/playlist/${m[2]}`;
}

type ApplePlaylist = { name: string; curator: string | null; artwork: string | null; trackCount: number; capped?: boolean; tracks: Omit<ImportTrack, 'index' | 'state' | 'match' | 'error' | 'progress' | 'waitingUntil'>[] };

/** La página web de la playlist: la propia web incrusta sus datos en "serialized-server-data" (como el servidor). */
async function readApplePlaylist(url: string): Promise<ApplePlaylist> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'es,en;q=0.8' },
      signal: controller.signal,
    });
    if (res.status === 404) throw new ImportError('Apple Music no encontró la playlist. ¿Es pública?');
    if (!res.ok) throw new ImportError(`Apple Music respondió HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    throw e instanceof ImportError ? e : new ImportError('No se pudo conectar con Apple Music');
  } finally {
    clearTimeout(timer);
  }
  if (html.length > MAX_PAGE_CHARS) throw new ImportError('La página de Apple Music es demasiado grande');
  const playlist = parsePlaylistPage(html);
  // La página solo trae las 300 primeras: el resto se pide como lo hace la propia web al bajar por la lista.
  if (playlist.capped || playlist.trackCount > playlist.tracks.length) {
    try {
      const all = await readAllTracks(url, html);
      if (all.length > playlist.tracks.length) {
        playlist.tracks = all;
        playlist.trackCount = Math.max(playlist.trackCount, all.length);
      }
      playlist.capped = false;
    } catch (e) {
      // Si falla, se importa lo que trae la página y el aviso de "solo mostró X de Y" lo explica.
      console.warn('Importar: no se pudieron leer las demás canciones de Apple Music:', e instanceof Error ? e.message : e);
    }
  }
  return playlist;
}

/** Todas las canciones (hasta MAX_TRACKS) con la API de la web, usando el token que la web lleva en su JavaScript. */
async function readAllTracks(url: string, html: string): Promise<ApplePlaylist['tracks']> {
  const m = /\/([a-z]{2})\/playlist\/(pl\.[A-Za-z0-9_-]+)$/.exec(url);
  if (!m) throw new Error('Enlace inesperado');
  const token = await webToken(html);
  const items: any[] = [];
  for (let offset = 0; offset < MAX_TRACKS; offset += AMP_PAGE) {
    const res = await fetchWithTimeout(`${AMP_API}/${m[1]}/playlists/${m[2]}/tracks?offset=${offset}&limit=${AMP_PAGE}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: 'https://music.apple.com', 'User-Agent': BROWSER_UA },
    });
    if (res.status === 404 && offset > 0) break; // pasada la última canción
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const page: any[] = Array.isArray(body?.data) ? body.data : [];
    items.push(...page);
    if (page.length < AMP_PAGE) break;
  }
  return items
    .map((it) => {
      const a = it?.attributes ?? {};
      return {
        title: String(a.name ?? '').trim(),
        artist: String(a.artistName ?? '').trim(),
        album: cleanAlbum(a.albumName),
        durationSec: Number.isFinite(a.durationInMillis) ? Math.round(a.durationInMillis / 1000) : null,
        explicit: a.contentRating === 'explicit',
        artwork: artworkUrl(a.artwork?.url, 300),
      };
    })
    .filter((t) => t.title && t.artist)
    .slice(0, MAX_TRACKS);
}

/** El token anónimo de la web de Apple Music: un JWT dentro de su JavaScript principal (/assets/index~….js). */
async function webToken(html: string): Promise<string> {
  const src = /<script[^>]+src="(\/assets\/index[^"]*\.js)"/.exec(html)?.[1];
  if (!src) throw new Error('No se encontró el JavaScript de la web');
  const res = await fetchWithTimeout(`https://music.apple.com${src}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} al leer la web`);
  const js = await res.text();
  const now = Date.now() / 1000;
  const tokens = [...new Set(js.match(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g) ?? [])];
  const token = tokens.find((t) => {
    try {
      const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload?.iss === 'AMPWebPlay' && (!payload.exp || payload.exp > now);
    } catch {
      return false;
    }
  });
  if (!token) throw new Error('No se encontró el token de la web');
  return token;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const FORMAT_CHANGED = 'La página de Apple Music cambió de formato; actualiza Impala o usa el modo servidor';

function parsePlaylistPage(html: string): ApplePlaylist {
  const m = /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new ImportError(FORMAT_CHANGED);
  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw new ImportError(FORMAT_CHANGED);
  }
  const page = (Array.isArray(data) ? data[0] : data?.data?.[0])?.data;
  const sections: any[] = Array.isArray(page?.sections) ? page.sections : [];
  const header = sections.find((s) => s?.itemKind === 'containerDetailHeaderLockup')?.items?.[0];
  const items: any[] = sections.filter((s) => s?.itemKind === 'trackLockup').flatMap((s) => s.items ?? []);
  if (!header && items.length === 0) throw new ImportError(FORMAT_CHANGED);

  const tracks = items
    .map((it) => ({
      title: String(it.title ?? '').trim(),
      artist: String(it.artistName ?? (it.subtitleLinks ?? []).map((l: any) => l.title).filter(Boolean).join(', ')).trim(),
      album: cleanAlbum(it.tertiaryLinks?.[0]?.title),
      durationSec: Number.isFinite(it.duration) ? Math.round(it.duration / 1000) : null,
      explicit: !!it.showExplicitBadge,
      artwork: artworkUrl(it.artwork?.dictionary?.url, 300),
    }))
    .filter((t) => t.title && t.artist)
    .slice(0, MAX_TRACKS);
  if (tracks.length === 0) throw new ImportError('No se encontraron canciones en la playlist');

  return {
    name: String(header?.title ?? 'Playlist de Apple Music').trim(),
    curator: header?.subtitleLinks?.[0]?.title ?? null,
    artwork: artworkUrl(header?.artwork?.dictionary?.url, 600),
    trackCount: Number.isInteger(header?.trackCount) ? header.trackCount : tracks.length,
    capped: items.length >= PAGE_CAP,
    tracks,
  };
}

function cleanAlbum(name: unknown): string | null {
  const album = String(name ?? '').replace(RELEASE_SUFFIX, '').trim();
  return album || null;
}

/** Las carátulas de Apple son plantillas: ".../{w}x{h}bb.{f}". */
function artworkUrl(template: unknown, size: number): string | null {
  if (typeof template !== 'string' || !template.startsWith('https://')) return null;
  return template.replace('{w}', String(size)).replace('{h}', String(size)).replace('{f}', 'jpg').replace('{c}', 'bb');
}

// --- Importar ------------------------------------------------------------------------------------

export function createLocalAppleImport(input: string): ImportJob {
  if (input.length > 500) throw new ImportError('Falta el enlace de la playlist');
  const url = parsePlaylistUrl(input);
  const job: Job = {
    id: `apple-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    url,
    status: 'reading',
    progress: 0,
    name: null,
    curator: null,
    artwork: null,
    trackCount: 0,
    tracks: [],
    warning: null,
    error: null,
    playlistId: null,
    createdAt: Date.now(),
    appendTo: null,
    base: [],
  };
  jobs = [job, ...all()];
  prune();
  changed();
  analyze(job).catch((e) => fail(job, e));
  return publicJob(job);
}

async function analyze(job: Job) {
  const playlist = await readApplePlaylist(job.url);
  Object.assign(job, { name: playlist.name, curator: playlist.curator, artwork: playlist.artwork, trackCount: playlist.trackCount, status: 'matching' });
  if (playlist.capped) job.warning = `Apple Music solo mostró las primeras ${playlist.tracks.length} canciones; la playlist puede tener más.`;
  else if (playlist.trackCount > playlist.tracks.length) job.warning = `Apple Music solo mostró ${playlist.tracks.length} de ${playlist.trackCount} canciones.`;
  job.tracks = playlist.tracks.map((t, index) => ({ index, ...t, state: 'pending', match: null, error: null, progress: null, waitingUntil: null }));
  const total = job.tracks.length * 2;
  changed();

  // 1. En el teléfono: búsqueda por el título "limpio" y emparejado por título, artista y duración.
  for (const track of job.tracks) {
    const { songs } = await localSource.search(coreTitle(track.title) || track.title, { songCount: 30, albumCount: 0, artistCount: 0 });
    const found = bestMatch(track, songs.map((s) => ({ ...s, title: s.title, artist: s.artist ?? null, album: s.album ?? null, durationSec: s.duration ?? null })));
    if (found) Object.assign(track, { state: 'library', match: { source: 'library', songId: found.id, title: found.title, artist: found.artist ?? null } });
    job.progress = (track.index + 1) / total;
  }
  changed();

  // 2. Las que faltan, en YouTube Music (unas pocas a la vez, para ir mostrando el progreso).
  const missing = job.tracks.filter((t) => t.state === 'pending');
  let done = job.tracks.length;
  for (let i = 0; i < missing.length; i += MATCH_PARALLEL) {
    await Promise.all(
      missing.slice(i, i + MATCH_PARALLEL).map(async (track) => {
        const results = await searchSongs(`${track.artist} ${coreTitle(track.title) || track.title}`).catch((e) => {
          console.warn('Importar: búsqueda en YouTube Music:', e instanceof Error ? e.message : e);
          return [];
        });
        const song = bestMatch(track, results);
        if (song) {
          Object.assign(track, {
            state: 'youtube',
            match: { source: 'youtube', videoId: song.id, title: song.title, artist: song.artist, album: song.album, durationSec: song.durationSec, thumbnail: song.thumbnail },
          });
        } else track.state = 'notFound';
        done++;
      }),
    );
    job.progress = done / total;
    changed();
  }
  Object.assign(job, { status: 'review', progress: 1 });
  changed();
}

/** Crea (o actualiza) la playlist con las que ya están en el teléfono y descarga las elegidas. */
export async function startLocalAppleImport(id: string, options: AppleImportOptions): Promise<ImportJob> {
  const job = find(id);
  if (job.status !== 'review') throw new ImportError('La importación no está lista para empezar');
  const skip = new Set(options.skip);
  for (const t of job.tracks) if (t.state === 'youtube' && skip.has(t.index)) t.state = 'skipped';
  job.name = options.name.trim().slice(0, MAX_NAME) || job.name;

  const playlists = localData().playlists;
  const target = options.appendTo ? playlists.find((p) => p.id === options.appendTo) : null;
  if (options.appendTo && !target) throw new ImportError('Esa playlist ya no existe');
  if (target) {
    // Añadir a una existente: lo suyo se queda delante y las de Apple que aún no tiene van al final.
    Object.assign(job, { appendTo: target.id, base: target.songIds, playlistId: target.id, name: target.name });
  } else {
    // Volver a importar la misma playlist actualiza la que ya existe con ese nombre en vez de duplicarla.
    const same = playlists.find((p) => p.name === job.name);
    job.playlistId = same?.id ?? (await localSource.createPlaylist(job.name ?? 'Playlist importada')).id;
  }
  Object.assign(job, { status: 'downloading', progress: 0 });
  await savePlaylist(job);
  download(job);
  return publicJob(job);
}

/** Pone en la playlist las canciones que ya están en el teléfono, en el orden de Apple Music. */
async function savePlaylist(job: Job) {
  if (!job.playlistId) return;
  const ids = job.tracks.flatMap((t) => (t.match?.source === 'library' ? [t.match.songId] : []));
  const songIds = job.appendTo ? [...job.base, ...[...new Set(ids)].filter((x) => !job.base.includes(x))] : ids;
  try {
    await localSource.setPlaylistSongs(job.playlistId, songIds);
    await invalidatePlaylists(localSource);
  } catch {
    // La borraron mientras se descargaba: se crea de nuevo con lo que hay.
    job.playlistId = (await localSource.createPlaylist(job.name ?? 'Playlist importada', songIds)).id;
    job.appendTo = null;
    job.base = [];
    await invalidatePlaylists(localSource);
  }
}

/** Manda las canciones elegidas a la cola del teléfono; cada una entra en la playlist al terminar. */
function download(job: Job) {
  const wanted = job.tracks.filter((t) => t.state === 'youtube' && t.match?.source === 'youtube');
  const queued = enqueueLocal(
    wanted.map((t) => {
      const yt = t.match as Extract<ImportTrack['match'], { source: 'youtube' }>;
      // Los tags salen de Apple Music: título, artista, álbum y carátula como en la playlist original.
      return { videoId: yt.videoId, title: t.title, artist: t.artist, album: t.album ?? yt.album ?? t.title, durationSec: t.durationSec, cover: t.artwork?.replace(/\/\d+x\d+bb\.jpg$/, '/1200x1200bb.jpg') ?? yt.thumbnail };
    }),
  );
  wanted.forEach((t, i) => Object.assign(t, { state: 'downloading', jobId: queued[i].id, progress: 0, error: null }));
  changed();

  // El progreso de cada descarga, mientras dure la importación.
  const stop = subscribeLocalJobs(() => {
    let moved = false;
    for (const t of job.tracks) {
      if (t.state !== 'downloading') continue;
      const yt = localJobs().find((j) => j.id === t.jobId);
      const progress = yt?.status === 'queued' ? 0 : (yt?.progress ?? 0);
      if (yt && progress !== t.progress) {
        t.progress = progress;
        moved = true;
      }
    }
    if (moved) changed();
  });

  const settle = () => {
    const finished = wanted.filter((t) => t.state !== 'downloading').length;
    job.progress = wanted.length ? finished / wanted.length : 1;
    if (finished === wanted.length) {
      stop();
      Object.assign(job, { status: 'done', progress: 1 });
    }
    changed();
  };

  if (wanted.length === 0) return settle();
  for (const t of wanted) {
    waitForLocalJob(t.jobId!)
      .then(async (songId) => {
        // El id del índice de Android, ya en la biblioteca releída: entra en la playlist en su sitio.
        Object.assign(t, { state: 'added', progress: 1, match: { source: 'library', songId, title: t.title, artist: t.artist } });
        await savePlaylist(job).catch(() => {});
      })
      .catch((e: Error) => {
        if (/cancelada/i.test(e.message)) Object.assign(t, { state: 'skipped', progress: null });
        else Object.assign(t, { state: 'failed', error: e.message, progress: null });
      })
      .finally(settle);
  }
}

/** Cancela lo pendiente: lo ya descargado se queda en la playlist; lo cancelado queda omitido. */
export function cancelLocalAppleImport(id: string) {
  const job = find(id);
  if (job.status !== 'downloading') throw new ImportError('No hay descargas en curso');
  cancelLocal(job.tracks.flatMap((t) => (t.state === 'downloading' && t.jobId ? [t.jobId] : [])));
}

/** Vuelve a descargar las que fallaron y las añade a la playlist ya creada. */
export function retryLocalAppleImport(id: string): ImportJob {
  const job = find(id);
  if (job.status !== 'done' && job.status !== 'error') throw new ImportError('La importación sigue en curso');
  const failed = job.tracks.filter((t) => t.state === 'failed' && t.match?.source === 'youtube');
  if (failed.length === 0) throw new ImportError('No hay canciones que reintentar');
  if (!job.playlistId) throw new ImportError('La importación no creó ninguna playlist');
  for (const t of failed) Object.assign(t, { state: 'youtube', error: null, progress: 0 });
  Object.assign(job, { status: 'downloading', progress: 0, error: null });
  download(job);
  return publicJob(job);
}

/** Descarta una importación que no está descargando (las canciones y la playlist se quedan). */
export function deleteLocalAppleImport(id: string) {
  const job = find(id);
  if (job.status === 'downloading' || job.status === 'saving') throw new ImportError('La importación está en curso');
  jobs = all().filter((j) => j !== job);
  changed();
}

function fail(job: Job, e: unknown) {
  Object.assign(job, { status: 'error', error: e instanceof ImportError ? e.message : 'No se pudo completar la importación' });
  if (!(e instanceof ImportError)) console.warn('Importar:', e);
  changed();
}

function prune() {
  const finished = all().filter((j) => j.status === 'done' || j.status === 'error');
  const drop = new Set(finished.slice(MAX_FINISHED));
  jobs = all().filter((j) => !drop.has(j));
}
