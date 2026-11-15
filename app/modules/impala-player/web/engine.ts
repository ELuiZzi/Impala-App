import type { GymRampEvent, NativeTrack, PlaybackState, RepeatMode, SleepTimerEvent, StateEvent } from '../index';
import { connectDeck, resumeAudio, setAppVolume, setBoostDb, type DeckChain } from './effects';
import { emit } from './events';
import { clearMediaSession, setMediaSessionHandlers, updateMediaSession } from './mediaSession';
import { prefs, tuningFor, updatePrefs } from './prefs';

/**
 * Reproductor de PC: lo mismo que el PlaybackService + CrossfadeController de Android, con dos <audio>
 * («decks») que se turnan. Uno suena; el otro tiene ya cargada la siguiente canción, así que el cambio es
 * inmediato y el crossfade no necesita relevo: al terminar el fundido, simplemente se intercambian.
 */

const PROGRESS_MS = 500;
const TICK_MS = 50;
/** «Anterior» reinicia la canción si ya pasaron 3 s (como ExoPlayer y Apple Music). */
const PREVIOUS_RESTART_MS = 3000;
const END_MARGIN_MS = 300;
const MIN_FADE_MS = 1000;

type Deck = {
  audio: HTMLAudioElement;
  chain: DeckChain | null;
  track: NativeTrack | null;
  /** Identifica lo cargado: url + recarga (un recorte cambia el archivo con la misma url). */
  key: string;
  waiting: boolean;
};

function newDeck(): Deck {
  const audio = new Audio();
  // Navidrome responde con Access-Control-Allow-Origin: *; sin esto Web Audio dejaría el audio en silencio.
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  return { audio, chain: null, track: null, key: '', waiting: false };
}

const decks: [Deck, Deck] = [newDeck(), newDeck()];
let cur = 0;
const current = () => decks[cur];
const other = () => decks[1 - cur];

let queue: NativeTrack[] = [];
let index = -1;
let playWhenReady = false;
let ended = false;
let errored = false;
let repeatMode: RepeatMode = 'off';
let shuffle = false;
let reloadCounter = 0;
let graphReady = false;

type Fade = { startedAt: number; ms: number; nextIndex: number };
let fade: Fade | null = null;

// --- Grafo de audio ---------------------------------------------------------------------------

/** Se conecta al primer uso: crear el AudioContext antes de un gesto del usuario lo deja suspendido. */
function ensureGraph() {
  if (graphReady) return;
  graphReady = true;
  for (const deck of decks) deck.chain = connectDeck(deck.audio);
  decks[0].chain!.gain.gain.value = 1;
  decks[1].chain!.gain.gain.value = 1;
  setBoostDb(prefs().boostDb);
  setAppVolume(prefs().volume);
  for (const deck of decks) applyTuning(deck);
}

export function applyTuning(deck: Deck) {
  const t = tuningFor(deck.track?.id);
  deck.audio.preservesPitch = !t.vinyl;
  deck.audio.defaultPlaybackRate = t.speed;
  deck.audio.playbackRate = t.speed;
  deck.chain?.setPitchRatio(Math.pow(2, t.semitones / 12));
  deck.chain?.setReverb(t.reverb / 100);
}

export function applyTuningToAll() {
  decks.forEach(applyTuning);
  emitState();
}

export function setBoost(db: number) {
  updatePrefs({ boostDb: db });
  if (graphReady) setBoostDb(db);
}

export function getVolume() {
  return prefs().volume;
}

export function setVolume(volume: number, fromGym = false) {
  const v = Math.min(1, Math.max(0, volume));
  updatePrefs({ volume: v });
  if (graphReady) setAppVolume(v);
  emit('onVolumeChange', { volume: v });
  if (!fromGym && gym.active) stopGym('manual');
}

// --- Carga -------------------------------------------------------------------------------------

const keyOf = (track: NativeTrack, reload = 0) => `${track.url}#${reload}`;

