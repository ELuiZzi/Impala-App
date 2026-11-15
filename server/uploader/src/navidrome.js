import { httpError } from './auth.js';
import { bestMatch, coreTitle } from './match.js';

/**
 * Llamadas a la API Subsonic de Navidrome con las credenciales del usuario (u, t, s), por la red
 * interna de Docker. `client` es el nombre de cliente con el que Navidrome registra las llamadas.
 */
export function createSubsonic({ navidromeUrl, client, fetchImpl = fetch }) {
  return async function subsonic(creds, endpoint, params = {}) {
    if (!navidromeUrl) throw httpError(503, 'Navidrome no está configurado');
    const { u, t, s } = creds ?? {};
    if (typeof u !== 'string' || typeof t !== 'string' || typeof s !== 'string') {
      throw httpError(400, 'Esta operación requiere las credenciales Subsonic de la app');
    }
    const query = new URLSearchParams({ u, t, s, v: '1.16.1', c: client, f: 'json' });
    // Los arrays se envían como parámetros repetidos (songId=1&songId=2), como exige Subsonic.
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) query.append(key, String(v));
    }
    let body;
    try {
      const res = await fetchImpl(`${navidromeUrl}/rest/${endpoint}?${query}`, { signal: AbortSignal.timeout(10_000) });
      body = (await res.json())['subsonic-response'];
    } catch {
      throw httpError(503, 'Navidrome no responde');
    }
    if (body?.status !== 'ok') {
      throw httpError(body?.error?.code === 70 ? 404 : 502, body?.error?.message ?? 'Respuesta inválida de Navidrome');
    }
    return body;
  };
}

/**
 * Una canción recién descargada, ya en Navidrome: por la ruta del archivo (`file`, p. ej.
 * "Todo/Artista - Título.opus") o, si Navidrome no reporta rutas reales, por título y artista.
 * null si aún no la ha indexado.
 */
export async function findSongByFile(subsonic, creds, { title, artist, durationSec, file }) {
  const query = coreTitle(title) || title;
  const { searchResult3 } = await subsonic(creds, 'search3', { query, songCount: 50, albumCount: 0, artistCount: 0 });
  const songs = searchResult3?.song ?? [];
  const byPath = songs.find((s) => typeof s.path === 'string' && file && s.path.endsWith(file));
  return byPath ?? bestMatch({ title, artist, durationSec }, songs.map((s) => ({ ...s, durationSec: s.duration })));
}
