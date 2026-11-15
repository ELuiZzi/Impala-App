import * as Crypto from 'expo-crypto';
import { md5 } from './md5';
import type { Album, AlbumListType, AlbumWithSongs, Artist, ArtistWithAlbums, Playlist, PlaylistWithSongs, SearchOptions, Song, StreamQuality } from '@/sources/types';

const API_VERSION = '1.16.1';
const CLIENT_NAME = 'impala';

/** Credenciales persistidas: nunca la contraseña, solo el token md5(contraseña + salt). */
export type Session = {
  server: string;
  username: string;
  salt: string;
  token: string;
};

export class SubsonicError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'SubsonicError';
  }
}

type Scalar = string | number | boolean;
/** Los arrays se envían como parámetros repetidos (songId=1&songId=2), como exige Subsonic. */
type Params = Record<string, Scalar | Scalar[] | undefined>;

/** "mi-servidor.ts.net/" → "https://mi-servidor.ts.net" */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export async function createSession(server: string, username: string, password: string): Promise<Session> {
  const salt = Crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const token = await md5(password + salt);
  const session = { server: normalizeServerUrl(server), username: username.trim(), salt, token };
  await api.ping(session); // valida servidor y credenciales antes de guardar nada
  return session;
}

export function query(params: Params): string {
  return Object.entries(params)
    .flatMap(([key, value]) => (value === undefined ? [] : Array.isArray(value) ? value.map((v) => [key, v] as const) : [[key, value] as const]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/** URL autenticada para cualquier endpoint (también sirve para <Image> y, en la Fase 3, para el stream). */
export function buildUrl(session: Session, endpoint: string, params: Params = {}): string {
  const auth = { u: session.username, t: session.token, s: session.salt, v: API_VERSION, c: CLIENT_NAME, f: 'json' };
  return `${session.server}/rest/${endpoint}?${query({ ...auth, ...params })}`;
}

/** Opus a 192 kbps: casi transparente y ~7 veces más ligero que un FLAC de CD. */
export const DATA_SAVER_FORMAT = { format: 'opus', maxBitRate: 192 } as const;

/**
 * original: el archivo tal cual (FLAC/ALAC/WAV bit a bit).
 * ahorro: Navidrome transcodifica al vuelo con FFmpeg; estimateContentLength permite saber la
 * longitud del flujo transcodificado para que el reproductor pueda mostrar la duración y buscar.
 */
export function streamUrl(session: Session, songId: string, quality: StreamQuality): string {
  return quality === 'original'
    ? buildUrl(session, 'stream', { id: songId, format: 'raw' })
    : buildUrl(session, 'stream', { id: songId, ...DATA_SAVER_FORMAT, estimateContentLength: true });
}

/** Microservicio de ingestión: se autentica con las mismas credenciales Subsonic de la sesión. */
export function uploadUrl(session: Session): string {
  return `${session.server}/upload?${query({ u: session.username, t: session.token, s: session.salt })}`;
}

/** Rutas del microservicio de ingestión, autenticadas con las credenciales Subsonic de la sesión. */
export function uploaderUrl(session: Session, path: string, params: Record<string, string> = {}): string {
  return `${session.server}/upload/${path}?${query({ u: session.username, t: session.token, s: session.salt, ...params })}`;
}

/** Petición JSON al microservicio de ingestión; los errores llegan como { error }. */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('No se pudo conectar con el servidor');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `El servidor respondió HTTP ${res.status}`);
  return body as T;
}

export type UploadResponse = {
  file: string;
  originalName: string;
  size: number;
  md5: string;
  duplicate: boolean;
};

export function coverArtUrl(session: Session, coverArt: string | undefined, size = 300): string | undefined {
  return coverArt ? buildUrl(session, 'getCoverArt', { id: coverArt, size }) : undefined;
}

async function call<T>(session: Session, endpoint: string, params?: Params): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(session, endpoint, params));
  } catch {
    throw new SubsonicError('No se pudo conectar con el servidor. ¿Está activo Tailscale?');
  }
  if (!res.ok) throw new SubsonicError(`El servidor respondió HTTP ${res.status}`);

  const body = (await res.json())['subsonic-response'];
  if (body?.status !== 'ok') {
    const code: number | undefined = body?.error?.code;
    const message = code === 40 || code === 41 ? 'Usuario o contraseña incorrectos' : body?.error?.message;
    throw new SubsonicError(message ?? 'Respuesta inválida del servidor', code);
  }
  return body as T;
}

