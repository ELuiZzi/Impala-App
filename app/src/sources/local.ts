import { AppState, Platform } from 'react-native';
import { invalidateLibrary } from '@/api/queryClient';
import ImpalaLibrary, { type DeviceSong } from '../../modules/impala-library';
import { localLyrics } from './localLyrics';
import { localRestore, localTrim, localTrimInfo, localWaveform, removeBackup } from './localTrim';
import { DEFAULT_FOLDER, localData, newPlaylistId, updateLocalData, type LocalPlaylist } from './localData';
import { DeleteCancelledError } from './errors';
import type {
  Album,
  AlbumListType,
  AlbumWithSongs,
  ArtistWithAlbums,
  MusicSource,
  Playlist,
  PlaylistWithSongs,
  SearchOptions,
  Song,
  Range,
  SourceCapabilities,
} from './types';
import { DEVICE } from '@/components/device';

/** Lo que exige un servidor (yt-dlp, ffmpeg) o no tiene sentido con archivos del teléfono. */
const pc = Platform.OS === 'web';

const CAPABILITIES: SourceCapabilities = {
  upload: false,
  deleteSongs: true,
  /** Sin recodificar: en el teléfono M4A/AAC y MP3 (localTrim.ts); en el PC, con ffmpeg, también FLAC, Opus, WAV… */
  trim: true,
  lyrics: true,
  /** Se descarga al propio dispositivo (Music/Impala), ver api/youtubeLocal.ts. */
  youtube: true,
  /** Lee la playlist y descarga lo que falta desde el propio dispositivo, ver api/appleMusicLocal.ts. */
  appleMusicImport: true,
  offlineDownloads: false,
  streamQuality: false,
};

/** En PC, Rust sirve los archivos de las carpetas elegidas y sus carátulas (desktop/src-tauri/src/library.rs). */
const SONG_URI = pc ? 'http://impala.localhost/local/' : 'content://media/external/audio/media/';
/** Carátula del álbum (la incrustada en sus archivos), servida por el propio índice de Android. */
const ALBUM_ART_URI = pc ? 'http://impala.localhost/local-cover/' : 'content://media/external/audio/albumart/';

const fold = (text: string | null | undefined) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const compare = (a: string | undefined, b: string | undefined) => fold(a).localeCompare(fold(b), 'es');

type Library = {
  songs: Song[];
  byId: Map<string, Song>;
  albums: Map<string, AlbumWithSongs & { song: Song[]; added: string }>;
  artists: Map<string, ArtistWithAlbums & { album: Album[] }>;
};

function toSong(d: DeviceSong): Song {
  return {
    id: d.id,
    title: d.title,
    album: d.album,
    albumId: d.albumId,
    artist: d.artist,
    artistId: d.artistId,
    track: d.track,
    year: d.year,
    duration: Math.round(d.durationMs / 1000),
    coverArt: d.albumId,
    suffix: d.suffix,
    bitRate: d.bitRate,
    created: new Date(d.dateAdded * 1000).toISOString(),
  };
}

