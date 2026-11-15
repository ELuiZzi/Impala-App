/**
 * Fuentes de música: de dónde salen la biblioteca, las playlists, el audio y las carátulas. La app pide
 * todo a «la fuente activa» (ver ./index.ts) y nunca a un servidor concreto, para que el mismo código
 * sirva para el servidor propio (Subsonic/Navidrome) y, más adelante, para la música del teléfono.
 *
 * Los ids (canciones, álbumes, carátulas…) son opacos: cada fuente decide su forma.
 */

export type Song = {
  id: string;
  title: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  track?: number;
  year?: number;
  duration?: number;
  /** Id de la carátula: se convierte en URL con `source.coverUrl`. */
  coverArt?: string;
  suffix?: string;
  bitRate?: number;
  samplingRate?: number;
  bitDepth?: number;
  /** Fecha ISO en que se marcó como favorita (estrella), si lo está. */
  starred?: string;
  /** Fecha ISO en que entró en la biblioteca. */
  created?: string;
};

export type Album = {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  year?: number;
  coverArt?: string;
  songCount?: number;
  duration?: number;
};

export type AlbumWithSongs = Album & { song?: Song[] };

export type Artist = {
  id: string;
  name: string;
  albumCount?: number;
  coverArt?: string;
};

export type ArtistWithAlbums = Artist & { album?: Album[] };

export type Playlist = {
  id: string;
  name: string;
  songCount: number;
  duration: number;
  coverArt?: string;
  /** Usuario dueño (playlists de un servidor); sin dueño, son del usuario. */
  owner?: string;
  comment?: string;
};

export type PlaylistWithSongs = Playlist & { entry?: Song[] };

export type AlbumListType = 'newest' | 'recent' | 'frequent' | 'random' | 'alphabeticalByName' | 'alphabeticalByArtist';

/** original: el archivo tal cual; ahorro: transcodificado a menos bitrate (solo si la fuente lo permite). */
export type StreamQuality = 'original' | 'ahorro';

export type SearchOptions = { songCount?: number; songOffset?: number; albumCount?: number; artistCount?: number };
export type SearchResults = { artists: Artist[]; albums: Album[]; songs: Song[] };

/** words: tiempos por palabra si la letra los trae (LRC mejorado); si no, la app los estima. */
export type LyricLine = { timeMs: number | null; text: string; words?: { timeMs: number; text: string }[] };

/** source: 'file' (incrustada en el archivo), 'lrclib' o null si no se encontró. */
export type Lyrics = { source: 'file' | 'lrclib' | null; synced: boolean; lines: LyricLine[] };

/** Estado de una canción para el editor de recortes. */
export type TrimInfo = {
  admin: boolean;
  duration: number;
  codec: string;
  /** 'reencode': sin pérdida y exacto; 'copy': sin recodificar (MP3, AAC, Opus), el corte cae en la trama más cercana. */
  method: 'reencode' | 'copy' | null;
  canTrim: boolean;
  /** El original guardado del primer recorte, si lo hay. */
  backup: { createdAt: number; duration: number } | null;
};

/** Tramo que se conserva, en segundos. */
export type Range = [number, number];

/** Qué sabe hacer cada fuente: la interfaz muestra u oculta las opciones según esto. */
export type SourceCapabilities = {
  /** Subir archivos del teléfono a la biblioteca (Importar). */
  upload: boolean;
  /** Borrar canciones de la biblioteca. */
  deleteSongs: boolean;
  /** Recortar canciones (quitar la intro, el final o trozos). */
  trim: boolean;
  /** Letras (sincronizadas o no). */
  lyrics: boolean;
  /** Buscar en YouTube y descargar a la biblioteca. */
  youtube: boolean;
  /** Importar playlists de Apple Music. */
  appleMusicImport: boolean;
  /** Guardar canciones en el teléfono para escucharlas sin conexión (en local no hace falta). */
  offlineDownloads: boolean;
  /** Elegir la calidad del streaming (original o ahorro de datos). */
  streamQuality: boolean;
};

export interface MusicSource {
  readonly kind: 'subsonic' | 'local';
  /** Prefijo de las claves de React Query: así no se mezclan cachés entre fuentes ni cuentas. */
  readonly key: readonly string[];
  readonly capabilities: SourceCapabilities;
  /** Título del grupo de Ajustes que describe la fuente ("Servidor", "Este dispositivo"). */
  readonly label: string;
  /** Filas fijas de ese grupo (dirección, usuario…). */
  readonly details: { label: string; value: string }[];

  /** Comprueba que responde; `version` se muestra en Ajustes. */
  info(): Promise<{ version: string }>;

  // --- Biblioteca ---
  getArtists(): Promise<Artist[]>;
  getArtist(id: string): Promise<ArtistWithAlbums>;
  getAlbum(id: string): Promise<AlbumWithSongs>;
  getAlbumList(type: AlbumListType, size: number, offset?: number): Promise<Album[]>;
  /** Con texto vacío devuelve toda la biblioteca (paginada con songOffset). */
  search(text: string, opts?: SearchOptions): Promise<SearchResults>;
  getSong(id: string): Promise<Song>;

  // --- Playlists ---
  getPlaylists(): Promise<Playlist[]>;
  getPlaylist(id: string): Promise<PlaylistWithSongs>;
  createPlaylist(name: string, songIds?: string[]): Promise<PlaylistWithSongs>;
  renamePlaylist(id: string, name: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  addToPlaylist(id: string, songIds: string[]): Promise<void>;
  /** Quita por posición (una canción puede estar repetida). */
  removeFromPlaylist(id: string, indexes: number[]): Promise<void>;
  /** Sustituye todas las canciones: así se guarda un nuevo orden. */
  setPlaylistSongs(id: string, songIds: string[]): Promise<void>;
  /** Las playlists que el usuario puede editar (en un servidor puede haber de otros usuarios). */
  isOwnPlaylist(p: Pick<Playlist, 'owner'>): boolean;

  // --- Favoritas y escuchas ---
  getFavorites(): Promise<Song[]>;
  setFavorite(songId: string, favorite: boolean): Promise<void>;
  /** submission=false: "sonando ahora"; true: cuenta la reproducción. */
  scrobble(songId: string, submission: boolean): Promise<void>;

  // --- Audio y carátulas ---
  streamUrl(songId: string, quality: StreamQuality): string;
  /** El archivo original, para guardarlo en el teléfono. */
  downloadUrl(songId: string): string;
  coverUrl(coverArt: string | undefined, size: number): string | undefined;
  /** El id de carátula a partir de su URL (al recuperar la cola del servicio nativo). */
  coverArtFromUrl(url: string | undefined): string | undefined;

  // --- Opcionales: solo si `capabilities` lo indica ---
  deleteSong(id: string): Promise<void>;
  lyrics(songId: string): Promise<Lyrics>;
  trimInfo(songId: string): Promise<TrimInfo>;
  waveform(songId: string): Promise<number[]>;
  trim(songId: string, keep: Range[]): Promise<{ duration: number }>;
  restore(songId: string): Promise<{ duration: number }>;
}