export const api = {
  ping: (s: Session) =>
    call<{ serverVersion?: string; type?: string; openSubsonic?: boolean }>(s, 'ping'),

  getArtists: async (s: Session): Promise<Artist[]> => {
    const r = await call<{ artists: { index?: { artist?: Artist[] }[] } }>(s, 'getArtists');
    return (r.artists.index ?? []).flatMap((i) => i.artist ?? []);
  },

  getArtist: async (s: Session, id: string): Promise<ArtistWithAlbums> =>
    (await call<{ artist: ArtistWithAlbums }>(s, 'getArtist', { id })).artist,

  getAlbum: async (s: Session, id: string): Promise<AlbumWithSongs> =>
    (await call<{ album: AlbumWithSongs }>(s, 'getAlbum', { id })).album,

  getAlbumList: async (s: Session, type: AlbumListType, size: number, offset = 0): Promise<Album[]> =>
    (await call<{ albumList2: { album?: Album[] } }>(s, 'getAlbumList2', { type, size, offset })).albumList2.album ?? [],

  /** Con query vacía Navidrome devuelve toda la biblioteca (paginada). */
  search: async (
    s: Session,
    queryText: string,
    opts: SearchOptions = {},
  ) => {
    const r = await call<{ searchResult3: { artist?: Artist[]; album?: Album[]; song?: Song[] } }>(s, 'search3', {
      query: queryText,
      songCount: opts.songCount ?? 20,
      songOffset: opts.songOffset ?? 0,
      albumCount: opts.albumCount ?? 20,
      artistCount: opts.artistCount ?? 20,
    });
    return { artists: r.searchResult3.artist ?? [], albums: r.searchResult3.album ?? [], songs: r.searchResult3.song ?? [] };
  },

  getPlaylists: async (s: Session): Promise<Playlist[]> =>
    (await call<{ playlists: { playlist?: Playlist[] } }>(s, 'getPlaylists')).playlists.playlist ?? [],

  getPlaylist: async (s: Session, id: string): Promise<PlaylistWithSongs> =>
    (await call<{ playlist: PlaylistWithSongs }>(s, 'getPlaylist', { id })).playlist,

  getSong: async (s: Session, id: string): Promise<Song> => (await call<{ song: Song }>(s, 'getSong', { id })).song,

  createPlaylist: async (s: Session, name: string, songIds: string[] = []): Promise<PlaylistWithSongs> =>
    (await call<{ playlist: PlaylistWithSongs }>(s, 'createPlaylist', { name, songId: songIds })).playlist,

  /** createPlaylist con playlistId sustituye todas las canciones: así se guarda un nuevo orden. */
  replacePlaylistSongs: (s: Session, playlistId: string, songIds: string[]) =>
    call<object>(s, 'createPlaylist', { playlistId, songId: songIds }),

  updatePlaylist: (s: Session, playlistId: string, changes: { name?: string; add?: string[]; removeIndexes?: number[] }) =>
    call<object>(s, 'updatePlaylist', {
      playlistId,
      name: changes.name,
      songIdToAdd: changes.add,
      songIndexToRemove: changes.removeIndexes,
    }),

  deletePlaylist: (s: Session, id: string) => call<object>(s, 'deletePlaylist', { id }),

  /** Favoritas: la "estrella" de Subsonic. */
  star: (s: Session, id: string) => call<object>(s, 'star', { id }),
  unstar: (s: Session, id: string) => call<object>(s, 'unstar', { id }),
  getStarredSongs: async (s: Session): Promise<Song[]> =>
    (await call<{ starred2: { song?: Song[] } }>(s, 'getStarred2')).starred2.song ?? [],

  /**
   * Borra el archivo de la canción en el servidor (lo hace el microservicio de ingestión: Subsonic no
   * permite borrar). Navidrome la retira de la biblioteca al detectar el cambio en el disco.
   */
  deleteSong: async (s: Session, id: string) => {
    let res: Response;
    try {
      res = await fetch(`${s.server}/upload/songs/${encodeURIComponent(id)}?${query({ u: s.username, t: s.token, s: s.salt })}`, { method: 'DELETE' });
    } catch {
      throw new SubsonicError('No se pudo conectar con el servidor');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new SubsonicError(body?.error ?? `El servidor respondió HTTP ${res.status}`);
  },

  /** submission=false: "sonando ahora"; true: cuenta la reproducción (historial, más escuchadas). */
  scrobble: (s: Session, id: string, submission: boolean) =>
    call<object>(s, 'scrobble', { id, submission, time: submission ? Date.now() : undefined }),
};
