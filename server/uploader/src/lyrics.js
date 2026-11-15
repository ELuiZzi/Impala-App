import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './auth.js';
import { coreTitle } from './match.js';
import { createSubsonic } from './navidrome.js';

const LRCLIB = 'https://lrclib.net/api';
const USER_AGENT = 'Impala/1.2 (servidor de música personal; https://github.com/ELuiZzi/Impala-App)';
const TIMEOUT_MS = 10_000;
/** Sin letra en ningún sitio: se vuelve a buscar pasado este tiempo (LRCLIB crece). */
const MISSING_TTL_MS = 3 * 24 * 60 * 60_000;
const MAX_MEMORY = 500;

/**
 * Letras sincronizadas (estilo Apple Music). Orden de búsqueda:
 *  1. La letra del propio archivo, que Navidrome expone vía OpenSubsonic (getLyricsBySongId).
 *  2. LRCLIB (base pública y gratuita de letras sincronizadas línea a línea).
 * El resultado se guarda en cacheDir (un JSON por canción), también cuando no hay letra.
 *
 * Respuesta: { source: 'file' | 'lrclib' | null, synced, lines: [{ timeMs, text }] }; sin
 * sincronizar, timeMs es null.
 */
export function createLyrics({ navidromeUrl, cacheDir = null, fetchImpl = fetch }) {
  const subsonic = createSubsonic({ navidromeUrl, client: 'impala-library', fetchImpl });
  const memory = new Map();

  async function get(songId, creds) {
    if (typeof songId !== 'string' || !/^[\w-]{1,100}$/.test(songId)) throw httpError(400, 'Identificador inválido');
    const cached = memory.get(songId) ?? (await readCache(songId));
    if (cached && (cached.lines.length > 0 || Date.now() - cached.fetchedAt < MISSING_TTL_MS)) return publicLyrics(cached);

    const { song } = await subsonic(creds, 'getSong', { id: songId });
    if (!song) throw httpError(404, 'No existe esa canción');
    const found = (await fromFile(songId, creds)) ?? (await fromLrclib(song)) ?? { source: null, synced: false, lines: [] };
    const entry = { ...found, fetchedAt: Date.now() };
    remember(songId, entry);
    await writeCache(songId, entry);
    return publicLyrics(entry);
  }

  async function fromFile(songId, creds) {
    try {
      const { lyricsList } = await subsonic(creds, 'getLyricsBySongId', { id: songId });
      const all = lyricsList?.structuredLyrics ?? [];
      const best = all.find((l) => l.synced && l.line?.length) ?? all.find((l) => l.line?.length);
      if (!best) return null;
      const lines = best.line.map((l) => ({ timeMs: best.synced ? Math.max(0, (l.start ?? 0) + (best.offset ?? 0)) : null, text: stripVoice(String(l.value ?? '')) }));
      return { source: 'file', synced: !!best.synced, lines };
    } catch {
      return null; // Navidrome antiguo sin OpenSubsonic, o sin letra
    }
  }

  async function fromLrclib(song) {
    const title = String(song.title ?? '');
    const artist = String(song.artist ?? '');
    const duration = Math.round(song.duration ?? 0);
    // `get` responde a menudo 404/429/503 aunque la canción exista: si falla se sigue con `search`, y solo
    // si las dos fallan es un error (no se guarda el «no hay letra»).
    let failed = 0;
    const tolerant = (endpoint, params) => lrclib(endpoint, params).catch((err) => {
      if (++failed === 2) throw err;
      return null;
    });
    const exact = await tolerant('get', { track_name: title, artist_name: artist, album_name: song.album ?? '', duration: String(duration) });
    const candidates = exact ? [exact] : ((await tolerant('search', { track_name: coreTitle(title) || title, artist_name: artist })) ?? []);
    // La duración separa versiones (radio edit, en vivo…); se prefiere la que tiene letra sincronizada.
    const usable = candidates.filter((c) => (c.syncedLyrics || c.plainLyrics) && (!duration || !c.duration || Math.abs(c.duration - duration) <= 5));
    const pick = usable.find((c) => c.syncedLyrics) ?? usable[0];
    if (!pick) return null;
    if (pick.syncedLyrics) return { source: 'lrclib', synced: true, lines: parseLrc(pick.syncedLyrics) };
    return { source: 'lrclib', synced: false, lines: pick.plainLyrics.split('\n').map((text) => ({ timeMs: null, text: stripVoice(text) })) };
  }

  async function lrclib(endpoint, params) {
    let res;
    try {
      res = await fetchImpl(`${LRCLIB}/${endpoint}?${new URLSearchParams(params)}`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw httpError(502, 'No se pudo conectar con LRCLIB');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw httpError(502, `LRCLIB respondió HTTP ${res.status}`);
    return res.json();
  }

  function remember(songId, entry) {
    if (memory.size >= MAX_MEMORY) memory.delete(memory.keys().next().value);
    memory.set(songId, entry);
  }

  const cacheFile = (songId) => path.join(cacheDir, `${songId}.json`);

  async function readCache(songId) {
    if (!cacheDir) return null;
    try {
      const entry = JSON.parse(await fs.readFile(cacheFile(songId), 'utf8'));
      remember(songId, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async function writeCache(songId, entry) {
    if (!cacheDir) return;
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile(songId), JSON.stringify(entry));
    } catch (err) {
      console.error('letras: no se pudo guardar la caché:', err.message);
    }
  }

  /** La entrada guardada de una canción (con fetchedAt), o null si aún no se buscó. */
  async function entry(songId) {
    return memory.get(songId) ?? (await readCache(songId));
  }

  /** Sustituye la entrada guardada (null la olvida: se volverá a buscar). Al recortar o restaurar una canción. */
  async function replace(songId, next) {
    if (next) {
      remember(songId, next);
      await writeCache(songId, next);
      return;
    }
    memory.delete(songId);
    if (cacheDir) await fs.rm(cacheFile(songId), { force: true }).catch(() => {});
  }

  return { get, entry, replace };
}

// Las cachés guardadas antes de quitar las marcas de voz se limpian al leerlas.
const publicLyrics = ({ source, synced, lines }) => ({ source, synced, lines: lines.map(cleanLine) });

function cleanLine(line) {
  const text = stripVoice(line.text);
  if (text === line.text && !line.words?.length) return line;
  const out = { ...line, text };
  if (line.words?.length) {
    out.words = line.words.map((w, i) => (i === 0 ? { ...w, text: stripVoice(w.text) } : w)).filter((w) => w.text);
    if (out.words.length === 0) delete out.words;
  }
  return out;
}

/**
 * Marca de intérprete al inicio de la línea ("v1:", "v2:" en LRC con varias voces, p. ej. letras
 * convertidas de Apple Music): no es parte del texto.
 */
export const stripVoice = (text) => String(text ?? '').replace(VOICE_TAG, '');
const VOICE_TAG = /^\s*v\d{1,2}\s*:\s*/i;

/** "[01:02.34]texto" → { timeMs: 62340, text }. Una línea puede llevar varias marcas de tiempo. */
export function parseLrc(lrc) {
  const lines = [];
  let offset = 0;
  for (const raw of String(lrc).split(/\r?\n/)) {
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
      .map(([, m, s, frac, word]) => ({ timeMs: Math.max(0, toMs(m, s, frac) - offset), text: word }))
      .filter((w) => w.text.trim());
    const text = stripVoice(body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    for (const [, m, s, frac] of stamps) {
      const line = { timeMs: Math.max(0, toMs(m, s, frac) - offset), text };
      // Con varias marcas por línea (coros repetidos) los tiempos de palabra solo valen para la primera.
      if (words.length > 0 && stamps.length === 1) line.words = words.map((w) => ({ timeMs: w.timeMs, text: w.text.trim() }));
      lines.push(line);
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

const toMs = (m, s, frac = '0') => Number(m) * 60_000 + Number(s) * 1000 + Number(String(frac).padEnd(3, '0'));
