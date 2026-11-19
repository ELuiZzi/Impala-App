/**
 * Lector de feeds para las suscripciones: canales de YouTube (Atom de youtube.com/feeds/videos.xml) y podcasts
 * (RSS 2.0 con las etiquetas de iTunes). Sin dependencias ni APIs de React Native: también corre en Node para
 * las pruebas (app/test/subscriptions.test.mjs). No es un lector de XML completo: busca las etiquetas que usan
 * estos feeds, que es lo que necesita y resiste mejor feeds con XML algo roto.
 */

export type FeedKind = 'youtube' | 'podcast';

export type Episode = {
  /** Estable entre lecturas: el id del video, o el guid / enlace del audio del podcast. */
  id: string;
  title: string;
  /** Fecha ISO de publicación (o null si el feed no la trae o no se entiende). */
  published: string | null;
  durationSec: number | null;
  /** Imagen del episodio (miniatura del video o carátula del episodio). */
  image: string | null;
  /** YouTube: id del video, para pedir su audio. */
  videoId: string | null;
  /** Podcast: enlace directo al audio. */
  audioUrl: string | null;
  /** Texto plano, como mucho DESCRIPTION_MAX caracteres. */
  description: string;
  /** YouTube: es un Short (vídeo vertical de menos de 1-3 min). */
  short: boolean;
};

export type Feed = {
  kind: FeedKind;
  title: string;
  author: string | null;
  image: string | null;
  /** Página del canal o del podcast. */
  link: string | null;
  /** Del más nuevo al más viejo; como mucho `limit`. */
  episodes: Episode[];
};

export class FeedError extends Error {}

export const DEFAULT_LIMIT = 100;
const DESCRIPTION_MAX = 400;

// --- XML mínimo ------------------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  hearts: '♥', bull: '•', middot: '·', deg: '°', euro: '€', iexcl: '¡', iquest: '¿',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í',
  Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', agrave: 'à', egrave: 'è',
  ccedil: 'ç', Ccedil: 'Ç', ouml: 'ö', auml: 'ä', ocirc: 'ô', acirc: 'â', ecirc: 'ê', atilde: 'ã', otilde: 'õ',
};

/** &amp; &#233; &#xE9; &oacute;… → texto. Las entidades desconocidas se dejan como están. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code] ?? whole;
  });
}

/** Título en una línea, sin espacios repetidos. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Contenido de texto: quita CDATA y decodifica entidades. */
function textOf(raw: string | null): string {
  if (raw == null) return '';
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))).trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Interior de la primera <tag …>…</tag> (o '' si es <tag/>); null si no está. */
function inner(xml: string, tag: string): string | null {
  const t = escapeRe(tag);
  const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${t}\\s*>)`, 'i'));
  return m ? (m[1] ?? '') : null;
}

/** Atributo de la primera etiqueta <tag …> que lo tenga (opcionalmente con otro atributo exigido). */
function attr(xml: string, tag: string, name: string, where?: [string, string]): string | null {
  const re = new RegExp(`<${escapeRe(tag)}(\\s[^>]*?)/?>`, 'gi');
  for (const m of xml.matchAll(re)) {
    const attrs = m[1];
    if (where && getAttr(attrs, where[0]) !== where[1]) continue;
    const v = getAttr(attrs, name);
    if (v != null) return decodeEntities(v);
  }
  return null;
}

function getAttr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\s${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
}

/** Cada bloque <tag>…</tag> del documento (solo hasta `max`, para feeds enormes). */
function blocks(xml: string, tag: string, max: number): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${escapeRe(tag)}[\\s>]`, 'gi');
  const close = `</${tag}>`;
  let m: RegExpExecArray | null;
  while (out.length < max && (m = open.exec(xml))) {
    const end = xml.indexOf(close, m.index);
    if (end < 0) break;
    out.push(xml.slice(m.index, end));
    open.lastIndex = end + close.length;
  }
  return out;
}

