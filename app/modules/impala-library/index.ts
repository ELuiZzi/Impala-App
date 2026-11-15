import { NativeModule, requireNativeModule } from 'expo';

/** Una canción tal como la indexa Android (MediaStore.Audio). */
export type DeviceSong = {
  id: string;
  /** content://media/external/audio/media/<id>: lo reproduce ExoPlayer directamente. */
  uri: string;
  title: string;
  artist?: string;
  artistId?: string;
  albumArtist?: string;
  album?: string;
  albumId?: string;
  track?: number;
  disc?: number;
  year?: number;
  durationMs: number;
  /** Segundos desde epoch en que Android la indexó. */
  dateAdded: number;
  mimeType?: string;
  suffix?: string;
  size: number;
  /** kbps (Android 11+). */
  bitRate?: number;
  /** Ruta relativa de su carpeta, con barra final ("Music/Impala/Rock/"). */
  folder?: string;
};

export type DeviceFolder = { path: string; count: number };

/** Una descarga de YouTube al teléfono: audio m4a ya resuelto y los datos de sus etiquetas. */
export type YoutubeDownloadOptions = {
  jobId: string;
  url: string;
  userAgent?: string;
  contentLength?: number | null;
  /** Nombre del archivo sin extensión ("Artista - Título"). */
  baseName: string;
  /** Carpeta relativa a la raíz del almacenamiento ("Music/Impala"). */
  folder: string;
  title: string;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  track?: number | null;
  year?: number | null;
  /** Carátulas candidatas por preferencia (se recortan en cuadrado). */
  coverUrls: string[];
};

/** Lo que el editor de recortes necesita saber de un archivo. */
export type AudioProbe = {
  durationMs: number;
  /** aac, mp3, flac, opus, vorbis, pcm… */
  codec: string;
  /** mp4, mp3 u otro (la extensión). */
  container: string;
  suffix: string | null;
  size: number;
  /** DATE_MODIFIED del índice (s). */
  modified: number;
  /** Se puede recortar sin recodificar: AAC en M4A/MP4 o MP3. */
  canTrim: boolean;
};

export type DownloadEvent = { jobId: string; stage: 'downloading' | 'processing'; progress: number };

type Events = {
  /** Progreso de la descarga de YouTube en curso. */
  onDownload(e: DownloadEvent): void;
  /** El índice de Android cambió (archivos copiados, borrados o escaneados); llega agrupado. */
  onChange(): void;
  /** Progreso (0 a 1) de la descarga del APK de una actualización. */
  onUpdateDownload(e: { progress: number }): void;
};

declare class ImpalaLibraryModule extends NativeModule<Events> {
  /** Las canciones de esas carpetas ("Music/Impala/") y de sus subcarpetas. */
  getSongs(folders: string[]): Promise<DeviceSong[]>;
  /** Las carpetas que contienen audio, con cuántas canciones hay directamente en cada una. */
  getFolders(): Promise<DeviceFolder[]>;
  /** Crea la carpeta (relativa a la raíz del almacenamiento) si falta. Devuelve si existe al terminar. */
  ensureFolder(relativePath: string): boolean;
  /** El .lrc con el mismo nombre que el audio, en su carpeta; null si no hay o Android no deja leerlo. */
  readSidecarLyrics(id: string): Promise<string | null>;
  /** Borra la canción (Android 11+ pide confirmación con su diálogo). false si el usuario canceló. */
  deleteSong(id: string): Promise<boolean>;
  /** Descarga, re-empaqueta, etiqueta y guarda en la carpeta pública. Rechaza con code ERR_CANCELLED si se canceló. */
  downloadYoutube(options: YoutubeDownloadOptions): Promise<{ id: string; uri: string; fileName: string }>;
  cancelDownload(jobId: string): void;
  /** Duración, códec y si se puede recortar. */
  probeAudio(id: string): Promise<AudioProbe>;
  /** Picos de la forma de onda (0 a 1), decodificando el audio; en caché mientras el archivo no cambie. */
  waveform(id: string, points: number): Promise<number[]>;
  /** Escribe en `output` (ruta o file://) la canción con solo esos tramos (s). Devuelve la duración en ms. */
  trimToFile(id: string, keep: [number, number][], output: string): Promise<number>;
  /** Copia el archivo de la canción a `output`. */
  copySong(id: string, output: string): Promise<void>;
  /** Sustituye el archivo por `input` (Android 11+ pide permiso si no es de Impala). false si el usuario no lo dio. */
  overwriteSong(id: string, input: string): Promise<boolean>;
  /** Versión instalada (PackageInfo). */
  getAppVersion(): { versionName: string; versionCode: number };
  /** Solo para pruebas: el contenido de Android/data/<paquete>/files/update-test.json (lo pone adb), o null. */
  readUpdateOverride(): string | null;
  /** Si Android deja que Impala abra el instalador de APKs («Instalar apps desconocidas»). */
  canInstallPackages(): boolean;
  /** Abre el ajuste «Instalar apps desconocidas» de Impala. */
  openInstallSettings(): void;
  /** Descarga el APK a la caché (avisa con onUpdateDownload) y comprueba el tamaño; resuelve su ruta. ERR_CANCELLED si se canceló. */
  downloadUpdate(url: string, fileName: string, size: number): Promise<string>;
  cancelUpdateDownload(): void;
  /** Abre el instalador del sistema con ese APK (el usuario confirma con «Instalar»). */
  installUpdate(path: string): Promise<void>;
}

/** La música del teléfono (índice de Android). Solo Android. */
export default requireNativeModule<ImpalaLibraryModule>('ImpalaLibrary');