/** Lo más repetido de una lista (el artista de un álbum cuando el archivo no trae «artista del álbum»). */
function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function buildLibrary(): Promise<Library> {
  const { folders } = localData();
  // La carpeta de Impala existe desde el principio: ahí se copia la música (y la guardarán las descargas).
  if (folders.includes(DEFAULT_FOLDER)) ImpalaLibrary.ensureFolder(DEFAULT_FOLDER);
  const device = await ImpalaLibrary.getSongs(folders);
  const disc = new Map(device.map((d) => [d.id, d.disc ?? 1]));
  const songs = device.map(toSong).sort((a, b) => compare(a.title, b.title));
  const byId = new Map(songs.map((s) => [s.id, s]));
  const albumArtistOf = new Map(device.map((d) => [d.id, d.albumArtist]));

  const albums: Library['albums'] = new Map();
  for (const s of songs) {
    if (!s.albumId) continue;
    let album = albums.get(s.albumId);
    if (!album) {
      album = { id: s.albumId, name: s.album ?? '', coverArt: s.coverArt, song: [], added: '' };
      albums.set(s.albumId, album);
    }
    album.song.push(s);
  }
  for (const album of albums.values()) {
    album.song.sort((a, b) => disc.get(a.id)! - disc.get(b.id)! || (a.track ?? 0) - (b.track ?? 0) || compare(a.title, b.title));
    album.artist = mostCommon(album.song.map((s) => albumArtistOf.get(s.id))) ?? mostCommon(album.song.map((s) => s.artist));
    album.artistId = album.song.find((s) => s.artist === album.artist)?.artistId ?? album.song[0].artistId;
    album.year = Math.max(0, ...album.song.map((s) => s.year ?? 0)) || undefined;
    album.songCount = album.song.length;
    album.duration = album.song.reduce((t, s) => t + (s.duration ?? 0), 0);
    album.added = album.song.reduce((max, s) => ((s.created ?? '') > max ? (s.created ?? '') : max), '');
  }

  const artists: Library['artists'] = new Map();
  for (const s of songs) {
    if (!s.artistId) continue;
    let artist = artists.get(s.artistId);
    if (!artist) {
      artist = { id: s.artistId, name: s.artist ?? 'Artista desconocido', album: [] };
      artists.set(s.artistId, artist);
    }
    const album = s.albumId ? albums.get(s.albumId) : undefined;
    if (album && !artist.album.includes(album)) artist.album.push(album);
  }
  for (const artist of artists.values()) {
    artist.album.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || compare(a.name, b.name));
    artist.albumCount = artist.album.length;
    artist.coverArt = artist.album[0]?.coverArt;
  }

  return { songs, byId, albums, artists };
}

let library: Promise<Library> | null = null;

function getLibrary(): Promise<Library> {
  if (!library) {
    const pending = buildLibrary();
    library = pending;
    // Un fallo (p. ej. sin permiso todavía) no se queda en caché.
    pending.catch(() => {
      if (library === pending) library = null;
    });
  }
  return library;
}

/** Las favoritas se guardan aparte: se añaden a cada canción al entregarla. */
function withStar(song: Song): Song {
  const starred = localData().favorites[song.id];
  return starred ? { ...song, starred } : song;
}

const notFound = (what: string) => new Error(`${what} ya no está en el ${DEVICE}`);

function playlistSongs(p: LocalPlaylist, lib: Library): Song[] {
  // Si un archivo se borró, su canción desaparece de la playlist sin romperla.
  return p.songIds.flatMap((id) => {
    const s = lib.byId.get(id);
    return s ? [withStar(s)] : [];
  });
}

function summary(p: LocalPlaylist, songs: Song[]): Playlist {
  return {
    id: p.id,
    name: p.name,
    songCount: songs.length,
    duration: songs.reduce((t, s) => t + (s.duration ?? 0), 0),
    coverArt: songs.find((s) => s.coverArt)?.coverArt,
  };
}

function findPlaylist(id: string): LocalPlaylist {
  const p = localData().playlists.find((x) => x.id === id);
  if (!p) throw notFound('La playlist');
  return p;
}

function changePlaylist(id: string, change: (p: LocalPlaylist) => Partial<LocalPlaylist>) {
  findPlaylist(id);
  const changed = new Date().toISOString();
  updateLocalData(({ playlists }) => ({
    playlists: playlists.map((p) => (p.id === id ? { ...p, ...change(p), changed } : p)),
  }));
}

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** La música del teléfono (índice de Android) con playlists y favoritas guardadas en el propio teléfono. */
export class LocalSource implements MusicSource {
  readonly kind = 'local';
  readonly key = ['local'] as const;
  readonly capabilities = CAPABILITIES;
  readonly label = 'Este dispositivo';
  readonly details = [];

  info = async () => {
    const { songs } = await getLibrary();
    return { version: `${songs.length} ${songs.length === 1 ? 'canción' : 'canciones'}` };
  };

  getArtists = async () => {
    const lib = await getLibrary();
    return [...lib.artists.values()].map(({ album: _album, ...artist }) => artist).sort((a, b) => compare(a.name, b.name));
  };