/** HTML de una descripción → texto plano corto. */
export function plainText(html: string, max = DESCRIPTION_MAX): string {
  const text = decodeEntities(
    html
      .replace(/<(br|\/p|\/li|\/div)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// --- Fechas y duraciones ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7 };

/**
 * Fecha ISO 8601 (Atom) o RFC 822 (RSS: «Tue, 17 Nov 2026 08:00:00 +0000») → ISO. A mano porque el
 * Date.parse de Hermes (Android) no entiende RFC 822.
 */
export function parseDate(s: string | null): string | null {
  if (!s) return null;
  const v = s.trim();
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (iso) {
    const [, y, mo, d, h = '0', mi = '0', sec = '0', zone] = iso;
    return build(+y, +mo - 1, +d, +h, +mi, +sec, zoneMinutes(zone ?? 'Z'));
  }
  const rfc = v.match(/^(?:[a-z]{3},?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{4}|[a-z]{1,5})?/i);
  if (rfc) {
    const [, d, mon, yy, h = '0', mi = '0', sec = '0', zone] = rfc;
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    const year = yy.length === 2 ? 2000 + +yy : +yy;
    return build(year, month, +d, +h, +mi, +sec, zoneMinutes(zone ?? 'GMT'));
  }
  return null;
}

function zoneMinutes(zone: string): number | null {
  if (/^[+-]\d{2}:?\d{2}$/.test(zone)) {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.replace(':', '');
    return sign * (+digits.slice(1, 3) * 60 + +digits.slice(3, 5));
  }
  const hours = ZONES[zone.toUpperCase()];
  return hours === undefined ? 0 : hours * 60;
}

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, offsetMin: number | null): string | null {
  const ms = Date.UTC(y, mo, d, h, mi, s) - (offsetMin ?? 0) * 60_000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** «1:02:03», «62:03», «3723» o «3723.5» → segundos. */
export function parseDuration(s: string | null): number | null {
  if (!s) return null;
  const v = s.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v)) || null;
  const parts = v.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0) || null;
}

// --- Feeds -----------------------------------------------------------------------------------------

const byNewest = (a: Episode, b: Episode) => (b.published ?? '').localeCompare(a.published ?? '');

/** Atom de un canal de YouTube. */
export function parseYoutubeFeed(xml: string, limit = DEFAULT_LIMIT): Feed {
  const head = xml.slice(0, Math.max(0, xml.search(/<entry[\s>]/i)) || xml.length);
  const channelId = textOf(inner(head, 'yt:channelId'));
  const episodes: Episode[] = [];
  for (const e of blocks(xml, 'entry', limit)) {
    const videoId = textOf(inner(e, 'yt:videoId'));
    if (!videoId) continue;
    const link = attr(e, 'link', 'href', ['rel', 'alternate']) ?? '';
    episodes.push({
      id: videoId,
      title: oneLine(textOf(inner(e, 'title'))),
      published: parseDate(textOf(inner(e, 'published'))),
      durationSec: null,
      // hqdefault es 4:3 con bandas negras; mqdefault (320×180) es el mismo fotograma en 16:9.
      image: attr(e, 'media:thumbnail', 'url')?.replace(/\/hqdefault\.jpg$/, '/mqdefault.jpg') ?? null,
      videoId,
      audioUrl: null,
      description: plainText(textOf(inner(e, 'media:description'))),
      short: link.includes('/shorts/'),
    });
  }
  if (!episodes.length && !/<feed[\s>]/i.test(xml)) throw new FeedError('No es un feed de YouTube');
  return {
    kind: 'youtube',
    title: textOf(inner(head, 'title')) || 'Canal de YouTube',
    author: textOf(inner(inner(head, 'author') ?? '', 'name')) || null,
    image: null, // el feed no trae la foto del canal; se pide aparte (resolve.ts)
    link: attr(head, 'link', 'href', ['rel', 'alternate']) ?? (channelId ? `https://www.youtube.com/channel/UC${channelId}` : null),
    episodes: episodes.sort(byNewest),
  };
}

/**
 * RSS 2.0 de un podcast. Solo cuentan los <item> con audio (<enclosure> de tipo audio, o sin tipo). Se leen
 * como mucho `limit * 2` items (feeds de miles de episodios) y se quedan los `limit` más nuevos.
 */
