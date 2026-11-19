import { useSyncExternalStore } from 'react';
import ImpalaPlayer from '../../modules/impala-player';

/**
 * Vista previa de un resultado de YouTube: suena en un reproductor nativo aparte, así que la cola no
 * cambia. Mientras suena, la música principal se pausa y se reanuda al terminar la vista previa.
 */
export type PreviewState = {
  id: string | null;
  status: 'loading' | 'playing' | 'paused' | 'error' | null;
  progress: number;
  positionMs: number;
  durationMs: number | null;
  /** Lo que muestra la barra de vista previa. */
  meta: PreviewMeta | null;
};

/** Datos para la barra de vista previa; `onDownload` añade el botón de descargar. */
export type PreviewMeta = { title: string; subtitle?: string; thumbnail?: string; onDownload?: () => void };

/**
 * De dónde sale el audio: `direct` lo pide a YouTube desde el teléfono (lo más rápido; con `retry`, con
 * otra identidad). Si no suena ni así, `server`: el audio que reenvía el servidor.
 */
/** server: null si no hay servidor (modo local): si el audio directo falla, la vista previa falla. */
export type PreviewSource = { direct: (retry: boolean) => Promise<string>; server: string | null; onDirectFailed?: (err: unknown) => void };

/** directo → directo con otra identidad → servidor. */
type Step = 'direct' | 'retry' | 'server';

const idle = { progress: 0, positionMs: 0, durationMs: null };
let state: PreviewState = { id: null, status: null, ...idle, meta: null };
const listeners = new Set<() => void>();
let resumeMain = false;
let subscription: { remove(): void } | null = null;
/** Cada vista previa invalida lo que la anterior aún estaba resolviendo. */
let generation = 0;
/** Mientras se resuelve el audio, los eventos que lleguen son de la fuente anterior. */
let starting = false;
/** Lo que suena ahora: si falla, se pasa al siguiente paso. */
let current: { source: PreviewSource; step: Step; token: number; startMs: number } | null = null;
/** Descubrir: al terminar, en vez de cerrar la vista previa (y reanudar la música), pasa a la siguiente. */
let onEnded: (() => void) | null = null;

function set(patch: Partial<PreviewState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Lo que suena en la vista previa (fuera de React). */
export const getPreview = () => state;

export function subscribePreview(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function usePreview<T>(selector: (s: PreviewState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => selector(state),
  );
}

function finish(status: PreviewState['status'] = null) {
  generation++;
  onEnded = null;
  starting = false;
  current = null;
  set({ id: status === 'error' ? state.id : null, status, ...idle, meta: status === 'error' ? state.meta : null });
  if (resumeMain) {
    resumeMain = false;
    ImpalaPlayer.play().catch(() => {});
  }
}

/** Resuelve el audio del paso `step` (si no se puede, el del servidor) y lo reproduce. */
async function play(source: PreviewSource, step: Step, token: number, startMs = 0) {
  starting = true;
  let url = source.server;
  if (step !== 'server') {
    try {
      url = await source.direct(step === 'retry');
    } catch (err) {
      // Si ni siquiera se obtuvo la URL (sin conexión con YouTube, video no disponible…), otra
      // identidad no lo arregla: directo al servidor.
      source.onDirectFailed?.(err);
      step = 'server';
    }
  }
  // Mientras tanto empezó otra vista previa o se detuvo esta.
  if (token !== generation) return;
  if (!url) return finish('error');
  current = { source, step, token, startMs };
  starting = false;
  await ImpalaPlayer.startPreview(url, startMs).catch(() => finish('error'));
}

function listen() {
  subscription ??= ImpalaPlayer.addListener('onPreview', (e) => {
    // "stopped" solo llega tras stopPreview, que ya actualiza el estado.
    if (!state.id || starting || e.state === 'stopped') return;
    if (e.state === 'ended') {
      if (onEnded) return onEnded();
      return finish();
    }
    if (e.state === 'error') {
      const c = current;
      if (!c || c.step === 'server') return finish('error');
      // El audio directo no sonó (403: otra IP, caducado, PO token…): el siguiente paso.
      c.source.onDirectFailed?.(new Error(e.message ?? 'No se pudo reproducir el audio directo'));
      set({ status: 'loading', ...idle });
      void play(c.source, c.step === 'direct' ? 'retry' : 'server', c.token, c.startMs);
      return;
    }
    const positionMs = e.positionMs ?? 0;
    const durationMs = e.durationMs ?? null;
    set({ status: e.state, progress: durationMs ? positionMs / durationMs : 0, positionMs, durationMs });
  });
}

/** Empieza la vista previa de `id` o, si ya era la que sonaba, la detiene. */
export async function togglePreview(id: string, source: PreviewSource, mainIsPlaying: boolean, meta: PreviewMeta | null = null) {
  // La misma: si estaba en pausa, sigue; si no, se detiene.
  if (state.id === id && state.status === 'paused') return togglePreviewPause();
  if (state.id === id && state.status !== 'error') return stopPreview();
  return startPreview(id, source, mainIsPlaying, { meta });
}

export type StartOptions = {
  /** null: sin barra de vista previa (Descubrir tiene su propia pantalla). */
  meta?: PreviewMeta | null;
  /** Desde dónde empieza (ms). */
  startMs?: number;
  /** Al terminar: en vez de cerrar la vista previa y reanudar la música principal. */
  onEnded?: () => void;
};

/** Empieza la vista previa de `id` (sustituye la que sonara; la música principal sigue en pausa hasta cerrarla). */
export async function startPreview(id: string, source: PreviewSource, mainIsPlaying: boolean, { meta = null, startMs = 0, onEnded: ended }: StartOptions = {}) {
  listen();
  const token = ++generation;
  current = null;
  starting = true;
  // La anterior se calla ya, no cuando la nueva esté lista.
  if (state.id && state.status !== 'error') ImpalaPlayer.stopPreview().catch(() => {});
  onEnded = ended ?? null;
  set({ id, status: 'loading', ...idle, positionMs: startMs, meta });
  if (mainIsPlaying && !resumeMain) {
    resumeMain = true;
    await ImpalaPlayer.pause().catch(() => {});
  }
  await play(source, 'direct', token, startMs);
}

/** Pausa o reanuda la vista previa (la música principal sigue en pausa hasta cerrarla). */
export function togglePreviewPause() {
  if (state.status !== 'playing' && state.status !== 'paused') return;
  const playing = state.status === 'paused';
  set({ status: playing ? 'playing' : 'paused' });
  ImpalaPlayer.setPreviewPlaying(playing).catch(() => {});
}

export function seekPreview(positionMs: number) {
  if (!state.id || state.status === 'error') return;
  set({ positionMs, progress: state.durationMs ? positionMs / state.durationMs : 0 });
  ImpalaPlayer.seekPreview(positionMs).catch(() => {});
}

export function stopPreview() {
  if (!state.id) return;
  ImpalaPlayer.stopPreview().catch(() => {});
  finish();
}

/** Al empezar a reproducir otra cosa: corta la vista previa sin reanudar lo anterior. */
export function cancelPreview() {
  resumeMain = false;
  stopPreview();
}
