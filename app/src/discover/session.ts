import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { ensureInLibrary, youtubePreviewSource } from '@/api/youtube';
import type { YoutubeResult } from '@/api/ytmusic';
import { showToast } from '@/components/Toast';
import { showSheet } from '@/components/sheets/store';
import { DEVICE } from '@/components/device';
import { setFavorite } from '@/library/favorites';
import { getPreview, startPreview, stopPreview, subscribePreview, togglePreviewPause } from '@/player/preview';
import { playerState } from '@/player/store';
import { maybeServerSession, type MusicSource, type Song } from '@/sources';
import { CLIP_MS, findBestPart, syncedLyrics } from './bestPart';
import { DiscoverEngine, type DiscoverTrack } from './engine';
import { allowedByFilters, type Filters, lyricsLanguage, needsLyricsCheck, NOT_FOR_EXPLORING, SPANISH_GENRES } from './filters';
import { loadFilters, loadLearned, librarySeedIds, ownedIndex, resetLearned, saveFilters, saveLearned } from './store';
import { moods, moodTracks, radio, type Mood } from './youtube';

/**
 * Lo que pasa en la pantalla Descubrir, fuera de React (así sigue igual al cambiar de pestaña): el motor, las
 * canciones ya mostradas (para volver atrás), cuál suena y desde dónde. El audio va por el reproductor de vista
 * previa: la cola no cambia y, al salir de Descubrir, vuelve lo que sonaba.
 *
 * Para que no haya silencios al deslizar, de la siguiente canción ya están resueltos el coro (LRCLIB) y la URL
 * del audio (YouTube, desde el teléfono) mientras suena la actual.
 */
export type DiscoverStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export type DiscoverState = {
  status: DiscoverStatus;
  /** Lo mostrado en esta sesión (para volver atrás) y cuál está en pantalla. */
  items: DiscoverTrack[];
  index: number;
  /** «Escuchar entera»: no pasa sola a los CLIP_MS. */
  full: boolean;
  /** Desde dónde empezó la actual (el coro), para la barra de los 30 s. */
  startMs: number;
  /** videoIds con «me gusta». */
  liked: Record<string, true>;
  filters: Filters;
};

let state: DiscoverState = { status: 'idle', items: [], index: 0, full: false, startMs: 0, liked: {}, filters: loadFilters() };
const listeners = new Set<() => void>();

