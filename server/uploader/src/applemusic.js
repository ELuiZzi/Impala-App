import { httpError } from './auth.js';

/** music.apple.com/{país}/playlist/{nombre opcional}/{pl.…}; los enlaces compartidos son iguales. */
const PLAYLIST_URL = /^https:\/\/(?:embed\.|beta\.)?music\.apple\.com\/([a-z]{2})\/playlist\/(?:[^/?#]+\/)?(pl\.[A-Za-z0-9_-]{8,80})(?:[/?#]|$)/i;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 8 * 1024 ** 2;
const MAX_TRACKS = 1000;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
/** La página web trae como mucho estas canciones (y su cabecera dice este mismo total aunque haya más). */
const PAGE_CAP = 300;
/** La API que usa la web de Apple Music para ir cargando las canciones de 100 en 100 al bajar por la lista. */
const AMP_API = 'https://amp-api.music.apple.com/v1/catalog';
const AMP_PAGE = 100;
/** " - Single", " - EP": Apple los añade al nombre del álbum; no forman parte del título real. */
const RELEASE_SUFFIX = /\s+-\s+(Single|EP)$/i;

export function parsePlaylistUrl(input) {
  const text = String(input ?? '').trim();
  if (/music\.apple\.com\/library\//i.test(text)) {
    throw httpError(400, 'Es un enlace de tu biblioteca de Apple Music (privado). Usa Compartir playlist → Copiar para obtener el enlace público');
  }
  const m = PLAYLIST_URL.exec(text);
  if (!m) throw httpError(400, 'No es un enlace de playlist de Apple Music (music.apple.com/…/playlist/…)');
  const storefront = m[1].toLowerCase();
  return { storefront, id: m[2], url: `https://music.apple.com/${storefront}/playlist/${m[2]}` };
}

/**
 * Lee una playlist pública de Apple Music: { name, curator, artwork, trackCount, tracks }.
 * Sin `token` se usa la página web (los datos que la propia web incrusta en "serialized-server-data");
 * con un token de desarrollador de MusicKit se usa la API oficial, que pagina playlists enormes.
 */
export async function readApplePlaylist(input, { fetchImpl = fetch, token = null } = {}) {
  const ref = parsePlaylistUrl(input);
  return token ? readFromApi(ref, token, fetchImpl) : readFromPage(ref, fetchImpl);
}

async function readFromPage(ref, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(ref.url, {
      headers: { 'user-agent': BROWSER_UA, 'accept-language': 'es,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch {
    throw httpError(502, 'No se pudo conectar con Apple Music');
  }
  if (res.status === 404) throw httpError(404, 'Apple Music no encontró la playlist. ¿Es pública?');
  if (!res.ok) throw httpError(502, `Apple Music respondió HTTP ${res.status}`);
  const html = await res.text();
  if (html.length > MAX_PAGE_BYTES) throw httpError(502, 'La página de Apple Music es demasiado grande');
  const playlist = parsePlaylistPage(html);
  // La página solo trae las 300 primeras: el resto se pide como lo hace la propia web al bajar por la lista.
  if (playlist.capped || playlist.trackCount > playlist.tracks.length) {
    try {
      const all = await readFromWebApi(ref, html, fetchImpl);
      if (all.length > playlist.tracks.length) {
        playlist.tracks = all;
        playlist.trackCount = Math.max(playlist.trackCount, all.length);
      }
      playlist.capped = false;
    } catch (e) {
      // Si falla, se importa lo que trae la página y el aviso lo explica.
      console.warn('Apple Music: no se pudieron leer las demás canciones:', e?.message ?? e);
    }
  }
  return playlist;
}

/** Todas las canciones (hasta MAX_TRACKS) con la API de la web, usando el token que la web lleva en su JavaScript. */
async function readFromWebApi(ref, html, fetchImpl) {
  const token = await webToken(html, fetchImpl);
  const items = [];
  for (let offset = 0; offset < MAX_TRACKS; offset += AMP_PAGE) {
    const res = await fetchImpl(`${AMP_API}/${ref.storefront}/playlists/${encodeURIComponent(ref.id)}/tracks?offset=${offset}&limit=${AMP_PAGE}`, {
      headers: { authorization: `Bearer ${token}`, origin: 'https://music.apple.com', 'user-agent': BROWSER_UA },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.status === 404 && offset > 0) break; // pasada la última canción
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = (await res.json())?.data ?? [];
    items.push(...page);
    if (page.length < AMP_PAGE) break;
  }
  return apiTracks(items);
}

/** El token anónimo de la web de Apple Music: un JWT dentro de su JavaScript principal (/assets/index~….js). */
async function webToken(html, fetchImpl) {
  const src = /<script[^>]+src="(\/assets\/index[^"]*\.js)"/.exec(html)?.[1];
  if (!src) throw new Error('No se encontró el JavaScript de la web');
  const res = await fetchImpl(`https://music.apple.com${src}`, { headers: { 'user-agent': BROWSER_UA }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} al leer la web`);
  const js = await res.text();
  const now = Date.now() / 1000;
  const token = [...new Set(js.match(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g) ?? [])].find((t) => {
    try {
      const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
      return payload?.iss === 'AMPWebPlay' && (!payload.exp || payload.exp > now);
    } catch {
      return false;
    }
  });
  if (!token) throw new Error('No se encontró el token de la web');
  return token;
}

/** Canciones de la API de Apple Music (la oficial y la de la web devuelven lo mismo). */
function apiTracks(items) {
  return items
    .map(({ attributes: a = {} } = {}) => ({
      title: String(a.name ?? '').trim(),
      artist: String(a.artistName ?? '').trim(),
      album: cleanAlbum(a.albumName),
      durationSec: Number.isFinite(a.durationInMillis) ? Math.round(a.durationInMillis / 1000) : null,
      explicit: a.contentRating === 'explicit',
      artwork: artworkUrl(a.artwork?.url, 300),
    }))
    .filter((t) => t.title && t.artist)
    .slice(0, MAX_TRACKS);
}

/** Extrae la playlist del JSON que la web de Apple Music incrusta en la página. */
export function parsePlaylistPage(html) {
  const m = /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw httpError(502, 'La página de Apple Music cambió de formato');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw httpError(502, 'La página de Apple Music cambió de formato');
  }
  const page = (Array.isArray(data) ? data[0] : data?.data?.[0])?.data;
  const sections = page?.sections ?? [];
  const header = sections.find((s) => s.itemKind === 'containerDetailHeaderLockup')?.items?.[0];
  const items = sections.filter((s) => s.itemKind === 'trackLockup').flatMap((s) => s.items ?? []);

  const tracks = items
    .map((it) => ({
      title: String(it.title ?? '').trim(),
      artist: String(it.artistName ?? (it.subtitleLinks ?? []).map((l) => l.title).filter(Boolean).join(', ')).trim(),
      album: cleanAlbum(it.tertiaryLinks?.[0]?.title),
      durationSec: Number.isFinite(it.duration) ? Math.round(it.duration / 1000) : null,
      explicit: !!it.showExplicitBadge,
      artwork: artworkUrl(it.artwork?.dictionary?.url, 300),
    }))
    .filter((t) => t.title && t.artist)
    .slice(0, MAX_TRACKS);
  if (tracks.length === 0) throw httpError(422, 'No se encontraron canciones en la playlist');

  return {
    name: String(header?.title ?? 'Playlist de Apple Music').trim(),
    curator: header?.subtitleLinks?.[0]?.title ?? null,
    artwork: artworkUrl(header?.artwork?.dictionary?.url, 600),
    trackCount: Number.isInteger(header?.trackCount) ? header.trackCount : tracks.length,
    capped: items.length >= PAGE_CAP,
    tracks,
  };
}

async function readFromApi(ref, token, fetchImpl) {
  const get = async (pathAndQuery) => {
    let res;
    try {
      res = await fetchImpl(`https://api.music.apple.com${pathAndQuery}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch {
      throw httpError(502, 'No se pudo conectar con la API de Apple Music');
    }
    if (res.status === 404) throw httpError(404, 'Apple Music no encontró la playlist. ¿Es pública?');
    if (res.status === 401 || res.status === 403) throw httpError(502, 'El token de Apple Music no es válido o caducó');
    if (!res.ok) throw httpError(502, `La API de Apple Music respondió HTTP ${res.status}`);
    return res.json();
  };

  const body = await get(`/v1/catalog/${ref.storefront}/playlists/${encodeURIComponent(ref.id)}?include=tracks&l=es-MX`);
  const playlist = body.data?.[0];
  if (!playlist) throw httpError(404, 'Apple Music no encontró la playlist');
  const items = [...(playlist.relationships?.tracks?.data ?? [])];
  let next = playlist.relationships?.tracks?.next;
  while (next && items.length < MAX_TRACKS) {
    const page = await get(next);
    items.push(...(page.data ?? []));
    next = page.next;
  }
  const tracks = apiTracks(items);
  if (tracks.length === 0) throw httpError(422, 'No se encontraron canciones en la playlist');
  return {
    name: String(playlist.attributes?.name ?? 'Playlist de Apple Music').trim(),
    curator: playlist.attributes?.curatorName ?? null,
    artwork: artworkUrl(playlist.attributes?.artwork?.url, 600),
    trackCount: tracks.length,
    tracks,
  };
}

function cleanAlbum(name) {
  const album = String(name ?? '').replace(RELEASE_SUFFIX, '').trim();
  return album || null;
}

/** Las carátulas de Apple son plantillas: ".../{w}x{h}bb.{f}". */
function artworkUrl(template, size) {
  if (typeof template !== 'string' || !template.startsWith('https://')) return null;
  return template.replace('{w}', size).replace('{h}', size).replace('{f}', 'jpg').replace('{c}', 'bb');
}
