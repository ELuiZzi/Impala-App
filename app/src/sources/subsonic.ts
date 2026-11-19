import { api, buildUrl, coverArtUrl, request, streamUrl, uploaderUrl, type Session } from '@/api/subsonic';
import type { Lyrics, MusicSource, Playlist, Range, SourceCapabilities, StreamQuality, TrimInfo } from './types';

/** El servidor propio tiene el microservicio de ingestión (yt-dlp, ffmpeg, LRCLIB): sabe hacerlo todo. */
const CAPABILITIES: SourceCapabilities = {
  upload: true,
  deleteSongs: true,
  trim: true,
  lyrics: true,
  youtube: true,
  appleMusicImport: true,
  offlineDownloads: true,
  streamQuality: true,
};

const songPath = (id: string, what: string) => `songs/${encodeURIComponent(id)}/${what}`;

/** Navidrome (API Subsonic) más el microservicio de ingestión del mismo servidor. */
export class SubsonicSource implements MusicSource {
  readonly kind = 'subsonic';
  readonly capabilities = CAPABILITIES;
  readonly label = 'Servidor';
  /** Las claves de caché de la 1.4 empezaban por servidor y usuario: se mantienen. */
  readonly key: readonly string[];
  readonly details: { label: string; value: string }[];

  constructor(readonly session: Session) {
    this.key = [session.server, session.username];
    this.details = [
      { label: 'Dirección', value: session.server.replace(/^https?:\/\//, '') },
      { label: 'Usuario', value: session.username },
    ];
  }

  info = async () => {
    const r = await api.ping(this.session);
    return { version: `Navidrome ${r.serverVersion ?? ''}`.trim() };
  };

  getArtists = () => api.getArtists(this.session);
  getArtist = (id: string) => api.getArtist(this.session, id);
  getAlbum = (id: string) => api.getAlbum(this.session, id);
  getAlbumList: MusicSource['getAlbumList'] = (type, size, offset) => api.getAlbumList(this.session, type, size, offset);
  search: MusicSource['search'] = (text, opts) => api.search(this.session, text, opts);
  getSong = (id: string) => api.getSong(this.session, id);

  getPlaylists = () => api.getPlaylists(this.session);
  getPlaylist = (id: string) => api.getPlaylist(this.session, id);
  createPlaylist = (name: string, songIds: string[] = []) => api.createPlaylist(this.session, name, songIds);
  renamePlaylist = async (id: string, name: string) => void (await api.updatePlaylist(this.session, id, { name }));
  deletePlaylist = async (id: string) => void (await api.deletePlaylist(this.session, id));
  addToPlaylist = async (id: string, songIds: string[]) => void (await api.updatePlaylist(this.session, id, { add: songIds }));
  removeFromPlaylist = async (id: string, indexes: number[]) => void (await api.updatePlaylist(this.session, id, { removeIndexes: indexes }));
  setPlaylistSongs = async (id: string, songIds: string[]) => void (await api.replacePlaylistSongs(this.session, id, songIds));
  isOwnPlaylist = (p: Pick<Playlist, 'owner'>) => !p.owner || p.owner === this.session.username;

  getFavorites = () => api.getStarredSongs(this.session);
  setFavorite = async (songId: string, favorite: boolean) =>
    void (await (favorite ? api.star(this.session, songId) : api.unstar(this.session, songId)));
  scrobble = async (songId: string, submission: boolean) => void (await api.scrobble(this.session, songId, submission));

  streamUrl = (songId: string, quality: StreamQuality) => streamUrl(this.session, songId, quality);
  downloadUrl = (songId: string) => buildUrl(this.session, 'download', { id: songId });
  // Una URL completa (imagen de un episodio de una suscripción) se usa tal cual.
  coverUrl = (coverArt: string | undefined, size: number) => (coverArt && /^https?:\/\//.test(coverArt) ? coverArt : coverArtUrl(this.session, coverArt, size));
  /** URL.searchParams no está completo en React Native; basta con extraer el parámetro id. */
  coverArtFromUrl = (url: string | undefined) => {
    if (url && !url.includes('/rest/getCoverArt')) return /^https?:\/\//.test(url) ? url : undefined;
    const match = url && /[?&]id=([^&]+)/.exec(url);
    return match ? decodeURIComponent(match[1]) : undefined;
  };

  deleteSong = (id: string) => api.deleteSong(this.session, id);
  /** El servidor busca la letra (archivo o LRCLIB) y la guarda en caché. */
  lyrics = (songId: string) =>
    request<{ lyrics: Lyrics }>(uploaderUrl(this.session, `lyrics/${encodeURIComponent(songId)}`)).then((r) => r.lyrics);
  /** Recortes con ffmpeg: se sobrescribe el archivo, pero el servidor guarda el original la primera vez. */
  trimInfo = (songId: string) => request<TrimInfo>(uploaderUrl(this.session, songPath(songId, 'trim')));
  waveform = (songId: string) =>
    request<{ peaks: number[] }>(uploaderUrl(this.session, songPath(songId, 'waveform'))).then((r) => r.peaks);
  trim = (songId: string, keep: Range[]) =>
    request<{ duration: number }>(uploaderUrl(this.session, songPath(songId, 'trim')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep }),
    });
  restore = (songId: string) => request<{ duration: number }>(uploaderUrl(this.session, songPath(songId, 'restore')), { method: 'POST' });
}

/**
 * La sesión del servidor, para lo que solo existe en él (YouTube, Apple Music, subir archivos). Esas
 * pantallas solo se muestran si la fuente activa tiene la capacidad correspondiente.
 */
export function serverSession(source: MusicSource): Session {
  if (source instanceof SubsonicSource) return source.session;
  throw new Error('Esta función necesita tu servidor');
}
