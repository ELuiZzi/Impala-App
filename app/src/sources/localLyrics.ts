import { Directory, File, Paths } from 'expo-file-system';
import ImpalaLibrary from '../../modules/impala-library';
import type { LyricLine, Lyrics, Song } from './types';

/**
 * Letras de la música del teléfono: primero un `.lrc` junto al audio (mismo nombre) y, si no hay, LRCLIB
 * pedido desde el teléfono (como hace el servidor). Las letras incrustadas en el archivo (USLT/SYLT, Vorbis
 * LYRICS) no se leen: Android no las expone y haría falta un lector de etiquetas propio.
 *
 * Lo de LRCLIB se guarda en el teléfono (un JSON por canción); también el «no hay letra», que caduca para
 * volver a probar más adelante. El `.lrc` no se guarda: se lee cada vez, así un cambio en el archivo se ve.
 */
const LRCLIB = 'https://lrclib.net/api';
const USER_AGENT = 'Impala (https://github.com/ELuiZzi/Impala-App)';
const TIMEOUT_MS = 10_000;
/** Cuánto se recuerda que una canción no tiene letra en LRCLIB. */
const NOT_FOUND_TTL_MS = 7 * 24 * 3600_000;
/** Margen de duración para aceptar una letra de LRCLIB (radio edit, en vivo…). */
const DURATION_SLACK_S = 5;

const NONE: Lyrics = { source: null, synced: false, lines: [] };

const cacheDir = new Directory(Paths.cache, 'lyrics-local');

type CacheEntry = { lyrics: Lyrics; at: number };

/** La clave incluye título y artista: si el id del índice se reutiliza para otro archivo, no se mezcla. */
function cacheFile(song: Song) {
  const key = `${song.id}-${hash(`${song.title}|${song.artist ?? ''}`)}`;
  return new File(cacheDir, `${key}.json`);
}

function hash(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function readCache(song: Song): Lyrics | null {
  try {
    const file = cacheFile(song);
    if (!file.exists) return null;
    const entry = JSON.parse(file.textSync()) as CacheEntry;
    if (!entry?.lyrics) return null;
    if (entry.lyrics.source === null && Date.now() - entry.at > NOT_FOUND_TTL_MS) return null;
    // Las guardadas antes de quitar las marcas de voz se limpian al leerlas.
    return { ...entry.lyrics, lines: entry.lyrics.lines.map(cleanLine) };
  } catch {
    return null;
  }
}

function writeCache(song: Song, lyrics: Lyrics) {
  try {
    if (!cacheDir.exists) cacheDir.create({ intermediates: true });
    cacheFile(song).write(JSON.stringify({ lyrics, at: Date.now() } satisfies CacheEntry));
  } catch (e) {
    console.warn('No se pudo guardar la letra', e);
  }
}

/** La letra guardada de LRCLIB (no el .lrc), para moverla al recortar la canción. */
export const cachedLyrics = (song: Song): Lyrics | null => readCache(song);

/** Sustituye la letra guardada (null la borra: se volverá a buscar). */
export function replaceCachedLyrics(song: Song, lyrics: Lyrics | null) {
  if (lyrics) return writeCache(song, lyrics);
  try {
    const file = cacheFile(song);
    if (file.exists) file.delete();
  } catch {
    // sin caché que borrar
  }
}

export async function localLyrics(song: Song): Promise<Lyrics> {
  const sidecar = await ImpalaLibrary.readSidecarLyrics(song.id).catch(() => null);
  if (sidecar?.trim()) {
    const lines = parseLrc(sidecar);
    if (lines.length > 0) return { source: 'file', synced: true, lines };
    // Un .lrc sin marcas de tiempo: letra sin sincronizar.
    return { source: 'file', synced: false, lines: plainLines(sidecar) };
  }
  const cached = readCache(song);
  if (cached) return cached;
  const found = (await fromLrclib(song)) ?? NONE;
  writeCache(song, found);
  return found;
}

type LrclibTrack = { duration?: number; syncedLyrics?: string | null; plainLyrics?: string | null };

/** Sin red o LRCLIB caído/saturado: no se guarda el «no hay letra», se vuelve a probar la próxima vez. */
class LrclibUnavailable extends Error {}

/**
 * Varias consultas, de la más precisa a la más tolerante: `get` con álbum, `get` sin álbum (el álbum de Android
 * puede ser el nombre de la carpeta, p. ej. «Impala», en canciones sueltas descargadas de YouTube), `search` por
 * título y artista y, por último, `search` libre. `get` responde a menudo 404/429/503 aunque la canción exista:
 * un fallo de una consulta no detiene las siguientes.
 */
async function fromLrclib(song: Song): Promise<Lyrics | null> {
  const meta = lookupMeta(song);
  if (!meta.title) return null;
  const { title, artist, album, duration } = meta;
  const core = coreTitle(title) || title;
  let failures = 0;
  let attempts = 0;
  const tryQuery = async <T>(endpoint: 'get' | 'search', params: Record<string, string>): Promise<T | null> => {
    attempts++;
    try {
      return await lrclib<T>(endpoint, params);
    } catch {
      failures++;
      return null;
    }
  };

  const gets = album ? [album, ''] : [''];
  if (artist && duration) {
    for (const albumName of gets) {
      const exact = await tryQuery<LrclibTrack>('get', { track_name: title, artist_name: artist, album_name: albumName, duration: String(duration) });
      const picked = pick(exact ? [exact] : []);
      if (picked) return picked;
    }
  }
  const searches: Record<string, string>[] = [
    ...(artist ? [{ track_name: core, artist_name: artist }] : []),
    { q: `${artist} ${core}`.trim() },
  ];
  for (const params of searches) {
    const results = (await tryQuery<LrclibTrack[]>('search', params)) ?? [];
    // Primero las de duración parecida; si ninguna lo es (archivo recortado, otra versión), la mejor que haya
    // (solo si se buscó por artista: en la búsqueda libre una duración lejana suele ser otra canción).
    const close = results.filter((c) => !duration || !c.duration || Math.abs(c.duration - duration) <= DURATION_SLACK_S);
    const picked = pick(close.length > 0 || !params.artist_name ? close : results);
    if (picked) return picked;
  }
  if (failures === attempts) throw new LrclibUnavailable('No se pudo conectar con LRCLIB');
  return null;
}

function pick(candidates: LrclibTrack[]): Lyrics | null {
  const usable = candidates.filter((c) => c.syncedLyrics || c.plainLyrics);
  const best = usable.find((c) => c.syncedLyrics) ?? usable[0];
  if (!best) return null;
  if (best.syncedLyrics) return { source: 'lrclib', synced: true, lines: parseLrc(best.syncedLyrics) };
  return { source: 'lrclib', synced: false, lines: plainLines(best.plainLyrics ?? '') };
}

/**
 * Lo que se le pregunta a LRCLIB. Si Android no leyó las etiquetas, el título es el nombre del archivo
 * («Artista - Título») y no hay artista: se separa. Se quitan los añadidos de YouTube («(Official Video)»…).
 */
export function lookupMeta(song: Pick<Song, 'title' | 'artist' | 'album' | 'duration'>) {
  let title = (song.title ?? '').replace(NOISE, '').trim();
  let artist = (song.artist ?? '').replace(/\s*-\s*Topic$/i, '').trim();
  if (!artist) {
    const split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
    if (split) [artist, title] = [split[1].trim(), split[2].trim()];
  }
  // Sin etiqueta de álbum, Android pone el nombre de la carpeta: no sirve para buscar.
  const album = song.album && !FOLDER_ALBUMS.has(song.album.trim().toLowerCase()) ? song.album : '';
  return { title, artist, album, duration: Math.round(song.duration ?? 0) };
}

const FOLDER_ALBUMS = new Set(['impala', 'music', 'download', 'downloads', 'música']);
const NOISE = /\s*[([][^)\]]*\b(official|oficial|video|vídeo|audio|lyrics?|letra|visuali[sz]er|hd|4k|mv|videoclip)\b[^)\]]*[)\]]/gi;