function set(patch: Partial<DiscoverState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useDiscover<T>(selector: (s: DiscoverState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => selector(state),
  );
}

export const currentTrack = () => state.items[state.index] ?? null;

// --- El motor, uno por fuente (la biblioteca decide semillas y qué ya tienes) ---

let engine: { key: string; engine: DiscoverEngine; source: MusicSource } | null = null;
let moodList: Promise<Mood[]> | null = null;

/** Canciones de la biblioteca (para no ofrecer lo que ya tienes): como mucho 10 páginas de 500. */
async function librarySongs(source: MusicSource): Promise<Song[]> {
  const out: Song[] = [];
  for (let page = 0; page < 10; page++) {
    const { songs } = await source.search('', { songCount: 500, songOffset: page * 500, albumCount: 0, artistCount: 0 });
    out.push(...songs);
    if (songs.length < 500) break;
  }
  return out;
}

function engineFor(source: MusicSource): DiscoverEngine {
  const key = source.key.join('/');
  if (engine?.key === key) return engine.engine;
  let owned: (t: DiscoverTrack) => boolean = () => false;
  // Las radios esperan a saber qué ya tienes (si falla, se ofrece todo).
  const ownedReady = librarySongs(source)
    .then((songs) => void (owned = ownedIndex(songs)))
    .catch(() => {});
  const e = new DiscoverEngine(
    {
      radio: async (id) => (await ownedReady, radio(id)),
      explore: async () => {
        await ownedReady;
        // Con un género elegido, se explora dentro de él.
        if (state.filters.genre) return moodTracks(state.filters.genre);
        const all = (await genres()).filter((m) => !NOT_FOR_EXPLORING.test(m.name));
        const spanish = all.filter((m) => SPANISH_GENRES.test(m.name));
        const list = state.filters.spanishOnly && spanish.length ? spanish : all;
        if (!list.length) return [];
        return moodTracks(list[Math.floor(Math.random() * list.length)]);
      },
      librarySeeds: () => (state.filters.genre ? genreSeedIds(state.filters.genre) : librarySeedIds(source)),
      owned: (t) => owned(t),
      allow: (t) => allowedByFilters(t, state.filters),
      personal: () => !state.filters.genre,
    },
    loadLearned(),
  );
  engine = { key, engine: e, source };
  // Otra fuente (cambio de cuenta o de modo): se empieza de nuevo.
  state = { status: 'idle', items: [], index: 0, full: false, startMs: 0, liked: likedOf(e), filters: state.filters };
  listeners.forEach((l) => l());
  return e;
}

/** Estados de ánimo y géneros de YouTube Music (para explorar y para elegir uno). */
export function genres(): Promise<Mood[]> {
  moodList ??= moods().catch((err) => ((moodList = null), Promise.reject(err)));
  return moodList;
}

/** Semillas de un género: canciones al azar de dos de sus listas. */
async function genreSeedIds(genre: Filters['genre'] & {}): Promise<string[]> {
  const tracks = (await Promise.all([moodTracks(genre), moodTracks(genre)])).flat();
  const ids = [...new Set(tracks.map((t) => t.videoId))];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, 8);
}

const likedOf = (e: DiscoverEngine) => Object.fromEntries(e.state().likes.map((l) => [l.videoId, true as const])) as Record<string, true>;
const save = () => engine && saveLearned(engine.engine.state());

// --- Lo de la siguiente canción, resuelto por adelantado ---

const bestPart = new Map<string, Promise<number>>();
const partOf = (t: DiscoverTrack) => {
  let p = bestPart.get(t.videoId);
  if (!p) bestPart.set(t.videoId, (p = findBestPart(t)));
  return p;
};
const audioOf = (source: MusicSource, t: DiscoverTrack) => youtubePreviewSource(maybeServerSession(source), t.videoId);

function prefetch(source: MusicSource, t: DiscoverTrack | undefined) {
  if (!t) return;
  void partOf(t);
  // La URL queda en la caché de youtube.ts (10 min): al llegar a esta canción suena al instante.
  audioOf(source, t)
    .direct(false)
    .catch(() => {});
}

/** Prepara Descubrir sin que suene nada (al abrir la app): la primera canción, su coro y su audio. */
export async function warmUpDiscover(source: MusicSource) {
  const e = engineFor(source);
  if (state.items.length) return;
  await e.fill(10).catch(() => {});
  prefetch(source, e.upcoming()[0]);
}

// --- Reproducción ---

/** Escucha de la actual (ms desde el coro), para decidir si «pasar» fue rápido. */
function listenedMs() {
  const p = getPreview();
  return p.id === currentTrack()?.videoId ? Math.max(0, p.positionMs - state.startMs) : 0;
}

let unsubscribe: (() => void) | null = null;
let advancing = false;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
/** Canciones seguidas que no sonaron: a la tercera se para (sin conexión no tiene sentido seguir pasando). */
let failures = 0;
const MAX_FAILURES = 3;
/** La pantalla Descubrir está a la vista: si no, lo que termine de cargar no debe sonar. */
let focused = false;

