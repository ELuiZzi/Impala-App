import { Channel } from '@tauri-apps/api/core';
import { noteWrittenFile } from '../../src/platform/web/file-system';
import { invoke, isTauri } from '../../src/platform/web/tauri';
import type { AudioProbe, DeviceFolder, DeviceSong, DownloadEvent, YoutubeDownloadOptions } from './index';

// Con nombre y no `export type *` (ver impala-player/index.web.ts).
export type { AudioProbe, DeviceFolder, DeviceSong, DownloadEvent, YoutubeDownloadOptions } from './index';

/**
 * La música del equipo en la app de PC, con la misma API que el módulo de Android (índice de MediaStore): la lee
 * Rust de las carpetas elegidas (desktop/src-tauri/src/library.rs) y sources/local.ts la usa igual que en el
 * teléfono. Recortar y descargar de YouTube al equipo usan el ffmpeg que va con la app (media.rs).
 */
type Listener = () => void;
const changeListeners = new Set<Listener>();

// library.rs avisa (agrupado) cuando cambian archivos en las carpetas elegidas.
if (typeof window !== 'undefined') {
  (window as { __impalaLibraryChange?: () => void }).__impalaLibraryChange = () => changeListeners.forEach((l) => l());
}

const downloadListeners = new Set<(e: DownloadEvent) => void>();

const ImpalaLibrary = {
  addListener(name: string, listener: (event: any) => void) {
    const set = name === 'onChange' ? changeListeners : name === 'onDownload' ? downloadListeners : null;
    if (!set) return { remove: () => {} };
    set.add(listener);
    return { remove: () => void set.delete(listener) };
  },
  removeAllListeners: () => {
    changeListeners.clear();
    downloadListeners.clear();
  },

  getSongs: async (folders: string[]): Promise<DeviceSong[]> => (isTauri() ? invoke<DeviceSong[]>('library_songs', { folders }) : []),
  /** Las carpetas con audio dentro de Música y de las ya elegidas. */
  getFolders: async (extra: string[] = []): Promise<DeviceFolder[]> => (isTauri() ? invoke<DeviceFolder[]>('library_folders', { extra }) : []),
  /** Síncrona como en Android: se crea por detrás. */
  ensureFolder: (relativePath: string) => {
    if (isTauri()) void invoke('library_ensure_folder', { folder: relativePath }).catch(() => {});
    return true;
  },
  readSidecarLyrics: async (id: string): Promise<string | null> => (isTauri() ? invoke<string | null>('library_sidecar_lyrics', { id }) : null),
  /** A la papelera de reciclaje (la app ya pidió confirmación). */
  deleteSong: async (id: string): Promise<boolean> => invoke<boolean>('library_delete', { id }),

  /** La descarga, remultiplexado, etiquetas y carátula los hace Rust con ffmpeg (desktop/src-tauri/src/media.rs). */
  downloadYoutube: async (options: YoutubeDownloadOptions): Promise<{ id: string; uri: string; fileName: string }> => {
    const onProgress = new Channel<{ stage: DownloadEvent['stage']; progress: number }>();
    onProgress.onmessage = ({ stage, progress }) => downloadListeners.forEach((l) => l({ jobId: options.jobId, stage, progress }));
    try {
      return await invoke('youtube_download', { job: options, onProgress });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // youtubeLocal.ts reconoce la cancelación por el código, como en Android.
      throw Object.assign(new Error(message), message === 'Descarga cancelada' ? { code: 'ERR_CANCELLED' } : {});
    }
  },
  cancelDownload: (jobId: string) => void invoke('fs_cancel', { key: jobId }).catch(() => {}),
  probeAudio: (id: string): Promise<AudioProbe> => invoke<AudioProbe>('media_probe', { id }),
  waveform: (id: string, points: number): Promise<number[]> => invoke<number[]>('media_waveform', { id, points }),
  trimToFile: async (id: string, keep: [number, number][], output: string): Promise<number> => {
    const ms = await invoke<number>('media_trim', { id, keep, output });
    noteWrittenFile(output);
    return ms;
  },
  copySong: async (id: string, output: string): Promise<void> => {
    await invoke('media_copy', { id, output });
    noteWrittenFile(output);
  },
  overwriteSong: (id: string, input: string): Promise<boolean> => invoke<boolean>('media_overwrite', { id, input }),

  /** Solo en PC: elegir otra carpeta con el selector de Windows (formato de las carpetas elegidas). */
  pickFolder: (): Promise<string | null> => invoke<string | null>('library_pick_folder'),
};

export default ImpalaLibrary;
