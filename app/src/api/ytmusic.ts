/**
 * YouTube Music y YouTube desde el teléfono: búsqueda, álbumes y artistas con el mismo formato que
 * devuelve el servidor (ytmusic.py + youtube.js), así la app no nota de dónde vienen. Los parsers
 * siguen a ytmusicapi: recorren el JSON de InnerTube por rutas fijas y, si YouTube cambia la forma de
 * sus respuestas, fallan y la app pregunta al servidor (ytmusicapi se actualiza solo).
 */
import { music, player, youtube, YoutubeError } from './innertube';

export type YoutubeResult = {
  /** song: pista de audio de YouTube Music (la del álbum); video: búsqueda general de YouTube. */
  kind: 'song' | 'video';
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  explicit: boolean;
  /** Canal que lo subió: distingue el audio oficial de las resubidas. */
  channel: string | null;
  durationSec: number | null;
  views: number | null;
  thumbnail: string;
};

/** Álbum de YouTube Music (también EP y sencillos). */
export type YoutubeAlbum = {
  id: string;
  title: string;
  artist: string | null;
  year: number | null;
  type: string | null;
  explicit: boolean;
  thumbnail: string | null;
};

export type YoutubeAlbumTrack = YoutubeResult & { trackNumber: number | null };
export type YoutubeAlbumDetail = YoutubeAlbum & { cover: string | null; tracks: YoutubeAlbumTrack[] };

/** Artista en los resultados de búsqueda de YouTube Music. */
export type YoutubeArtistResult = { id: string; name: string; thumbnail: string | null };

/** Página de un artista de YouTube Music: lo más escuchado ahora, álbumes y sencillos. */
export type YoutubeArtist = {
  id: string;
  name: string | null;
  /** Foto apaisada de la cabecera. */
  image: string | null;
  songs: YoutubeResult[];
  albums: YoutubeAlbum[];
  singles: YoutubeAlbum[];
};

export type SearchResponse = { results: YoutubeResult[]; albums?: YoutubeAlbum[]; artists?: YoutubeArtistResult[] };

const SONG_LIMIT = 15;
const ALBUM_LIMIT = 8;
const ARTIST_LIMIT = 4;
const TOP_SONGS = 25;
const VIDEO_LIMIT = 10;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ALBUM_ID = /^MPRE[A-Za-z0-9_-]{4,60}$/;
const ARTIST_ID = /^UC[A-Za-z0-9_-]{10,40}$/;
/** watch?v=, youtu.be/, shorts/, embed/, live/ (también music.youtube.com y m.youtube.com). */
const VIDEO_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/))([A-Za-z0-9_-]{11})/i;

/** Filtros de la búsqueda de YouTube Music (los params de ytmusicapi). */
const MUSIC_FILTER = {
  songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF',
  albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF',
  artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF',
};
/** Búsqueda de YouTube: solo videos. */
const VIDEOS_FILTER = 'EgIQAQ%3D%3D';

// --- Navegación por el JSON de InnerTube -------------------------------------------------------

type Path = (string | number)[];
type Ref = { name: string | null; id: string | null };

