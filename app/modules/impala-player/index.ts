import { NativeModule, requireNativeModule } from 'expo';

export type PlaybackState = 'idle' | 'buffering' | 'ready' | 'ended';
export type RepeatMode = 'off' | 'one' | 'all';

export type NativeTrack = {
  id: string;
  url: string;
  title: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
};

/** speed: velocidad de reproducción (sped up/slowed); la posición es del audio y avanza a ese ritmo. */
export type ProgressEvent = { positionMs: number; bufferedMs: number; durationMs: number | null; speed: number };

/** Velocidad y tono. vinyl: el tono sigue a la velocidad (como un disco); si no, solo cambia la velocidad. */
export type PlaybackTuning = { speed: number; semitones: number; vinyl: boolean; reverb: boolean };

export type StateEvent = ProgressEvent & {
  isPlaying: boolean;
  playWhenReady: boolean;
  playbackState: PlaybackState;
  index: number;
  trackId: string | null;
  queueLength: number;
  repeatMode: RepeatMode;
  /** Modo aleatorio tal como lo fijó la app (setShuffleMode); sirve para recuperarlo tras recargar el JS. */
  shuffle: boolean;
};

export type TrackChangeEvent = {
  index: number;
  trackId: string | null;
  reason: 'auto' | 'seek' | 'repeat' | 'playlistChanged';
};

export type ErrorEvent = { code: string; message: string };

/** Vista previa de YouTube: 'stopped' llega al detenerla a mano; 'ended' y 'error' la liberan solas. */
export type PreviewEvent = {
  state: 'loading' | 'playing' | 'ended' | 'error' | 'stopped';
  positionMs?: number;
  durationMs?: number | null;
  /** Vista previa por tramos (startPreviewClips): el tramo que suena; positionMs es dentro de él. */
  itemIndex?: number;
  message?: string;
};

/** endsAt: hora (ms desde epoch) en que pausará; endOfTrack: pausará al terminar la canción. */
export type SleepTimerEvent = { endsAt: number | null; endOfTrack: boolean };

/**
 * Volumen gradual (gym). active: subiendo; lastEnd: por qué terminó la última subida ('done' llegó al
 * máximo, 'manual' se movió el volumen con los botones, 'limit' Android no dejó subir más, 'stopped').
 */
export type GymRampEvent = {
  active: boolean;
  lastEnd: 'done' | 'manual' | 'limit' | 'stopped' | null;
  progress: number;
  startPercent: number;
  targetPercent: number;
  currentPercent: number;
  remainingMs: number;
};

export type GymSettings = { maxPercent: number; minutes: number };

export type NetworkInfo = { connected: boolean; metered: boolean; wifi: boolean; cellular: boolean; vpn: boolean };

type Events = {
  onStateChange(event: StateEvent): void;
  onTrackChange(event: TrackChangeEvent): void;
  onProgress(event: ProgressEvent): void;
  onError(event: ErrorEvent): void;
  onPreview(event: PreviewEvent): void;
  onSleepTimer(event: SleepTimerEvent): void;
  onGymRamp(event: GymRampEvent): void;
  /** Se tocó el botón de aleatorio de la notificación o la pantalla de bloqueo. */
  onShuffleRequest(): void;
};

declare class ImpalaPlayerModule extends NativeModule<Events> {
  setQueue(tracks: NativeTrack[], startIndex: number, startPositionMs: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seekTo(positionMs: number): Promise<void>;
  skipTo(index: number): Promise<void>;
  setRepeatMode(mode: RepeatMode): Promise<void>;
  /** Refleja el modo aleatorio de la app en el botón de la notificación (no reordena nada). */
  setShuffleMode(enabled: boolean): Promise<void>;
  /** Crossfade entre pistas en ms (0 = desactivado). Persiste en el teléfono. */
  setCrossfadeMs(ms: number): void;
  getCrossfadeMs(): number;
  /** Potenciador de volumen en dB por encima del 100 % (0 = desactivado, máx. 15). Se aplica al instante. */
  setVolumeBoostDb(db: number): void;
  getVolumeBoostDb(): number;
  /** Fuente de música actual: los ajustes de velocidad por canción se guardan por fuente. */
  setTuningScope(scope: string): void;
  /** Ajustes propios de la canción (perSong) o los globales; sin songId, los globales. */
  getPlaybackTuning(songId: string | null): PlaybackTuning & { perSong: boolean };
  /** Se aplica al instante; con songId solo para esa canción, sin él como ajuste global. */
  setPlaybackTuning(songId: string | null, speed: number, semitones: number, vinyl: boolean, reverb: boolean): void;
  clearSongTuning(songId: string): void;
  isTailscaleInstalled(): boolean;
  /** Si Impala enciende Tailscale al abrirse y lo apaga al cerrarse (por defecto, sí). */
  getManageTailscale(): boolean;
  setManageTailscale(enabled: boolean): void;
  /** Llamar al pasar a primer plano: enciende Tailscale si Impala lo gestiona. Devuelve si la VPN ya estaba activa. */
  onAppForeground(): boolean;
  /** Inserta en `index` (-1 = al final). Si la cola está vacía, la crea sin empezar a sonar. */
  insertTracks(tracks: NativeTrack[], index: number): Promise<void>;
  moveTrack(from: number, to: number): Promise<void>;
  /** Vuelve a abrir las pistas con el id de `track` (el archivo cambió): la actual sigue en su posición. */
  reloadTrack(track: NativeTrack): Promise<void>;
  removeTrack(index: number): Promise<void>;
  /** `order`: índices actuales de las pistas posteriores a la actual, en el nuevo orden. */
  setUpcomingOrder(order: number[]): Promise<void>;
  stop(): Promise<void>;
  /** Temporizador de reposo (vive junto al servicio): ms > 0 pausa tras ese tiempo, -1 al terminar la canción, 0 lo cancela. */
  setSleepTimer(ms: number): Promise<void>;
  getSleepTimer(): SleepTimerEvent;
  /** Empieza a subir el volumen multimedia, desde el actual hasta el máximo de getGymSettings. */
  startGymRamp(): Promise<void>;
  stopGymRamp(): Promise<void>;
  getGymRamp(): GymRampEvent;
  getGymSettings(): GymSettings;
  setGymSettings(maxPercent: number, minutes: number): void;
  /** Hasta 5 colores (#rrggbb) de una carátula, los más vistosos primero; [] si no se pudo leer. */
  getArtworkColors(url: string): Promise<string[]>;
  /** Reproductor aparte para escuchar un audio sin tocar la cola (vista previa de YouTube). */
  startPreview(url: string): Promise<void>;
  /** Vista previa de un recorte: solo los tramos [inicio, fin] (ms), seguidos, desde el tramo `index` en `positionMs`. */
  startPreviewClips(url: string, clips: [number, number][], index: number, positionMs: number): Promise<void>;
  stopPreview(): Promise<void>;
  getState(): Promise<StateEvent>;
  getQueue(): Promise<Omit<NativeTrack, 'url'>[]>;
  /** Síncrono: estado de la red activa (a través de la VPN de Tailscale). */
  getNetworkInfo(): NetworkInfo;
  /** MD5 en hexadecimal de un archivo file:// o content://, calculado fuera del hilo de JS. */
  md5(uri: string): Promise<string>;
}

/** Reproductor nativo (Media3/ExoPlayer en un MediaSessionService). Solo Android. */
export default requireNativeModule<ImpalaPlayerModule>('ImpalaPlayer');