  getArtist = async (id: string) => {
    const artist = (await getLibrary()).artists.get(id);
    if (!artist) throw notFound('El artista');
    return artist;
  };

  getAlbum = async (id: string) => {
    const album = (await getLibrary()).albums.get(id);
    if (!album) throw notFound('El álbum');
    return { ...album, song: album.song.map(withStar) };
  };

  getAlbumList = async (type: AlbumListType, size: number, offset = 0): Promise<Album[]> => {
    const all = [...(await getLibrary()).albums.values()];
    const { plays } = localData();
    const lastPlay = (a: (typeof all)[number]) => a.song.reduce((max, s) => ((plays[s.id]?.last ?? '') > max ? plays[s.id].last : max), '');
    const playCount = (a: (typeof all)[number]) => a.song.reduce((t, s) => t + (plays[s.id]?.count ?? 0), 0);
    const sorted = (() => {
      switch (type) {
        case 'newest':
          return all.sort((a, b) => b.added.localeCompare(a.added));
        case 'recent':
          return all.filter((a) => lastPlay(a)).sort((a, b) => lastPlay(b).localeCompare(lastPlay(a)));
        case 'frequent':
          return all.filter((a) => playCount(a) > 0).sort((a, b) => playCount(b) - playCount(a));
        case 'random':
          return shuffled(all);
        case 'alphabeticalByArtist':
          return all.sort((a, b) => compare(a.artist, b.artist) || compare(a.name, b.name));
        default:
          return all.sort((a, b) => compare(a.name, b.name));
      }
    })();
    return sorted.slice(offset, offset + size).map(({ song: _song, added: _added, ...album }) => album);
  };

  /** Todas las palabras deben aparecer en el título, el artista o el álbum (sin acentos ni mayúsculas). */
  search = async (text: string, opts: SearchOptions = {}) => {
    const { songCount = 20, songOffset = 0, albumCount = 20, artistCount = 20 } = opts;
    const lib = await getLibrary();
    const words = fold(text).split(/\s+/).filter(Boolean);
    const matches = (...fields: (string | undefined)[]) => {
      const haystack = fold(fields.join(' '));
      return words.every((w) => haystack.includes(w));
    };
    const songs = lib.songs.filter((s) => matches(s.title, s.artist, s.album));
    const albums = [...lib.albums.values()].filter((a) => matches(a.name, a.artist)).sort((a, b) => compare(a.name, b.name));
    const artists = [...lib.artists.values()].filter((a) => matches(a.name)).sort((a, b) => compare(a.name, b.name));
    return {
      songs: songs.slice(songOffset, songOffset + songCount).map(withStar),
      albums: albums.slice(0, albumCount).map(({ song: _song, added: _added, ...album }) => album),
      artists: artists.slice(0, artistCount).map(({ album: _album, ...artist }) => artist),
    };
  };

  getSong = async (id: string) => {
    const song = (await getLibrary()).byId.get(id);
    if (!song) throw notFound('La canción');
    return withStar(song);
  };

  getPlaylists = async () => {
    const lib = await getLibrary();
    return localData().playlists.map((p) => summary(p, playlistSongs(p, lib)));
  };

  getPlaylist = async (id: string): Promise<PlaylistWithSongs> => {
    const lib = await getLibrary();
    const p = findPlaylist(id);
    const entry = playlistSongs(p, lib);
    return { ...summary(p, entry), entry };
  };

  createPlaylist = async (name: string, songIds: string[] = []) => {
    const now = new Date().toISOString();
    const p: LocalPlaylist = { id: newPlaylistId(), name, songIds, created: now, changed: now };
    updateLocalData(({ playlists }) => ({ playlists: [...playlists, p] }));
    return this.getPlaylist(p.id);
  };

  renamePlaylist = async (id: string, name: string) => changePlaylist(id, () => ({ name }));

  deletePlaylist = async (id: string) => {
    findPlaylist(id);
    updateLocalData(({ playlists }) => ({ playlists: playlists.filter((p) => p.id !== id) }));
  };

  addToPlaylist = async (id: string, songIds: string[]) => changePlaylist(id, (p) => ({ songIds: [...p.songIds, ...songIds] }));

