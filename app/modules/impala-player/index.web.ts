import { getArtworkColors } from './web/colors';
import * as engine from './web/engine';
import { addListener, removeAllListeners } from './web/events';
import { clearSongTuning, prefs, saveTuning, tuningFor, updatePrefs } from './web/prefs';
import { seekPreview, setPreviewPlaying, startPreview, startPreviewClips, stopPreview } from './web/preview';

// Con nombre y no `export type *`: el resolvedor de ESLint puede llevar './index' a este mismo archivo y el
// `export *` se apuntaría a sí mismo (bucle infinito en eslint-plugin-import).
export type {
  ErrorEvent,
  GymRampEvent,
  GymSettings,
  NativeTrack,
  NetworkInfo,
  PlaybackState,
  PlaybackTuning,
  PreviewEvent,
  ProgressEvent,
  RepeatMode,
  SleepTimerEvent,
  StateEvent,
  TrackChangeEvent,
} from './index';

/**
 * Reproductor de la app de PC (WebView de Tauri), con la misma API que el módulo de Android
 * (ImpalaPlayerModule.kt): player/store.ts no distingue uno de otro. Ver web/engine.ts.
 */
const ImpalaPlayer = {
  addListener,
  removeAllListeners,

  setQueue: engine.setQueue,
  play: engine.play,
  pause: engine.pause,
  next: engine.next,
  previous: engine.previous,
  seekTo: engine.seekTo,
  skipTo: engine.skipTo,
  setRepeatMode: engine.setRepeatMode,
  setShuffleMode: engine.setShuffleMode,
  insertTracks: engine.insertTracks,
  moveTrack: engine.moveTrack,
  reloadTrack: engine.reloadTrack,
  removeTrack: engine.removeTrack,
  setUpcomingOrder: engine.setUpcomingOrder,
  stop: engine.stop,
  getState: async () => engine.getState(),
  getQueue: engine.getQueue,

  setCrossfadeMs: (ms: number) => updatePrefs({ crossfadeMs: Math.min(12_000, Math.max(0, Math.round(ms))) }),
  getCrossfadeMs: () => prefs().crossfadeMs,
  setVolumeBoostDb: (db: number) => engine.setBoost(Math.min(15, Math.max(0, Math.round(db)))),
  getVolumeBoostDb: () => prefs().boostDb,

  setTuningScope: (scope: string) => {
    updatePrefs({ tuningScope: scope });
    engine.applyTuningToAll();
  },
  getPlaybackTuning: (songId: string | null) => tuningFor(songId),
  setPlaybackTuning: (songId: string | null, speed: number, semitones: number, vinyl: boolean, reverb: number) => {
    saveTuning(songId, { speed, semitones, vinyl, reverb });
    engine.applyTuningToAll();
  },
  clearSongTuning: (songId: string) => {
    clearSongTuning(songId);
    engine.applyTuningToAll();
  },

  setSleepTimer: engine.setSleepTimer,
  getSleepTimer: engine.getSleepTimer,
  startGymRamp: engine.startGymRamp,
  stopGymRamp: engine.stopGymRamp,
  getGymRamp: engine.getGymRamp,
  getGymSettings: () => prefs().gym,
  setGymSettings: (maxPercent: number, minutes: number) =>
    updatePrefs({ gym: { maxPercent: Math.min(100, Math.max(10, maxPercent)), minutes: Math.min(120, Math.max(1, minutes)) } }),

  getArtworkColors,
  startPreview,
  startPreviewClips,
  setPreviewPlaying,
  seekPreview,
  stopPreview,

  // En PC se usa el cliente de Tailscale de Windows: Impala no lo enciende ni lo apaga.
  isTailscaleInstalled: () => false,
  getManageTailscale: () => false,
  setManageTailscale: () => {},
  onAppForeground: () => true,
  getNetworkInfo: () => ({ connected: navigator.onLine, metered: false, wifi: true, cellular: false, vpn: false }),
  md5: async (): Promise<string> => {
    throw new Error('md5 no disponible en PC todavía');
  },

  /** Solo en PC: volumen de la app (0 a 1). La barra de volumen llega en la Fase 3. */
  getVolume: engine.getVolume,
  setVolume: (volume: number) => engine.setVolume(volume),
};

export default ImpalaPlayer;