export function parsePodcastFeed(xml: string, limit = DEFAULT_LIMIT): Feed {
  if (!/<rss[\s>]/i.test(xml) && !/<channel[\s>]/i.test(xml)) throw new FeedError('No es un feed de podcast (RSS)');
  const firstItem = xml.search(/<item[\s>]/i);
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const channelImage = attr(head, 'itunes:image', 'href') ?? textOf(inner(inner(head, 'image') ?? '', 'url')) ?? null;
  const episodes: Episode[] = [];
  for (const item of blocks(xml, 'item', limit * 2)) {
    const type = attr(item, 'enclosure', 'type');
    const audioUrl = attr(item, 'enclosure', 'url');
    if (!audioUrl || (type && !/^audio\//i.test(type) && !/mpeg|mp3|m4a|aac|ogg|opus/i.test(type))) continue;
    const guid = textOf(inner(item, 'guid'));
    episodes.push({
      id: guid || audioUrl,
      title: oneLine(textOf(inner(item, 'itunes:title')) || textOf(inner(item, 'title'))) || 'Episodio',
      published: parseDate(textOf(inner(item, 'pubDate'))),
      durationSec: parseDuration(textOf(inner(item, 'itunes:duration'))),
      image: attr(item, 'itunes:image', 'href') ?? channelImage,
      videoId: null,
      audioUrl,
      description: plainText(textOf(inner(item, 'itunes:summary')) || textOf(inner(item, 'description'))),
      short: false,
    });
  }
  return {
    kind: 'podcast',
    title: textOf(inner(head, 'title')) || 'Podcast',
    author: textOf(inner(head, 'itunes:author')) || null,
    image: channelImage || null,
    link: textOf(inner(head, 'link')) || null,
    episodes: episodes.sort(byNewest).slice(0, limit),
  };
}

/** Lee el feed según lo que sea (Atom de YouTube o RSS). */
export function parseFeed(xml: string, limit = DEFAULT_LIMIT): Feed {
  if (/<yt:videoId>|xmlns:yt=/i.test(xml.slice(0, 4000)) || /<feed[\s>]/i.test(xml.slice(0, 2000))) return parseYoutubeFeed(xml, limit);
  return parsePodcastFeed(xml, limit);
}

// --- Qué pegó el usuario ---------------------------------------------------------------------------

export type SourceInput =
  | { kind: 'youtube-channel'; channelId: string }
  /** Enlace de un video: la suscripción es a su canal. */
  | { kind: 'youtube-video'; videoId: string }
  /** Un enlace de YouTube que hay que resolver (p. ej. @usuario): ver resolve.ts. */
  | { kind: 'youtube-url'; url: string }
  | { kind: 'podcast'; url: string }
  | { kind: 'invalid'; reason: string };

const CHANNEL_ID = /^UC[\w-]{22}$/;

/** Clasifica lo que se pegó: id de canal, enlace de YouTube o enlace de un feed de podcast. */
export function classifyInput(raw: string): SourceInput {
  const v = raw.trim();
  if (CHANNEL_ID.test(v)) return { kind: 'youtube-channel', channelId: v };
  if (/^@[\w.-]{3,}$/.test(v)) return { kind: 'youtube-url', url: `https://www.youtube.com/${v}` };
  let url: URL;
  try {
    url = new URL(/^[a-z][\w+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { kind: 'invalid', reason: 'Pega el enlace de un canal de YouTube o de un podcast' };
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtube.com' || host === 'youtu.be') {
    const fromFeed = url.pathname === '/feeds/videos.xml' ? url.searchParams.get('channel_id') : null;
    if (fromFeed && CHANNEL_ID.test(fromFeed)) return { kind: 'youtube-channel', channelId: fromFeed };
    const direct = url.pathname.match(/^\/channel\/(UC[\w-]{22})/);
    if (direct) return { kind: 'youtube-channel', channelId: direct[1] };
    const video =
      (host === 'youtu.be' ? url.pathname.slice(1) : null) ??
      (url.pathname === '/watch' ? url.searchParams.get('v') : null) ??
      url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] ??
      null;
    if (video && /^[\w-]{11}$/.test(video)) return { kind: 'youtube-video', videoId: video };
    if (/^\/(@[\w.-]+|c\/|user\/)/.test(url.pathname)) return { kind: 'youtube-url', url: `https://www.youtube.com${url.pathname}` };
    return { kind: 'invalid', reason: 'No se reconoce ese enlace de YouTube: copia el enlace del canal o de uno de sus videos' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid', reason: 'El enlace debe empezar por https://' };
  if (!url.hostname.includes('.')) return { kind: 'invalid', reason: 'Pega el enlace de un canal de YouTube o de un podcast' };
  return { kind: 'podcast', url: url.href };
}

export const youtubeFeedUrl = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

/**
 * Une los episodios guardados con los recién leídos: los del feed mandan (títulos o imágenes corregidos), los
 * viejos que ya no salen en el feed se conservan (el de YouTube solo trae los últimos 15). Más nuevos primero,
 * como mucho `keep`.
 */
export function mergeEpisodes(saved: Episode[], fresh: Episode[], keep = DEFAULT_LIMIT): Episode[] {
  const byId = new Map<string, Episode>();
  for (const e of saved) byId.set(e.id, e);
  for (const e of fresh) byId.set(e.id, { ...byId.get(e.id), ...e });
  return [...byId.values()].sort(byNewest).slice(0, keep);
}