async function lrclib<T>(endpoint: 'get' | 'search', params: Record<string, string>): Promise<T | null> {
  // AbortSignal.timeout no existe en Hermes: se corta a mano.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${LRCLIB}/${endpoint}?${new URLSearchParams(params)}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
  } catch {
    throw new LrclibUnavailable('No se pudo conectar con LRCLIB');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new LrclibUnavailable(`LRCLIB respondió HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** "Canción (Remastered 2011) - Live" → "Canción": lo que suele variar entre versiones. */
function coreTitle(title: string) {
  return title
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .trim();
}

const plainLines = (text: string): LyricLine[] => text.split(/\r?\n/).map((line) => ({ timeMs: null, text: stripVoice(line.trim()) }));

/** Marca de intérprete al inicio de la línea ("v1:", "v2:" en LRC con varias voces): no es parte del texto. */
const stripVoice = (text: string) => text.replace(/^\s*v\d{1,2}\s*:\s*/i, '');

function cleanLine(line: LyricLine): LyricLine {
  const text = stripVoice(line.text);
  if (text === line.text && !line.words?.length) return line;
  const words = line.words?.map((w, i) => (i === 0 ? { ...w, text: stripVoice(w.text) } : w)).filter((w) => w.text);
  return { ...line, text, words: words?.length ? words : undefined };
}

const toMs = (m: string, s: string, frac = '0') => Number(m) * 60_000 + Number(s) * 1000 + Number(frac.padEnd(3, '0').slice(0, 3));

/** "[01:02.34]texto" → { timeMs: 62340, text }. Igual que en el servidor (uploader/src/lyrics.js). */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: (LyricLine & { timeMs: number })[] = [];
  let offset = 0;
  for (const raw of lrc.split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) {
      offset = Number(off[1]);
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;
    const body = raw.replace(/\[[^\]]*\]/g, '');
    // LRC mejorado ("<00:12.80>palabra"): tiempos por palabra, para el resaltado tipo karaoke.
    const words = [...body.matchAll(/<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>([^<]*)/g)]
      .map(([, m, s, frac, word]) => ({ timeMs: Math.max(0, toMs(m, s, frac) - offset), text: word.trim() }))
      .filter((w) => w.text);
    const text = stripVoice(body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    for (const [, m, s, frac] of stamps) {
      const line: LyricLine & { timeMs: number } = { timeMs: Math.max(0, toMs(m, s, frac) - offset), text };
      if (words.length > 0 && stamps.length === 1) line.words = words;
      lines.push(line);
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