/** Vigila la vista previa: a los CLIP_MS pasa a la siguiente (salvo «escuchar entera»); si no suena, también. */
function watch() {
  unsubscribe ??= subscribePreview(() => {
    const t = currentTrack();
    const p = getPreview();
    if (!t || p.id !== t.videoId || !engine) return;
    if (p.status === 'playing') failures = 0;
    if (p.status === 'error' && !errorTimer) {
      errorTimer = setTimeout(() => {
        errorTimer = null;
        if (getPreview().status !== 'error' || currentTrack()?.videoId !== t.videoId || !focused) return;
        if (++failures >= MAX_FAILURES) return showToast('No se pudo reproducir. Revisa tu conexión y toca para reintentar.', 'cloud-offline-outline');
        void next({ silent: true });
      }, 1200);
    }
    if (p.status === 'playing' && !state.full && p.positionMs - state.startMs >= CLIP_MS && !advancing) {
      engine.engine.feedback(t, 'complete');
      void next({ silent: true });
    }
  });
}

async function playCurrent(resumeAtMs?: number) {
  const t = currentTrack();
  if (!t || !engine) return;
  const source = engine.source;
  watch();
  const start = resumeAtMs ?? (await partOf(t));
  if (currentTrack() !== t || !focused) return;
  // «Solo en español» y el título no lo decía: la letra (ya pedida para el coro) tiene que estar en español.
  if (resumeAtMs == null && needsLyricsCheck(t, state.filters)) {
    const lines = await syncedLyrics(t.artist, t.title, t.durationSec).catch(() => null);
    if (!lines || lyricsLanguage(lines) !== 'es') return dropCurrent();
    if (currentTrack() !== t || !focused) return;
  }
  set({ startMs: resumeAtMs != null ? state.startMs : start, full: resumeAtMs != null ? state.full : false });
  await startPreview(t.videoId, audioOf(source, t), playerState().playWhenReady, {
    startMs: start,
    // La canción entera terminó (con «escuchar entera»): la siguiente.
    onEnded: () => {
      engine?.engine.feedback(t, 'complete');
      void next({ silent: true });
    },
  });
  prefetch(source, state.items[state.index + 1] ?? engine.engine.upcoming()[0]);
}

/** Quita la actual (no pasa los filtros) y suena la siguiente, sin contarlo como «pasar». */
async function dropCurrent() {
  if (!engine) return;
  const items = state.items.filter((_, i) => i !== state.index);
  if (state.index >= items.length) {
    const n = await engine.engine.next().catch(() => null);
    save();
    if (n) items.push(n);
  }
  if (!items.length) return set({ items, index: 0, status: 'empty' });
  set({ items, index: Math.min(state.index, items.length - 1) });
  await playCurrent();
}

export const discoverFilters = () => state.filters;

/** Cambia los filtros: lo que ya estaba preparado se descarta (la canción que suena sigue). */
export function setFilters(patch: Partial<Filters>) {
  const filters = { ...state.filters, ...patch };
  saveFilters(filters);
  engine?.engine.restart();
  set({ filters, items: state.items.slice(0, state.index + 1) });
}

/** Entrar en Descubrir: sigue donde se quedó (o empieza con la primera canción). */
export async function openDiscover(source: MusicSource) {
  focused = true;
  failures = 0;
  const e = engineFor(source);
  if (state.items.length) return playCurrent(lastPositionMs ?? undefined);
  if (state.status === 'loading') return;
  set({ status: 'loading' });
  const t = await e.next().catch(() => null);
  save();
  if (!t) return set({ status: 'empty' });
  set({ status: 'ready', items: [t], index: 0 });
  await playCurrent();
}

let lastPositionMs: number | null = null;

/** Salir de Descubrir (otra pestaña o pantalla): se calla y vuelve la música que sonaba. */
export function leaveDiscover() {
  focused = false;
  const p = getPreview();
  lastPositionMs = currentTrack() && p.id === currentTrack()!.videoId ? p.positionMs : null;
  if (p.id && p.id === currentTrack()?.videoId) stopPreview();
}

