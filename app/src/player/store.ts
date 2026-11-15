import { useSyncExternalStore } from 'react';
import ImpalaPlayer, { type PlaybackState, type RepeatMode, type StateEvent } from '../../modules/impala-player';
import type { MusicSource, Song, StreamQuality } from '@/sources';
import { albumName, artistName } from '@/components/theme';
import { isDownloaded, localSongUri } from '@/offline/store';
import { cancelPreview } from './preview';
import { resolveQuality } from './quality';

/**
 * Entrada de la cola: una canción puede repetirse, así que cada entrada lleva su propio uid.
 * `seq` es su posición en el orden original, para deshacer el modo aleatorio.
 */
export type QueueEntry = Song & { uid: string; seq: number };

let uidCounter = 0;
const toEntry = (song: Song, seq = uidCounter + 1): QueueEntry => ({ ...song, uid: `q${++uidCounter}`, seq });

export type PlayerSnapshot = {
  queue: QueueEntry[];
  index: number;
  isPlaying: boolean;
  /** true mientras el usuario quiere que suene (aunque esté cargando). */
  playWhenReady: boolean;
  playbackState: PlaybackState;
  positionMs: number;
  bufferedMs: number;
  durationMs: number | null;
  /** Velocidad de reproducción (sped up / slowed): la posición avanza a este ritmo respecto al reloj. */
  speed: number;
  repeatMode: RepeatMode;
  /** Modo aleatorio: lo que viene después de la canción actual está mezclado. */
  shuffle: boolean;
  quality: StreamQuality | null;
  error: string | null;
};

const initial: PlayerSnapshot = {
  queue: [],
  index: -1,
  isPlaying: false,
  playWhenReady: false,
  playbackState: 'idle',
  positionMs: 0,
  bufferedMs: 0,
  durationMs: null,
  speed: 1,
  repeatMode: 'off',
  shuffle: false,
  quality: null,
  error: null,
};

let state = initial;
const listeners = new Set<() => void>();