/** nav(x, ['a', 0, 'b']) → x.a[0].b, o undefined si falta algo por el camino. */
function nav(root: any, path: Path): any {
  let node = root;
  for (const key of path) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

const TITLE: Path = ['title', 'runs', 0];
const TITLE_TEXT: Path = [...TITLE, 'text'];
const BROWSE_ID: Path = ['navigationEndpoint', 'browseEndpoint', 'browseId'];
const PAGE_TYPE: Path = ['browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType'];
const PLAY_BUTTON: Path = ['overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer'];
const PLAY_VIDEO_ID: Path = [...PLAY_BUTTON, 'playNavigationEndpoint', 'watchEndpoint', 'videoId'];
const THUMBNAILS: Path = ['thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'];
const THUMBNAIL_RENDERER: Path = ['thumbnailRenderer', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'];
const BADGE: Path = [0, 'musicInlineBadgeRenderer', 'accessibilityData', 'accessibilityData', 'label'];
const SECTION_LIST: Path = ['sectionListRenderer', 'contents'];
const SINGLE_COLUMN_TAB: Path = ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content'];
const TWO_COLUMN: Path = ['contents', 'twoColumnBrowseResultsRenderer'];
const CAROUSEL_TITLE: Path = ['header', 'musicCarouselShelfBasicHeaderRenderer', 'title', 'runs', 0];
const GREY_OUT = 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT';

const explicitBadge = (data: any, key = 'badges') => nav(data, [key, ...BADGE]) != null;
const isAvailable = (data: any) => data.musicItemRendererDisplayPolicy !== GREY_OUT;

/** Columna `index` de una fila (musicResponsiveListItemRenderer), si tiene texto. */
function flexColumn(item: any, index: number): any | null {
  const column = item?.flexColumns?.[index]?.musicResponsiveListItemFlexColumnRenderer;
  return column?.text?.runs ? column : null;
}

const itemText = (item: any, index: number, run = 0): string | null => flexColumn(item, index)?.text.runs[run]?.text ?? null;

/** "3:44" → 224 */
function parseDuration(text: string | null | undefined): number | null {
  if (!text || !text.trim()) return null;
  const parts = text.trim().split(':');
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reverse().reduce((sum, p, i) => sum + Number(p) * ([1, 60, 3600][i] ?? 0), 0);
}

// Palabra o marca bidi antes de la cifra en escrituras no latinas ("조회수 17억회").
const VIEWS_PREFIX = /^\D*?[\s:\uff1a\u200e-\u200f\u202a-\u202e]/;

/** "137M plays" → "137M"; null si el texto no es un número de reproducciones. */
function parseViews(text: string): string | null {
  let prefixed = false;
  if (!/[a-zA-Z]/.test(text)) {
    const stripped = text.replace(VIEWS_PREFIX, '');
    prefixed = stripped !== text;
    text = stripped;
  }
  if (!/^\d/.test(text)) return null;
  // "2Pac" es un artista, no una cifra sin su palabra.
  if (!prefixed && /^[\x00-\x7f]*$/.test(text) && !text.includes(' ')) return null;
  return text.split(' ')[0].split('\xa0').slice(0, 2).join('\xa0');
}

type SongRun = { type: 'album' | 'artist'; data: Ref } | { type: 'duration' | 'year' | 'views'; data: string };

function parseSongRun(run: any): SongRun {
  const text: string = run.text ?? '';
  if (run.navigationEndpoint) {
    const id: string | null = nav(run, BROWSE_ID) ?? null;
    const ref = { name: text, id };
    return id && (id.startsWith('MPRE') || id.includes('release_detail')) ? { type: 'album', data: ref } : { type: 'artist', data: ref };
  }
  if (/^(\d+:)*\d+:\d+$/.test(text)) return { type: 'duration', data: text };
  if (/^\d{4}$/.test(text)) return { type: 'year', data: text };
  const views = parseViews(text);
  if (views !== null) return { type: 'views', data: views };
  return { type: 'artist', data: { name: text, id: null } };
}

type SongInfo = { artists?: Ref[]; album?: Ref; durationSec?: number | null; year?: string };

const isDot = (run: any) => run?.text === ' • ' && Object.keys(run).length === 1;

/**
 * "Tame Impala • Currents • 3:37" → artistas, álbum, duración, año. Los separadores van en las
 * posiciones impares. Con skipTypeSpec se salta el tipo inicial ("Song • …", "Album • …").
 */
function parseSongRuns(runs: any[], skipTypeSpec = false): SongInfo {
  if (
    skipTypeSpec &&
    runs.length > 2 &&
    !runs[0].navigationEndpoint &&
    parseSongRun(runs[0]).type === 'artist' &&
    isDot(runs[1]) &&
    ['artist', 'duration', 'views', 'year'].includes(parseSongRun(runs[2]).type)
  ) {
    runs = runs.slice(2);
  }
  const info: SongInfo = {};
  runs.forEach((run, i) => {
    if (i % 2) return;
    const parsed = parseSongRun(run);
    if (parsed.type === 'album') info.album = parsed.data;
    else if (parsed.type === 'artist') (info.artists ??= []).push(parsed.data);
    else if (parsed.type === 'duration') info.durationSec = parseDuration(parsed.data);
    else if (parsed.type === 'year') info.year = parsed.data;
  });
  return info;
}

/** Nombres e ids de artistas, saltando los separadores. */
function parseArtistsRuns(runs: any[]): Ref[] {
  const artists: Ref[] = [];
  for (let i = 0; i < runs.length; i += 2) artists.push({ name: runs[i].text ?? null, id: nav(runs[i], BROWSE_ID) ?? null });
  return artists;
}

const artistNames = (artists: Ref[] | null | undefined) =>
  (artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || null;

/** Las miniaturas de YouTube Music son la carátula cuadrada; se piden a `size` px. */
function thumbnail(thumbnails: any[] | null | undefined, size = 226): string | null {
  const url: string = thumbnails?.length ? (thumbnails[thumbnails.length - 1]?.url ?? '') : '';
  return url.replace(/=w\d+-h\d+/g, `=w${size}-h${size}`) || null;
}

// --- Resultados con la forma de la app --------------------------------------------------------

type RawSong = {
  id: string | null;
  title: string | null;
  artists: Ref[] | null | undefined;
  album: string | null | undefined;
  durationSec: number | null | undefined;
  explicit: boolean;
  thumbnail: string | null;
};

function songResult(r: RawSong & { id: string }): YoutubeResult {
  return {
    kind: 'song',
    id: r.id,
    title: r.title ?? 'Sin título',
    artist: artistNames(r.artists),
    album: r.album ?? null,
    channel: null,
    durationSec: r.durationSec ?? null,
    views: null,
    explicit: r.explicit,
    thumbnail: r.thumbnail ?? `https://i.ytimg.com/vi/${r.id}/hqdefault.jpg`,
  };
}

const playable = <T extends { id: string | null; available: boolean }>(list: T[]) =>
  list.filter((s): s is T & { id: string } => !!s.id && VIDEO_ID.test(s.id) && s.available);

type RawAlbum = { id: unknown; title: string | null; artist: string | null; year: string | null | undefined; type: string | null | undefined; explicit: boolean; thumbnail: string | null };

function albumResult(a: RawAlbum & { id: string }): YoutubeAlbum {
  const year = Number.parseInt(a.year ?? '', 10);
  return {
    id: a.id,
    title: a.title ?? 'Sin título',
    artist: a.artist ?? null,
    year: Number.isFinite(year) ? year : null,
    // "Album", "EP", "Single"…
    type: a.type ?? null,
    explicit: a.explicit,
    thumbnail: a.thumbnail ?? null,
  };
}

const albums = (list: RawAlbum[]) => list.filter((a): a is RawAlbum & { id: string } => typeof a.id === 'string' && ALBUM_ID.test(a.id)).map(albumResult);

// --- Búsqueda de YouTube Music -----------------------------------------------------------------

/** Filas de una búsqueda con filtro (solo las estanterías de ese tipo). */
async function searchRows(query: string, filter: keyof typeof MUSIC_FILTER, signal?: AbortSignal): Promise<any[]> {
  const r = await music('search', { query, params: MUSIC_FILTER[filter] }, signal);
  const content = nav(r, ['contents', 'tabbedSearchResultsRenderer', 'tabs', 0, 'tabRenderer', 'content']) ?? r?.contents;
  const rows: any[] = [];
  for (const section of nav(content, SECTION_LIST) ?? []) {
    const shelf = section.musicShelfRenderer ?? section.itemSectionRenderer;
    const contents: any[] = shelf?.contents ?? [];
    if (!contents[0]?.musicResponsiveListItemRenderer) continue;
    // YouTube Music a veces añade una estantería de otro tipo (p. ej. "Songs" al filtrar álbumes).
    const category: string | undefined = section.musicShelfRenderer ? nav(shelf, TITLE_TEXT) : undefined;
    if (category && !category.toLowerCase().includes(filter.slice(0, -1))) continue;
    for (const c of contents) if (c.musicResponsiveListItemRenderer) rows.push(c.musicResponsiveListItemRenderer);
  }
  return rows;
}

/** Columnas 1 y 2 de un resultado ("Tame Impala • Currents • 3:37", "995M plays") como una sola lista. */
function resultRuns(data: any): any[] {
  const runs = [...(flexColumn(data, 1)?.text.runs ?? [])];
  const extra = flexColumn(data, 2);
  if (extra) runs.push({ text: '' }, ...extra.text.runs);
  return runs;
}

/** Canciones de YouTube Music: las pistas de audio oficiales (no videoclips ni resubidas). */
export async function searchSongs(query: string, signal?: AbortSignal): Promise<YoutubeResult[]> {
  const rows = await searchRows(query, 'songs', signal);
  const songs = rows.map((data) => {
    const info = parseSongRuns(resultRuns(data), true);
    return {
      id: nav(data, PLAY_VIDEO_ID) ?? null,
      title: itemText(data, 0),
      artists: info.artists,
      album: info.album?.name,
      durationSec: info.durationSec,
      explicit: explicitBadge(data),
      thumbnail: thumbnail(nav(data, THUMBNAILS)),
      available: isAvailable(data),
    };
  });
  return playable(songs).slice(0, SONG_LIMIT).map(songResult);
}

async function searchAlbums(query: string, signal?: AbortSignal): Promise<YoutubeAlbum[]> {
  const rows = await searchRows(query, 'albums', signal);
  const found = rows.map((data) => {
    const info = parseSongRuns(resultRuns(data), true);
    return {
      id: nav(data, BROWSE_ID),
      title: itemText(data, 0),
      artist: artistNames(info.artists),
      year: info.year,
      type: itemText(data, 1),
      explicit: explicitBadge(data),
      thumbnail: thumbnail(nav(data, THUMBNAILS)),
    };
  });
  return albums(found.filter((a) => a.id)).slice(0, ALBUM_LIMIT);
}

async function searchArtists(query: string, limit: number, signal?: AbortSignal): Promise<YoutubeArtistResult[]> {
  const rows = await searchRows(query, 'artists', signal);
  return rows
    .map((data) => ({ id: nav(data, BROWSE_ID), name: itemText(data, 0), thumbnail: thumbnail(nav(data, THUMBNAILS), 300) }))
    .filter((a): a is { id: string; name: string | null; thumbnail: string | null } => typeof a.id === 'string' && ARTIST_ID.test(a.id))
    .slice(0, limit)
    .map((a) => ({ id: a.id, name: a.name ?? 'Sin nombre', thumbnail: a.thumbnail }));
}

/**
 * Búsqueda en dos partes, como el servidor: `music` (canciones, álbumes y artistas de YouTube Music, en
 * paralelo) y `videos` (búsqueda general de YouTube). Un enlace pegado devuelve solo ese video, en la
 * parte que le toca: una pista de YouTube Music en `music` y un video en `videos`.
 */
export async function search(query: string, scope: 'music' | 'videos', signal?: AbortSignal): Promise<SearchResponse> {
  const q = query.trim();
  const linked = VIDEO_URL.exec(q)?.[1];
  if (linked) {
    const result = await linkedVideo(linked);
    return { results: (result.kind === 'song') === (scope === 'music') ? [result] : [], albums: [], artists: [] };
  }
  if (scope === 'videos') return { results: await searchVideos(q, signal), albums: [], artists: [] };
  const [songs, found, artists] = await Promise.all([
    searchSongs(q, signal),
    searchAlbums(q, signal),
    // Los artistas son un extra: sin ellos la búsqueda sirve igual.
    searchArtists(q, ARTIST_LIMIT, signal).catch(() => []),
  ]);
  return { results: songs, albums: found, artists };
}

// --- Álbumes -----------------------------------------------------------------------------------

type PlaylistItem = {
  id: string | null;
  title: string | null;
  artists: Ref[] | null;
  album: Ref | null;
  durationSec: number | null;
  explicit: boolean;
  available: boolean;
  thumbnails: any[] | undefined;
  trackNumber: number | null;
};

/**
 * Una fila de una lista de canciones (álbum, populares de un artista). En los álbumes las columnas son
 * fijas (título, artistas, reproducciones); en las listas se reconocen por su enlace.
 */
function parsePlaylistItem(data: any, isAlbum: boolean): PlaylistItem | null {
  const available = isAvailable(data);
  const preset = !available || isAlbum;
  let titleIndex: number | null = preset ? 0 : null;
  let artistIndex: number | null = preset ? 1 : null;
  let albumIndex: number | null = preset ? 2 : null;
  let durationIndex: number | null = null;
  let unrecognized: number | null = null;
  const userChannels: number[] = [];

  const columns = data.flexColumns?.length ?? 0;
  for (let index = 0; index < columns; index++) {
    const column = flexColumn(data, index);
    const endpoint = nav(column, ['text', 'runs', 0, 'navigationEndpoint']);
    if (!endpoint) {
      const run = nav(column, ['text', 'runs', 0]);
      if (run && 'text' in run) {
        if (parseSongRun(run).type === 'duration') durationIndex = index;
        else unrecognized ??= index;
      }
      continue;
    }
    if (endpoint.watchEndpoint) titleIndex = index;
    else if (endpoint.browseEndpoint) {
      const pageType = nav(endpoint, ['browseEndpoint', ...PAGE_TYPE]);
      if (pageType === 'MUSIC_PAGE_TYPE_ARTIST' || pageType === 'MUSIC_PAGE_TYPE_UNKNOWN') artistIndex = index;
      else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' || pageType === 'MUSIC_PAGE_TYPE_AUDIOBOOK') albumIndex = index;
      else if (pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL') userChannels.push(index);
      else if (pageType === 'MUSIC_PAGE_TYPE_NON_MUSIC_AUDIO_TRACK_PAGE') titleIndex = index;
    }
  }
  // Artista sin enlace o, en videos que no son canciones, el último canal.
  if (artistIndex === null && unrecognized !== null) artistIndex = unrecognized;
  if (artistIndex === null && userChannels.length > 0) artistIndex = userChannels[userChannels.length - 1];

  const title = titleIndex !== null ? itemText(data, titleIndex) : null;
  if (title === 'Song deleted') return null;
  const artistColumn = artistIndex !== null ? flexColumn(data, artistIndex) : null;
  const albumColumn = albumIndex !== null ? flexColumn(data, albumIndex) : null;

  let duration = durationIndex ? itemText(data, durationIndex) : null;
  if (data.fixedColumns) {
    const fixed = data.fixedColumns[0]?.musicResponsiveListItemFixedColumnRenderer?.text;
    duration = fixed?.simpleText ?? fixed?.runs?.[0]?.text ?? null;
  }
  const trackNumber = Number.parseInt(nav(data, ['index', 'runs', 0, 'text']) ?? '', 10);

  return {
    id: nav(data, PLAY_VIDEO_ID) ?? null,
    title,
    artists: artistIndex === null ? null : artistColumn ? parseArtistsRuns(artistColumn.text.runs) : [],
    album: albumColumn ? { name: albumColumn.text.runs[0]?.text ?? null, id: nav(albumColumn, ['text', 'runs', 0, ...BROWSE_ID]) ?? null } : null,
    durationSec: parseDuration(duration),
    explicit: explicitBadge(data),
    available,
    thumbnails: nav(data, THUMBNAILS),
    trackNumber: isAlbum && available && Number.isFinite(trackNumber) ? trackNumber : null,
  };
}

const parsePlaylistItems = (rows: any[], isAlbum = false) =>
  rows.flatMap((row) => (row.musicResponsiveListItemRenderer ? [parsePlaylistItem(row.musicResponsiveListItemRenderer, isAlbum)] : [])).filter((s): s is PlaylistItem => !!s);

/** Un álbum de YouTube Music (browseId "MPREb_…") con sus pistas reproducibles. */
export async function getAlbum(id: string, signal?: AbortSignal): Promise<YoutubeAlbumDetail> {
  if (!ALBUM_ID.test(id)) throw new YoutubeError('Identificador de álbum inválido');
  const r = await music('browse', { browseId: id }, signal);
  const header = nav(r, [...TWO_COLUMN, 'tabs', 0, 'tabRenderer', 'content', ...SECTION_LIST, 0, 'musicResponsiveHeaderRenderer']);
  const shelf = nav(r, [...TWO_COLUMN, 'secondaryContents', ...SECTION_LIST, 0, 'musicShelfRenderer']);
  if (!header || !shelf) throw new YoutubeError('YouTube Music respondió algo inesperado para este álbum');

  const title: string | null = nav(header, TITLE_TEXT) ?? null;
  const strapline = nav(header, ['straplineTextOne', 'runs']);
  const albumArtists = strapline ? parseArtistsRuns(strapline) : null;
  const thumbs = nav(header, THUMBNAILS);
  const cover = thumbnail(thumbs);
  const tracks = playable(parsePlaylistItems(shelf.contents ?? [], true)).map((t) => ({
    ...songResult({ ...t, artists: t.artists?.length ? t.artists : albumArtists, album: title, thumbnail: cover ?? thumbnail(t.thumbnails) }),
    trackNumber: t.trackNumber,
  }));
  const [album] = albums([
    {
      id,
      title,
      artist: artistNames(albumArtists),
      year: parseSongRuns((header.subtitle?.runs ?? []).slice(2)).year,
      type: nav(header, ['subtitle', 'runs', 0, 'text']),
      explicit: tracks.some((t) => t.explicit),
      thumbnail: cover,
    },
  ]);
  return { ...album, cover: thumbnail(thumbs, 544) ?? cover, tracks };
}

// --- Artistas ----------------------------------------------------------------------------------

/** Dónde pedir la lista completa de una sección de la página del artista (la portada trae unas pocas). */
export type ArtistMore = { songs?: string; albums?: { browseId: string; params: string }; singles?: { browseId: string; params: string } };

/** Página de un artista y las listas completas que faltan por pedir. */
export type ArtistPage = { artist: YoutubeArtist; more: ArtistMore };

/** "Album • 2020" o solo "2020" (álbumes y sencillos de la portada de un artista). */
function releaseSubtitle(data: any): { type?: string; year?: string } {
  const first: string | undefined = nav(data, ['subtitle', 'runs', 0, 'text']);
  if (!first) return {};
  if (/^\d+$/.test(first)) return { year: first };
  const year: string | undefined = nav(data, ['subtitle', 'runs', 2, 'text']);
  return { type: first, ...(year && /^\d+$/.test(year) ? { year } : {}) };
}

/** Un álbum o sencillo (musicTwoRowItemRenderer) de la página de un artista. */
function releaseItem(data: any, artist: string | null, withArtists: boolean): RawAlbum {
  const linked = withArtists ? (nav(data, ['subtitle', 'runs']) ?? []).filter((x: any) => x.navigationEndpoint) : [];
  const { type, year } = releaseSubtitle(data);
  return {
    id: nav(data, [...TITLE, ...BROWSE_ID]),
    title: nav(data, TITLE_TEXT) ?? null,
    artist: artistNames(linked.map((x: any) => ({ name: x.text ?? null, id: null }))) ?? artist,
    year,
    type,
    explicit: explicitBadge(data, 'subtitleBadges'),
    thumbnail: thumbnail(nav(data, THUMBNAIL_RENDERER)),
  };
}

/** Una sección de la portada del artista por su título ("albums", "singles & eps"). */
function carousel(sections: any[], title: string) {
  const shelf = sections.map((s) => s.musicCarouselShelfRenderer).find((c) => String(nav(c, [...CAROUSEL_TITLE, 'text']) ?? '').toLowerCase() === title);
  if (!shelf) return null;
  const header = nav(shelf, CAROUSEL_TITLE);
  const browseId = nav(header, BROWSE_ID);
  const params = nav(header, ['navigationEndpoint', 'browseEndpoint', 'params']);
  return {
    items: (shelf.contents ?? []).map((c: any) => c.musicTwoRowItemRenderer).filter(Boolean) as any[],
    more: browseId && params ? { browseId: String(browseId), params: String(params) } : undefined,
  };
}

/**
 * La portada de un artista: cabecera, las 5 canciones más escuchadas y los álbumes y sencillos que
 * muestra. Es una sola petición; las listas completas (25 populares, todos los sencillos) se piden
 * después con getArtistMore, para enseñar la página cuanto antes.
 */
export async function getArtistPage(id: string, signal?: AbortSignal): Promise<ArtistPage> {
  const channelId = id.replace(/^MPLA/, '');
  if (!ARTIST_ID.test(channelId)) throw new YoutubeError('Identificador de artista inválido');
  const r = await music('browse', { browseId: channelId }, signal);
  const sections: any[] | undefined =
    nav(r, [...SINGLE_COLUMN_TAB, ...SECTION_LIST]) ?? nav(r, [...TWO_COLUMN, 'tabs', 0, 'tabRenderer', 'content', ...SECTION_LIST]);
  const header = r?.header?.musicImmersiveHeaderRenderer ?? r?.header?.musicVisualHeaderRenderer;
  if (!sections || !header) throw new YoutubeError('YouTube Music respondió algo inesperado para este artista');
  const name: string | null = nav(header, TITLE_TEXT) ?? null;

  const songsShelf = sections[0]?.musicShelfRenderer;
  const top = songsShelf ? parsePlaylistItems(songsShelf.contents ?? []) : [];
  const songsMore = songsShelf ? nav(songsShelf, [...TITLE, ...BROWSE_ID]) : undefined;
  const albumsShelf = carousel(sections, 'albums');
  const singlesShelf = carousel(sections, 'singles & eps');
  const thumbs: any[] = nav(header, THUMBNAILS) ?? [];

  return {
    artist: {
      id: channelId,
      name,
      // Foto del artista (apaisada en la cabecera de YouTube Music).
      image: thumbs.length ? (thumbs[thumbs.length - 1]?.url ?? null) : null,
      songs: playableSongs(top),
      albums: albums((albumsShelf?.items ?? []).map((d) => releaseItem(d, name, true))),
      singles: albums((singlesShelf?.items ?? []).map((d) => releaseItem(d, name, false))),
    },
    more: {
      ...(typeof songsMore === 'string' ? { songs: songsMore } : {}),
      ...(albumsShelf?.more ? { albums: albumsShelf.more } : {}),
      ...(singlesShelf?.more ? { singles: singlesShelf.more } : {}),
    },
  };
}

const playableSongs = (items: PlaylistItem[]) =>
  playable(items)
    .slice(0, TOP_SONGS)
    .map((t) => songResult({ ...t, album: t.album?.name, thumbnail: thumbnail(t.thumbnails) }));

/** Las 25 canciones más escuchadas del artista (su lista "Top songs", en el orden de YouTube Music). */
async function topSongs(browseId: string, signal?: AbortSignal): Promise<YoutubeResult[]> {
  const r = await music('browse', { browseId }, signal);
  const shelf = nav(r, [...TWO_COLUMN, 'secondaryContents', ...SECTION_LIST, 0, 'musicPlaylistShelfRenderer']);
  if (!shelf) throw new YoutubeError('YouTube Music respondió algo inesperado para las canciones del artista');
  return playableSongs(parsePlaylistItems(shelf.contents ?? []));
}

/** Todos los álbumes o sencillos del artista (la portada solo enseña unos pocos). */
async function releases(more: { browseId: string; params: string }, artist: string | null, signal?: AbortSignal): Promise<YoutubeAlbum[]> {
  const r = await music('browse', { browseId: more.browseId, params: more.params }, signal);
  const section = nav(r, [...SINGLE_COLUMN_TAB, ...SECTION_LIST, 0]);
  const items: any[] = nav(section, ['gridRenderer', 'items']) ?? nav(section, ['musicCarouselShelfRenderer', 'contents']) ?? [];
  return albums(
    items
      .map((i) => i.musicTwoRowItemRenderer)
      .filter(Boolean)
      .map((data) => {
        const runs: any[] = nav(data, ['subtitle', 'runs']) ?? [];
        const info = parseSongRuns(runs.slice(2));
        return {
          id: nav(data, [...TITLE, ...BROWSE_ID]),
          title: nav(data, TITLE_TEXT) ?? null,
          artist: artistNames(info.artists) ?? artist,
          year: info.year,
          type: runs[0]?.text,
          explicit: explicitBadge(data, 'subtitleBadges'),
          thumbnail: thumbnail(nav(data, THUMBNAIL_RENDERER)),
        };
      }),
  );
}

/** Las listas completas de la página de un artista; una que falle se queda con lo de la portada. */
export async function getArtistMore(page: ArtistPage, signal?: AbortSignal): Promise<Partial<Pick<YoutubeArtist, 'songs' | 'albums' | 'singles'>>> {
  const { more, artist } = page;
  const keep = <T,>(promise: Promise<T> | null) => promise?.catch(() => undefined) ?? Promise.resolve(undefined);
  const [songs, all, singles] = await Promise.all([
    keep(more.songs ? topSongs(more.songs, signal) : null),
    keep(more.albums ? releases(more.albums, artist.name, signal) : null),
    keep(more.singles ? releases(more.singles, artist.name, signal) : null),
  ]);
  return {
    ...(songs?.length ? { songs } : {}),
    ...(all?.length ? { albums: all } : {}),
    ...(singles?.length ? { singles } : {}),
  };
}

/** "Beyoncé — HALO!" → "beyonce halo" (como fold() de ytmusic.py). */
const foldName = (text: string | null) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .trim();

/** El canal del artista de YouTube Music con ese nombre (el primero si ninguno coincide exacto), o null. */
export async function findArtistId(name: string, signal?: AbortSignal): Promise<string | null> {
  const candidates = await searchArtists(name, 5, signal);
  const exact = candidates.find((c) => foldName(c.name) === foldName(name));
  return (exact ?? candidates[0])?.id ?? null;
}

// --- Videos de YouTube -------------------------------------------------------------------------

const NOISE = /\s*[([][^)\]]*\b(official|oficial|video|vídeo|audio|lyrics?|letra|visuali[sz]er|hd|4k|mv|videoclip)\b[^)\]]*[)\]]/gi;