function load(deck: Deck, track: NativeTrack, positionMs = 0, reload = false) {
  const key = keyOf(track, reload ? ++reloadCounter : 0);
  deck.track = track;
  if (deck.key !== key || reload) {
    deck.key = key;
    deck.waiting = true;
    deck.audio.src = track.url;
    deck.audio.load();
  }
  if (positionMs > 0) deck.audio.currentTime = positionMs / 1000;
  setGain(deck, 1);
  applyTuning(deck);
}

function unload(deck: Deck) {
  deck.audio.pause();
  deck.audio.removeAttribute('src');
  deck.audio.load();
  deck.track = null;
  deck.key = '';
  deck.waiting = false;
}

function setGain(deck: Deck, value: number) {
  const gain = deck.chain?.gain.gain;
  if (!gain) return;
  gain.cancelScheduledValues(0);
  gain.value = value;
}

async function playDeck(deck: Deck) {
  ensureGraph();
  await resumeAudio();
  try {
    await deck.audio.play();
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') return; // se cambió de canción mientras arrancaba
    if ((e as DOMException)?.name === 'NotAllowedError') {
      playWhenReady = false;
      emitState();
      return;
    }
    throw e;
  }
}

// --- Navegación por la cola ---------------------------------------------------------------------

/** La que sigue al terminar la actual (sin «repetir una»): null al final de la cola. */
function nextIndex(): number | null {
  if (index + 1 < queue.length) return index + 1;
  return repeatMode === 'all' && queue.length > 0 ? 0 : null;
}

function previousIndex(): number | null {
  if (index > 0) return index - 1;
  return repeatMode === 'all' && queue.length > 0 ? queue.length - 1 : null;
}

/** Pasa a la canción [i]. Si el otro deck ya la tiene cargada, se usa ese (sin esperas). */
function go(i: number, reason: 'auto' | 'seek' | 'repeat' | 'playlistChanged', positionMs = 0) {
  cancelFade();
  const track = queue[i];
  if (!track) return;
  const previous = current();
  if (other().key === keyOf(track) && positionMs === 0) {
    previous.audio.pause();
    cur = 1 - cur;
    current().audio.currentTime = 0;
    setGain(current(), 1);
    applyTuning(current());
  } else {
    previous.audio.pause();
    load(current(), track, positionMs);
  }
  index = i;
  ended = false;
  errored = false;
  emit('onTrackChange', { index, trackId: track.id, reason });
  updateMediaSession(track);
  prepareNext();
  if (playWhenReady) void playDeck(current());
  emitState();
}

/** Deja la siguiente cargada en el otro deck, en pausa, para que suene sin demora. */
function prepareNext() {
  if (fade) return;
  const n = repeatMode === 'one' ? null : nextIndex();
  const deck = other();
  if (n == null) {
    if (deck.track) unload(deck);
    return;
  }
  const track = queue[n];
  if (deck.key === keyOf(track)) return;
  deck.audio.pause();
  load(deck, track);
}

function onEnded(deck: Deck) {
  if (deck !== current()) return;
  if (fade) return finishFade();
  if (repeatMode === 'one') {
    deck.audio.currentTime = 0;
    emit('onTrackChange', { index, trackId: queue[index]?.id ?? null, reason: 'repeat' });
    if (sleep.endOfTrack) {
      pauseForSleep();
    } else {
      void playDeck(deck);
    }
    return;
  }
  const n = nextIndex();
  if (n == null) {
    ended = true;
    if (sleep.endOfTrack) clearSleep();
    emitState();
    return;
  }
  if (sleep.endOfTrack) {
    playWhenReady = false;
    go(n, 'auto');
    clearSleep();
    return;
  }
  go(n, 'auto');
}

// --- Crossfade (como CrossfadeController.kt) ---------------------------------------------------

function crossfadeMs(): number {
  return sleep.endOfTrack ? 0 : prefs().crossfadeMs;
}