  /** Las posiciones son las de la lista que se ve (sin las canciones cuyo archivo ya no está). */
  removeFromPlaylist = async (id: string, indexes: number[]) => {
    const lib = await getLibrary();
    changePlaylist(id, (p) => {
      const visible = p.songIds.flatMap((songId, stored) => (lib.byId.has(songId) ? [stored] : []));
      const drop = new Set(indexes.map((i) => visible[i]));
      return { songIds: p.songIds.filter((_, stored) => !drop.has(stored)) };
    });
  };

  setPlaylistSongs = async (id: string, songIds: string[]) => changePlaylist(id, () => ({ songIds }));

  isOwnPlaylist = () => true;

  getFavorites = async () => {
    const lib = await getLibrary();
    return Object.keys(localData().favorites).flatMap((id) => {
      const s = lib.byId.get(id);
      return s ? [withStar(s)] : [];
    });
  };

  setFavorite = async (songId: string, favorite: boolean) => {
    updateLocalData(({ favorites }) => {
      const next = { ...favorites };
      if (favorite) next[songId] = new Date().toISOString();
      else delete next[songId];
      return { favorites: next };
    });
  };

  /** Sin servidor no hay a quién avisar: las escuchas completas se cuentan aquí (Recientes, Más escuchadas). */
  scrobble = async (songId: string, submission: boolean) => {
    if (!submission) return;
    updateLocalData(({ plays }) => ({
      plays: { ...plays, [songId]: { count: (plays[songId]?.count ?? 0) + 1, last: new Date().toISOString() } },
    }));
  };

  streamUrl = (songId: string) => SONG_URI + songId;
  downloadUrl = (songId: string) => SONG_URI + songId;
  // Una URL completa (imagen de un episodio de una suscripción) se usa tal cual.
  coverUrl = (coverArt: string | undefined) => (coverArt ? (/^https?:\/\//.test(coverArt) ? coverArt : ALBUM_ART_URI + coverArt) : undefined);
  coverArtFromUrl = (url: string | undefined) =>
    url?.startsWith(ALBUM_ART_URI) ? url.slice(ALBUM_ART_URI.length) : url && /^https?:\/\//.test(url) ? url : undefined;

  /** Android pide confirmación con su propio diálogo; si se cancela, DeleteCancelledError. */
  deleteSong = async (id: string) => {
    if (!(await ImpalaLibrary.deleteSong(id))) throw new DeleteCancelledError();
    // Fuera de las playlists y de las escuchas; la estrella la quita quien llama (como con el servidor).
    updateLocalData(({ playlists, plays }) => {
      const { [id]: _gone, ...rest } = plays;
      return {
        playlists: playlists.map((p) => (p.songIds.includes(id) ? { ...p, songIds: p.songIds.filter((s) => s !== id) } : p)),
        plays: rest,
      };
    });
    removeBackup(id);
    library = null;
  };

  lyrics = async (songId: string) => localLyrics(await this.getSong(songId));

  trimInfo = localTrimInfo;
  waveform = localWaveform;

  trim = async (songId: string, keep: Range[]) => {
    const result = await localTrim(await this.getSong(songId), keep);
    library = null;
    return result;
  };

  restore = async (songId: string) => {
    const result = await localRestore(await this.getSong(songId));
    library = null;
    return result;
  };
}

export const localSource = new LocalSource();

/** Vuelve a leer el índice de Android y refresca las pantallas (al cambiar archivos o carpetas). */
export function refreshLocalLibrary() {
  library = null;
  return invalidateLibrary(localSource);
}

/**
 * Mientras la fuente activa sea el teléfono: refresca la biblioteca cuando Android avisa de cambios
 * (archivos copiados o borrados) y al volver a la app, por si algo cambió con Impala cerrada.
 */
export function watchLocalLibrary(): () => void {
  const change = ImpalaLibrary.addListener('onChange', () => void refreshLocalLibrary());
  const foreground = AppState.addEventListener('change', (s) => s === 'active' && void refreshLocalLibrary());
  return () => {
    change.remove();
    foreground.remove();
  };
}