/** "Tame Impala - Topic" → "Tame Impala", "TameImpalaVEVO" → "TameImpala" */
function cleanChannel(name: string | null): string | null {
  if (!name) return null;
  return name.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').trim() || null;
}

/** Artista y título de un video: "Artista - Título (Official Video)" o, si no, el canal (como tagsFor del servidor). */
function videoTags(title: string, channel: string | null): { title: string; artist: string } {
  const clean = (title || 'Sin título').replace(NOISE, '').trim();
  const split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean);
  if (split) return { artist: split[1].trim(), title: split[2].trim() };
  return { artist: cleanChannel(channel) ?? 'Artista desconocido', title: clean };
}

const count = (text: string | undefined) => {
  const digits = (text ?? '').replace(/\D/g, '');
  return digits ? Number(digits) : null;
};

const runsText = (value: any): string => value?.simpleText ?? (value?.runs ?? []).map((r: any) => r.text ?? '').join('');

/** Búsqueda general de YouTube (videos), para versiones que solo existen ahí. */
async function searchVideos(query: string, signal?: AbortSignal): Promise<YoutubeResult[]> {
  const r = await youtube('search', { query, params: VIDEOS_FILTER }, signal);
  const sections: any[] | undefined = nav(r, ['contents', 'twoColumnSearchResultsRenderer', 'primaryContents', ...SECTION_LIST]);
  if (!sections) throw new YoutubeError('YouTube respondió algo inesperado a la búsqueda');
  // Directos y estrenos: no se pueden escuchar ni descargar. Las radios 24/7 ya no llevan la etiqueta
  // LIVE en la búsqueda, pero no tienen duración.
  const live = (v: any) =>
    !v.lengthText ||
    !!v.upcomingEventData ||
    (v.badges ?? []).some((b: any) => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW') ||
    (v.thumbnailOverlays ?? []).some((o: any) => o.thumbnailOverlayTimeStatusRenderer?.style === 'LIVE');
  return sections
    .flatMap((s) => s.itemSectionRenderer?.contents ?? [])
    .map((c) => c.videoRenderer)
    .filter((v) => v && VIDEO_ID.test(v.videoId ?? '') && !live(v))
    .slice(0, VIDEO_LIMIT)
    .map((v): YoutubeResult => {
      const channel: string | null = nav(v, ['ownerText', 'runs', 0, 'text']) ?? nav(v, ['longBylineText', 'runs', 0, 'text']) ?? null;
      const tags = videoTags(runsText(v.title), channel);
      return {
        kind: 'video',
        id: v.videoId,
        title: tags.title,
        artist: tags.artist,
        album: null,
        channel,
        durationSec: parseDuration(v.lengthText?.simpleText),
        views: count(v.viewCountText?.simpleText),
        explicit: false,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      };
    });
}

const linked = new Map<string, Promise<YoutubeResult>>();

/**
 * Un video concreto (enlace pegado). Las pistas de YouTube Music las sube el canal "Artista - Topic":
 * esas son canciones, con su título tal cual; el resto, videos con artista y título sacados del nombre.
 */
function linkedVideo(id: string): Promise<YoutubeResult> {
  // Las dos partes de la búsqueda (music y videos) piden el mismo enlace a la vez: una sola petición.
  // Sin la señal de cancelación: la petición es de las dos partes, no de quien llegó primero.
  const pending = linked.get(id);
  if (pending) return pending;
  const promise = player(id)
    .then((r): YoutubeResult => {
      const d = r.videoDetails ?? {};
      if (d.isLive || d.isUpcoming) throw new YoutubeError('Es una transmisión en vivo');
      const channel: string | null = d.author ?? null;
      const song = /\s-\sTopic$/i.test(channel ?? '');
      const tags = song ? { title: String(d.title ?? 'Sin título'), artist: cleanChannel(channel) ?? 'Artista desconocido' } : videoTags(String(d.title ?? ''), channel);
      return {
        kind: song ? 'song' : 'video',
        id,
        title: tags.title,
        artist: tags.artist,
        album: null,
        channel,
        durationSec: Number(d.lengthSeconds) || null,
        views: Number(d.viewCount) || null,
        explicit: false,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };
    })
    .finally(() => linked.delete(id));
  linked.set(id, promise);
  return promise;
}