const wallRemainingMs = (deck: Deck): number | null => {
  const d = deck.audio.duration;
  if (!Number.isFinite(d) || d <= 0) return null;
  return ((d - deck.audio.currentTime) * 1000) / Math.max(0.1, deck.audio.playbackRate);
};

function sameAlbum(a: NativeTrack | undefined, b: NativeTrack | undefined) {
  if (!a?.album || !b?.album) return false;
  return a.album === b.album && a.artist === b.artist;
}

function maybeStartFade() {
  const ms = crossfadeMs();
  if (fade || ms <= 0 || !isPlayingNow() || repeatMode === 'one') return;
  const n = nextIndex();
  if (n == null) return;
  const deck = current();
  const remaining = wallRemainingMs(deck);
  if (remaining == null || remaining > ms + END_MARGIN_MS) return;
  if ((deck.audio.duration * 1000) / deck.audio.playbackRate < ms * 3) return;
  if (sameAlbum(queue[index], queue[n])) return;
  const next = other();
  if (next.key !== keyOf(queue[n]) || next.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
  const fadeMs = Math.max(MIN_FADE_MS, Math.min(ms, remaining - END_MARGIN_MS));
  fade = { startedAt: performance.now(), ms: fadeMs, nextIndex: n };
  scheduleFadeCurves(deck, next, fadeMs);
  next.audio.currentTime = 0;
  void playDeck(next);
}

/** Curvas de igual potencia (cos/sin) programadas en el AudioContext: suaves aunque el temporizador se retrase. */
function scheduleFadeCurves(out: Deck, inn: Deck, ms: number) {
  const steps = 64;
  const down = new Float32Array(steps);
  const up = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const p = i / (steps - 1);
    down[i] = Math.cos((p * Math.PI) / 2);
    up[i] = Math.sin((p * Math.PI) / 2);
  }
  const outGain = out.chain?.gain.gain;
  const inGain = inn.chain?.gain.gain;
  if (!outGain || !inGain) return;
  const ctx = out.chain!.gain.context;
  outGain.cancelScheduledValues(0);
  inGain.cancelScheduledValues(0);
  outGain.setValueCurveAtTime(down, ctx.currentTime, ms / 1000);
  inGain.setValueCurveAtTime(up, ctx.currentTime, ms / 1000);
}

function finishFade() {
  const f = fade;
  if (!f) return;
  fade = null;
  const old = current();
  old.audio.pause();
  cur = 1 - cur;
  setGain(current(), 1);
  setGain(old, 1);
  index = f.nextIndex;
  ended = false;
  const track = queue[index];
  emit('onTrackChange', { index, trackId: track?.id ?? null, reason: 'auto' });
  if (track) updateMediaSession(track);
  prepareNext();
  emitState();
}

/** Pausar, buscar, saltar o editar la cola cancela el fundido: vuelve a sonar solo la actual. */
function cancelFade() {
  if (!fade) return;
  fade = null;
  const next = other();
  next.audio.pause();
  next.audio.currentTime = 0;
  setGain(current(), 1);
  setGain(next, 1);
}

// --- Estado y eventos --------------------------------------------------------------------------