/** La siguiente canción. `silent`: no cuenta como «pasar» (terminó sola o no sonaba). */
export async function next({ silent = false } = {}) {
  if (!engine || advancing) return;
  const e = engine.engine;
  const t = currentTrack();
  if (t && !silent) e.feedback(t, 'skip', listenedMs());
  advancing = true;
  try {
    if (state.index + 1 < state.items.length) {
      set({ index: state.index + 1 });
    } else {
      const n = await e.next().catch(() => null);
      save();
      if (!n) {
        set({ status: state.items.length ? 'ready' : 'empty' });
        showToast('No hay más canciones por ahora. Revisa tu conexión.', 'cloud-offline-outline');
        return;
      }
      set({ items: [...state.items, n].slice(-100), index: Math.min(state.index + 1, 99) });
    }
    lastPositionMs = null;
    await playCurrent();
  } finally {
    advancing = false;
  }
}

export async function previous() {
  if (state.index === 0) return;
  set({ index: state.index - 1 });
  lastPositionMs = null;
  await playCurrent();
}

/** Tocar: pausa o sigue. Devuelve el icono que se muestra un momento. */
export function togglePause(): 'pause' | 'play' {
  const p = getPreview();
  if (p.id !== currentTrack()?.videoId || p.status === 'error' || p.status === null) {
    failures = 0;
    void playCurrent(lastPositionMs ?? undefined);
    return 'play';
  }
  const playing = p.status === 'paused';
  togglePreviewPause();
  return playing ? 'play' : 'pause';
}

/** «Escuchar entera»: deja de pasar sola; si ya iba por el coro, sigue desde ahí. */
export function listenWhole() {
  set({ full: !state.full });
}

const toResult = (t: DiscoverTrack): YoutubeResult => ({
  kind: 'song',
  id: t.videoId,
  title: t.title,
  artist: t.artist,
  album: t.album,
  explicit: t.explicit,
  channel: null,
  durationSec: t.durationSec,
  views: null,
  thumbnail: t.thumbnail ?? `https://i.ytimg.com/vi/${t.videoId}/hqdefault.jpg`,
});

/** «Me gusta»: aprende (pasa a ser semilla), la descarga (al teléfono o al servidor) y la marca como favorita. */
export function like() {
  const t = currentTrack();
  if (!t || !engine) return;
  if (state.liked[t.videoId]) return;
  const { source } = engine;
  engine.engine.feedback(t, 'like');
  save();
  set({ liked: { ...state.liked, [t.videoId]: true } });
  const where = source.kind === 'local' ? `el ${DEVICE}` : 'el servidor';
  showToast(`«${t.title}» se guardará en tus favoritas (descargando en ${where})`, 'star');
  ensureInLibrary(source, toResult(t))
    .then((song) => setFavorite(source, song, true))
    .then(() => showToast(`«${t.title}» está en tus favoritas`, 'star'))
    .catch((err) => showToast(err instanceof Error ? err.message : 'No se pudo guardar', 'alert-circle-outline'));
}

/** «+»: a una playlist (primero se descarga). */
export function addToPlaylist() {
  const t = currentTrack();
  if (!t || !engine) return;
  const { source } = engine;
  showSheet({ kind: 'playlistPicker', songs: [], pending: { title: t.title, resolve: async () => [await ensureInLibrary(source, toResult(t))] } });
}

/** Olvidar lo aprendido (y lo mostrado en esta sesión). */
export function resetDiscover() {
  engine?.engine.reset();
  if (engine) save();
  else resetLearned();
  if (getPreview().id && getPreview().id === currentTrack()?.videoId) stopPreview();
  set({ status: 'idle', items: [], index: 0, full: false, startMs: 0, liked: {} });
}

// En segundo plano Descubrir se pausa (como TikTok): sin pantalla no tiene sentido ir pasando canciones.
AppState.addEventListener('change', (s) => {
  if (s === 'active') return;
  const p = getPreview();
  if (p.id && p.id === currentTrack()?.videoId && p.status === 'playing') togglePreviewPause();
});