function set(patch: Partial<PlayerSnapshot>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** El selector debe devolver primitivos o referencias estables (p. ej. un Song de la cola). */
export function usePlayer<T>(selector: (s: PlayerSnapshot) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const currentSong = (s: PlayerSnapshot): QueueEntry | undefined => s.queue[s.index];

/** Si hay algo sonando (o a punto de sonar) ahora mismo. */
export const isPlaying = () => state.playWhenReady && state.queue.length > 0;

// --- Sincronización con el módulo nativo -------------------------------------------------

let source: MusicSource | null = null;
let subscriptions: { remove(): void }[] = [];
/** Posición máxima alcanzada en la pista actual, para decidir si cuenta como escuchada. */
let listenedMs = 0;

function applyNative(e: StateEvent) {
  set({
    index: e.index,
    isPlaying: e.isPlaying,
    playWhenReady: e.playWhenReady,
    playbackState: e.playbackState,
    positionMs: e.positionMs,
    bufferedMs: e.bufferedMs,
    durationMs: e.durationMs,
    speed: e.speed ?? 1,
    repeatMode: e.repeatMode,
    ...(e.queueLength === 0 ? { queue: [], index: -1 } : {}),
  });
}

/** Last.fm/Navidrome: cuenta como escuchada a partir de la mitad o de 4 minutos. */
function maybeScrobble(song: Song | undefined) {
  if (!source || !song) return;
  const durationMs = (song.duration ?? 0) * 1000;
  const threshold = Math.min(durationMs / 2, 4 * 60 * 1000);
  if (durationMs > 0 && listenedMs >= threshold) {
    source.scrobble(song.id, true).catch(() => {});
  }
}

/** Conecta con el servicio nativo; si ya estaba sonando algo (JS recargado), recupera la cola. */
export async function initPlayer(s: MusicSource) {
  source = s;
  // Los ajustes de velocidad por canción se guardan por fuente (los ids solo son únicos dentro de una).
  ImpalaPlayer.setTuningScope(s.key.join(':'));
  if (subscriptions.length === 0) {
    subscriptions = [
      ImpalaPlayer.addListener('onStateChange', applyNative),
      ImpalaPlayer.addListener('onProgress', (e) => {
        listenedMs = Math.max(listenedMs, e.positionMs);
        set({ positionMs: e.positionMs, bufferedMs: e.bufferedMs, durationMs: e.durationMs, speed: e.speed ?? 1 });
      }),
      ImpalaPlayer.addListener('onTrackChange', (e) => {
        const previous = currentSong(state);
        if (previous && previous.id !== e.trackId) maybeScrobble(previous);
        listenedMs = 0;
        set({ index: e.index, error: null });
        if (source && e.trackId) source.scrobble(e.trackId, false).catch(() => {});
      }),
      ImpalaPlayer.addListener('onError', (e) => set({ error: describeError(e.code, e.message) })),
      // Botón de aleatorio de la notificación: lo mismo que el de la app.
      ImpalaPlayer.addListener('onShuffleRequest', () => void toggleShuffle()),
    ];
  }
  await syncPlayer();
}

/**
 * Trae la cola y el estado del servicio nativo. También al volver a primer plano: si la app se
 * cerró desde recientes, el servicio se liberó y la cola que recuerda el JS ya no existe.
 */
export async function syncPlayer() {
  if (!source) return;
  const s = source;
  try {
    const native = await ImpalaPlayer.getState();
    if (native.queueLength > 0 && state.queue.length === 0) {
      const queue = await ImpalaPlayer.getQueue();
      set({
        queue: queue.map((t) =>
          toEntry({ id: t.id, title: t.title, artist: t.artist, album: t.album, coverArt: s.coverArtFromUrl(t.artworkUrl) }),
        ),
        shuffle: native.shuffle,
      });
    }
    applyNative(native);
  } catch {
    // El servicio aún no existe: se creará al reproducir por primera vez.
  }
}

/** Al cerrar sesión: detiene la música y olvida la cola. */
export async function resetPlayer() {
  const wasActive = source !== null || state.queue.length > 0;
  source = null;
  // Sin sesión previa no hay nada que detener: conectar crearía el servicio sin motivo.
  if (wasActive) await ImpalaPlayer.stop().catch(() => {});
  set(initial);
}

function describeError(code: string, message: string): string {
  if (code.includes('NETWORK') || code.includes('IO_')) return 'Sin conexión con el servidor';
  if (code.includes('DECODING') || code.includes('PARSING')) return 'Formato no compatible';
  return message;
}

// --- Acciones -----------------------------------------------------------------------------

function toNativeTrack(s: MusicSource, song: Song, quality: StreamQuality) {
  return {
    id: song.id,
    // Si está descargada se reproduce el archivo local: sin datos y sin depender del servidor.
    url: (s.capabilities.offlineDownloads ? localSongUri(song.id) : null) ?? s.streamUrl(song.id, quality),
    title: song.title,
    // La notificación y la pantalla de bloqueo muestran esto tal cual: sin marcadores de Navidrome.
    artist: artistName(song.artist),
    album: albumName(song.album) ?? undefined,
    artworkUrl: s.coverUrl(song.coverArt, 600),
  };
}

/** Sin streaming (la música del teléfono) siempre suena el archivo tal cual. */
const qualityFor = (s: MusicSource): Promise<StreamQuality> => (s.capabilities.streamQuality ? resolveQuality() : Promise.resolve('original'));

function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Reproduce una lista. `shuffle: true` (botón "Aleatorio") la mezcla entera y activa el modo
 * aleatorio; sin indicarlo se respeta el modo actual: si está activo, suena primero la elegida y
 * el resto se mezcla (como Apple Music).
 */
export async function playSongs(songs: Song[], startIndex: number, opts: { shuffle?: boolean } = {}) {
  if (!source || songs.length === 0) return;
  const s = source;
  cancelPreview();
  let candidates = songs;
  let chosen = startIndex;
  // Sin conexión solo pueden sonar las descargadas: se omiten las demás (la música del teléfono suena siempre).
  if (s.capabilities.offlineDownloads && !ImpalaPlayer.getNetworkInfo().connected) {
    const target = songs[startIndex];
    candidates = songs.filter((song) => isDownloaded(song.id));
    if (candidates.length === 0) {
      set({ error: 'Sin conexión: esta canción no está descargada' });
      return;
    }
    chosen = Math.max(0, candidates.findIndex((song) => song.id === target?.id));
  }
  const shuffle = opts.shuffle ?? state.shuffle;
  const entries = candidates.map((song, i) => toEntry(song, i));
  let queue = entries;
  let start = chosen;
  if (opts.shuffle) {
    queue = shuffled(entries);
    start = 0;
  } else if (shuffle) {
    queue = [entries[chosen], ...shuffled(entries.filter((_, i) => i !== chosen))];
    start = 0;
  }
  const quality = await qualityFor(s);
  listenedMs = 0;
  set({ queue, index: start, shuffle, quality, error: null, positionMs: 0, playWhenReady: true });
  await ImpalaPlayer.setQueue(queue.map((song) => toNativeTrack(s, song, quality)), start, 0);
  void syncShuffleButton();
}

// --- Edición de la cola ---------------------------------------------------------------------

async function insert(songs: Song[], position: 'next' | 'end') {
  if (!source || songs.length === 0) return;
  if (state.queue.length === 0) return playSongs(songs, 0);
  const quality = state.quality ?? (await qualityFor(source));
  const at = position === 'next' ? state.index + 1 : state.queue.length;
  // "A continuación" queda justo detrás de la actual también al desactivar el aleatorio.
  const base = position === 'next' ? (state.queue[state.index]?.seq ?? 0) : Math.max(0, ...state.queue.map((e) => e.seq)) + 1;
  const entries = songs.map((song, i) => toEntry(song, base + (position === 'next' ? (i + 1) / (songs.length + 1) : i)));
  const s = source;
  set({ queue: [...state.queue.slice(0, at), ...entries, ...state.queue.slice(at)] });
  await ImpalaPlayer.insertTracks(songs.map((song) => toNativeTrack(s, song, quality)), at);
}

/**
 * La canción cambió en disco (recorte o restauración). El reproductor la tenía abierta con el formato del
 * archivo anterior: seguir leyéndola daba audio corrupto (y el decodificador, reutilizado por las demás
 * canciones, podía quedar mal hasta reiniciar la app). Sus copias en la cola se vuelven a abrir; la que suena
 * sigue en el mismo punto.
 */
export async function reloadSong(song: Song) {
  if (!source || !state.queue.some((e) => e.id === song.id)) return;
  const quality = state.quality ?? (await qualityFor(source));
  await ImpalaPlayer.reloadTrack(toNativeTrack(source, song, quality));
}

/** true si la canción que suena (o va a sonar) es `songId`. */
export const isCurrentSong = (songId: string) => state.queue[state.index]?.id === songId;

/** "Reproducir a continuación": justo después de la canción actual. */
export const playNext = (songs: Song[]) => insert(songs, 'next');
/** "Añadir a la cola": al final. */
export const addToQueue = (songs: Song[]) => insert(songs, 'end');

/** Mueve una entrada (índices absolutos de la cola) manteniendo el índice de la que suena. */
export async function moveInQueue(from: number, to: number) {
  if (from === to) return;
  const queue = [...state.queue];
  const [entry] = queue.splice(from, 1);
  queue.splice(to, 0, entry);
  let index = state.index;
  if (from === index) index = to;
  else if (from < index && to >= index) index--;
  else if (from > index && to <= index) index++;
  set({ queue, index });
  await ImpalaPlayer.moveTrack(from, to);
}

export async function removeFromQueue(position: number) {
  if (position === state.index) return; // la que suena no se quita desde la cola
  set({
    queue: state.queue.filter((_, i) => i !== position),
    index: position < state.index ? state.index - 1 : state.index,
  });
  await ImpalaPlayer.removeTrack(position);
}

/** Quita de la cola todas las apariciones de una canción (salvo la que suena), p. ej. al borrarla. */
export async function removeSongFromQueue(id: string) {
  for (let i = state.queue.length - 1; i >= 0; i--) {
    if (state.queue[i].id === id && i !== state.index) await removeFromQueue(i);
  }
}

/** Mezcla solo lo que viene después de la canción actual, sin interrumpirla. */
export async function shuffleUpcoming() {
  set({ shuffle: true });
  void syncShuffleButton();
  await reorderUpcoming(shuffled);
}

/**
 * Activa o desactiva el modo aleatorio sin interrumpir la canción actual. Al desactivarlo, lo que
 * queda vuelve al orden original: primero lo que iba después de la actual y luego lo anterior que
 * aún no ha sonado.
 */
export async function toggleShuffle() {
  if (!state.shuffle) return shuffleUpcoming();
  set({ shuffle: false });
  void syncShuffleButton();
  const currentSeq = state.queue[state.index]?.seq ?? 0;
  await reorderUpcoming((items) => {
    const sorted = [...items].sort((a, b) => a.entry.seq - b.entry.seq);
    return [...sorted.filter((o) => o.entry.seq > currentSeq), ...sorted.filter((o) => o.entry.seq <= currentSeq)];
  });
}

/** El botón de aleatorio de la notificación muestra el modo de la app. */
const syncShuffleButton = () => ImpalaPlayer.setShuffleMode(state.shuffle).catch(() => {});

type Upcoming = { entry: QueueEntry; original: number };

async function reorderUpcoming(order: (items: Upcoming[]) => Upcoming[]) {
  const start = state.index + 1;
  const upcoming = state.queue.slice(start).map((entry, i) => ({ entry, original: start + i }));
  if (upcoming.length < 2) return;
  const next = order(upcoming);
  set({ queue: [...state.queue.slice(0, start), ...next.map((o) => o.entry)] });
  await ImpalaPlayer.setUpcomingOrder(next.map((o) => o.original));
}

export const togglePlay = () => (state.playWhenReady ? ImpalaPlayer.pause() : ImpalaPlayer.play());
export const next = () => ImpalaPlayer.next();
export const previous = () => ImpalaPlayer.previous();
/**
 * Siempre a la canción anterior (el gesto de deslizar hacia abajo): a diferencia de [previous], no
 * reinicia la actual aunque lleve más de 3 s. En la primera, sin repetir todo, vuelve al principio.
 */
export function previousTrack() {
  if (state.index > 0) return ImpalaPlayer.skipTo(state.index - 1);
  if (state.repeatMode === 'all' && state.queue.length > 1) return ImpalaPlayer.skipTo(state.queue.length - 1);
  return seekTo(0);
}
/** Hay una canción después (o se vuelve al principio con repetir todo). */
export const hasNextTrack = (s: PlayerSnapshot) => s.index < s.queue.length - 1 || (s.repeatMode === 'all' && s.queue.length > 1);
export const skipTo = (index: number) => ImpalaPlayer.skipTo(index);

export function seekTo(positionMs: number) {
  set({ positionMs });
  return ImpalaPlayer.seekTo(positionMs);
}

export function cycleRepeat() {
  const nextMode: RepeatMode = state.repeatMode === 'off' ? 'all' : state.repeatMode === 'all' ? 'one' : 'off';
  return ImpalaPlayer.setRepeatMode(nextMode);
}