function playbackState(): PlaybackState {
  if (queue.length === 0 || errored) return 'idle';
  if (ended) return 'ended';
  const deck = current();
  if (deck.waiting || deck.audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return 'buffering';
  return 'ready';
}

function isPlayingNow() {
  return playWhenReady && !current().audio.paused && playbackState() === 'ready';
}

function progress() {
  const audio = current().audio;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : null;
  let bufferedMs = 0;
  for (let i = 0; i < audio.buffered.length; i++) {
    if (audio.buffered.start(i) <= audio.currentTime + 0.5) bufferedMs = Math.max(bufferedMs, audio.buffered.end(i) * 1000);
  }
  return { positionMs: audio.currentTime * 1000, bufferedMs, durationMs: duration, speed: audio.playbackRate };
}

export function getState(): StateEvent {
  return {
    ...progress(),
    isPlaying: isPlayingNow(),
    playWhenReady,
    playbackState: playbackState(),
    index,
    trackId: queue[index]?.id ?? null,
    queueLength: queue.length,
    repeatMode,
    shuffle,
  };
}

let lastStateJson = '';
function emitState() {
  const state = getState();
  // Los eventos del <audio> llegan en ráfagas: solo se avisa si cambió algo además de la posición.
  const json = JSON.stringify({ ...state, positionMs: 0, bufferedMs: 0 });
  if (json !== lastStateJson) {
    lastStateJson = json;
    emit('onStateChange', state);
  }
  updateTicker();
  if (queue.length > 0) {
    navigator.mediaSession && (navigator.mediaSession.playbackState = playWhenReady && !ended ? 'playing' : 'paused');
  }
}

let progressTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function updateTicker() {
  const playing = isPlayingNow();
  if (playing && !progressTimer) {
    progressTimer = setInterval(() => {
      const p = progress();
      emit('onProgress', p);
      updateMediaSession(null, p);
    }, PROGRESS_MS);
  } else if (!playing && progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  const needTick = playing || fade != null;
  if (needTick && !tickTimer) {
    tickTimer = setInterval(() => {
      if (fade) {
        if (performance.now() - fade.startedAt >= fade.ms) finishFade();
      } else {
        maybeStartFade();
      }
      gymTick();
    }, TICK_MS);
  } else if (!needTick && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function describeMediaError(audio: HTMLAudioElement) {
  const code = audio.error?.code;
  if (code === MediaError.MEDIA_ERR_NETWORK) return { code: 'ERROR_CODE_IO_NETWORK_CONNECTION_FAILED', message: 'Sin conexión con el servidor' };
  if (code === MediaError.MEDIA_ERR_DECODE) return { code: 'ERROR_CODE_DECODING_FAILED', message: 'No se pudo decodificar el audio' };
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return { code: 'ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED', message: 'Formato no compatible' };
  return { code: 'ERROR_CODE_UNSPECIFIED', message: audio.error?.message || 'Error de reproducción' };
}

for (const deck of decks) {
  const a = deck.audio;
  const onChange = () => deck === current() && emitState();
  a.addEventListener('waiting', () => {
    deck.waiting = true;
    onChange();
  });
  for (const name of ['playing', 'canplay', 'canplaythrough', 'loadeddata', 'seeked'] as const) {
    a.addEventListener(name, () => {
      deck.waiting = false;
      onChange();
    });
  }
  for (const name of ['pause', 'play', 'durationchange', 'ratechange', 'loadedmetadata'] as const) a.addEventListener(name, onChange);
  a.addEventListener('ended', () => onEnded(deck));
  a.addEventListener('error', () => {
    if (!a.getAttribute('src')) return;
    if (deck !== current()) {
      deck.key = ''; // la precarga falló: se volverá a intentar al llegar a ella
      return;
    }
    cancelFade();
    errored = true;
    emit('onError', describeMediaError(a));
    emitState();
  });
}

setMediaSessionHandlers({
  play: () => void play(),
  pause: () => void pause(),
  next: () => void next(),
  previous: () => void previous(),
  seekTo: (ms) => void seekTo(ms),
});

// --- Comandos (la misma API que ImpalaPlayerModule.kt) -----------------------------------------

export async function setQueue(tracks: NativeTrack[], startIndex: number, startPositionMs: number) {
  cancelFade();
  queue = [...tracks];
  playWhenReady = true;
  if (queue.length === 0) return stop();
  other().key = '';
  go(Math.min(Math.max(0, startIndex), queue.length - 1), 'playlistChanged', startPositionMs);
}

export async function play() {
  if (queue.length === 0) return;
  playWhenReady = true;
  if (ended) {
    go(0, 'seek');
    return;
  }
  if (errored) {
    // Tras un error se vuelve a abrir la canción en el mismo punto (como prepare() en ExoPlayer).
    errored = false;
    load(current(), queue[index], current().audio.currentTime * 1000, true);
  }
  emitState();
  await playDeck(current());
}

export async function pause() {
  playWhenReady = false;
  cancelFade();
  current().audio.pause();
  emitState();
}

export async function next() {
  const n = nextIndex();
  if (n != null) go(n, 'seek');
}

export async function previous() {
  const p = previousIndex();
  if (current().audio.currentTime * 1000 > PREVIOUS_RESTART_MS || p == null) return seekTo(0);
  go(p, 'seek');
}

export async function seekTo(positionMs: number) {
  if (queue.length === 0) return;
  cancelFade();
  current().audio.currentTime = Math.max(0, positionMs) / 1000;
  if (ended) {
    ended = false;
    if (playWhenReady) void playDeck(current());
  }
  emitState();
}

export async function skipTo(i: number) {
  if (i < 0 || i >= queue.length) return;
  playWhenReady = true;
  go(i, 'seek');
}

export async function setRepeatMode(mode: RepeatMode) {
  repeatMode = mode;
  if (fade && (mode === 'one' || nextIndex() !== fade.nextIndex)) cancelFade();
  prepareNext();
  emitState();
}

export async function setShuffleMode(enabled: boolean) {
  shuffle = enabled;
  emitState();
}

/** Tras editar la cola: si la siguiente cambió, se cancela el fundido y se precarga la nueva. */
function afterQueueEdit() {
  if (fade && queue[fade.nextIndex] && keyOf(queue[fade.nextIndex]) !== other().key) cancelFade();
  if (fade) fade.nextIndex = nextIndex() ?? fade.nextIndex;
  prepareNext();
  emitState();
}

export async function insertTracks(tracks: NativeTrack[], at: number) {
  if (tracks.length === 0) return;
  if (queue.length === 0) {
    // Como ExoPlayer: la cola se crea pero no empieza a sonar.
    queue = [...tracks];
    index = 0;
    load(current(), queue[0]);
    emit('onTrackChange', { index, trackId: queue[0].id, reason: 'playlistChanged' });
    updateMediaSession(queue[0]);
    afterQueueEdit();
    return;
  }
  const position = at < 0 || at > queue.length ? queue.length : at;
  queue.splice(position, 0, ...tracks);
  if (position <= index) index += tracks.length;
  afterQueueEdit();
}

export async function moveTrack(from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
  const [track] = queue.splice(from, 1);
  queue.splice(to, 0, track);
  if (from === index) index = to;
  else if (from < index && to >= index) index--;
  else if (from > index && to <= index) index++;
  afterQueueEdit();
}

export async function removeTrack(i: number) {
  if (i < 0 || i >= queue.length) return;
  queue.splice(i, 1);
  if (queue.length === 0) return stop();
  if (i < index) {
    index--;
  } else if (i === index) {
    // Se quitó la que suena: pasa a la que ocupa su lugar.
    go(Math.min(index, queue.length - 1), 'playlistChanged');
    return;
  }
  afterQueueEdit();
}

export async function setUpcomingOrder(order: number[]) {
  const start = index + 1;
  const upcoming = queue.slice(start);
  const expected = upcoming.map((_, i) => start + i);
  if ([...order].sort((a, b) => a - b).join() !== expected.join()) throw new Error('El nuevo orden no coincide con las pistas siguientes');
  queue = [...queue.slice(0, start), ...order.map((original) => queue[original])];
  afterQueueEdit();
}

export async function reloadTrack(track: NativeTrack) {
  let reloadedCurrent = false;
  queue = queue.map((t, i) => {
    if (t.id !== track.id) return t;
    if (i === index) reloadedCurrent = true;
    return track;
  });
  if (other().track?.id === track.id) other().key = '';
  if (reloadedCurrent) {
    cancelFade();
    const deck = current();
    const position = deck.audio.currentTime * 1000;
    load(deck, track, position, true);
    if (playWhenReady) void playDeck(deck);
  }
  prepareNext();
  emitState();
}

export async function stop() {
  cancelFade();
  playWhenReady = false;
  ended = false;
  errored = false;
  decks.forEach(unload);
  queue = [];
  index = -1;
  stopGym('stopped');
  clearSleep();
  clearMediaSession();
  emitState();
}

export async function getQueue() {
  return queue.map(({ url: _url, ...rest }) => rest);
}

// --- Temporizador de reposo (SleepTimer.kt) ----------------------------------------------------

const sleep: SleepTimerEvent = { endsAt: null, endOfTrack: false };
let sleepTimer: ReturnType<typeof setTimeout> | null = null;

function emitSleep() {
  emit('onSleepTimer', { ...sleep });
}

function pauseForSleep() {
  void pause();
  clearSleep();
}

function clearSleep() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  const changed = sleep.endsAt != null || sleep.endOfTrack;
  sleep.endsAt = null;
  sleep.endOfTrack = false;
  if (changed) emitSleep();
}

export async function setSleepTimer(ms: number) {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  if (ms < 0) {
    sleep.endsAt = null;
    sleep.endOfTrack = true;
    cancelFade(); // con «al terminar la canción» no hay fundido
  } else if (ms === 0) {
    return clearSleep();
  } else {
    sleep.endOfTrack = false;
    sleep.endsAt = Date.now() + ms;
    sleepTimer = setTimeout(pauseForSleep, ms);
  }
  emitSleep();
}

export const getSleepTimer = (): SleepTimerEvent => ({ ...sleep });

// --- Volumen gradual (GymRamp.kt), con el volumen de la app --------------------------------------

const gym = {
  active: false,
  lastEnd: null as GymRampEvent['lastEnd'],
  start: 0,
  target: 0,
  durationMs: 0,
  playedMs: 0,
  lastTick: 0,
};

export function getGymRamp(): GymRampEvent {
  const progress = gym.durationMs <= 0 ? 1 : Math.min(1, gym.playedMs / gym.durationMs);
  return {
    active: gym.active,
    lastEnd: gym.lastEnd,
    progress,
    startPercent: Math.round(gym.start * 100),
    targetPercent: prefs().gym.maxPercent,
    currentPercent: Math.round(prefs().volume * 100),
    remainingMs: Math.max(0, gym.durationMs - gym.playedMs),
  };
}

const emitGym = () => emit('onGymRamp', getGymRamp());

export async function startGymRamp() {
  const settings = prefs().gym;
  gym.start = prefs().volume;
  gym.target = settings.maxPercent / 100;
  gym.durationMs = settings.minutes * 60_000;
  gym.playedMs = 0;
  gym.lastEnd = null;
  gym.lastTick = performance.now();
  gym.active = true;
  emitGym();
  // Nunca se baja el volumen: si ya está en el máximo, no hay nada que subir.
  if (gym.start >= gym.target) stopGym('done');
}

export async function stopGymRamp() {
  stopGym('stopped');
}

function stopGym(reason: NonNullable<GymRampEvent['lastEnd']>) {
  if (!gym.active) return;
  gym.active = false;
  gym.lastEnd = reason;
  emitGym();
}

/** Solo avanza mientras suena música. */
function gymTick() {
  if (!gym.active) return;
  const now = performance.now();
  // El temporizador se detiene en pausa: al reanudar, el hueco no cuenta como tiempo sonando.
  const elapsed = Math.min(now - gym.lastTick, TICK_MS * 4);
  gym.lastTick = now;
  if (!isPlayingNow()) return;
  gym.playedMs += elapsed;
  const p = Math.min(1, gym.playedMs / gym.durationMs);
  const desired = gym.start + (gym.target - gym.start) * p;
  if (Math.round(desired * 100) !== Math.round(prefs().volume * 100)) {
    setVolume(desired, true);
    emitGym();
  }
  if (p >= 1) stopGym('done');
}
