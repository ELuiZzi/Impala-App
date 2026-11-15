import { useSyncExternalStore } from 'react';
import ImpalaPlayer from '../../modules/impala-player';

/**
 * Vista previa de un resultado de YouTube: suena en un reproductor nativo aparte, así que la cola no
 * cambia. Mientras suena, la música principal se pausa y se reanuda al terminar la vista previa.
 */
export type PreviewState = {
  id: string | null;
  status: 'loading' | 'playing' | 'error' | null;
  progress: number;
};

/**
 * De dónde sale el audio: `direct` lo pide a YouTube desde el teléfono (lo más rápido; con `retry`, con
 * otra identidad). Si no suena ni así, `server`: el audio que reenvía el servidor.
 */
/** server: null si no hay servidor (modo local): si el audio directo falla, la vista previa falla. */
export type PreviewSource = { direct: (retry: boolean) => Promise<string>; server: string | null; onDirectFailed?: (err: unknown) => void };

/** directo → directo con otra identidad → servidor. */
type Step = 'direct' | 'retry' | 'server';

let state: PreviewState = { id: null, status: null, progress: 0 };
const listeners = new Set<() => void>();
let resumeMain = false;
let subscription: { remove(): void } | null = null;
/** Cada vista previa invalida lo que la anterior aún estaba resolviendo. */
let generation = 0;
/** Mientras se resuelve el audio, los eventos que lleguen son de la fuente anterior. */
let starting = false;
/** Lo que suena ahora: si falla, se pasa al siguiente paso. */
let current: { source: PreviewSource; step: Step; token: number } | null = null;

function set(patch: Partial<PreviewState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
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
  starting = false;
  current = null;
  set({ id: status === 'error' ? state.id : null, status, progress: 0 });
  if (resumeMain) {
    resumeMain = false;
    ImpalaPlayer.play().catch(() => {});
  }
}

/** Resuelve el audio del paso `step` (si no se puede, el del servidor) y lo reproduce. */
async function play(source: PreviewSource, step: Step, token: number) {
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
  current = { source, step, token };
  starting = false;
  await ImpalaPlayer.startPreview(url).catch(() => finish('error'));
}

function listen() {
  subscription ??= ImpalaPlayer.addListener('onPreview', (e) => {
    // "stopped" solo llega tras stopPreview, que ya actualiza el estado.
    if (!state.id || starting || e.state === 'stopped') return;
    if (e.state === 'ended') return finish();
    if (e.state === 'error') {
      const c = current;
      if (!c || c.step === 'server') return finish('error');
      // El audio directo no sonó (403: otra IP, caducado, PO token…): el siguiente paso.
      c.source.onDirectFailed?.(new Error(e.message ?? 'No se pudo reproducir el audio directo'));
      set({ status: 'loading', progress: 0 });
      void play(c.source, c.step === 'direct' ? 'retry' : 'server', c.token);
      return;
    }
    const progress = e.durationMs ? (e.positionMs ?? 0) / e.durationMs : 0;
    set({ status: e.state, progress });
  });
}

/** Empieza la vista previa de `id` o, si ya era la que sonaba, la detiene. */
export async function togglePreview(id: string, source: PreviewSource, mainIsPlaying: boolean) {
  if (state.id === id && state.status !== 'error') return stopPreview();
  listen();
  const token = ++generation;
  current = null;
  starting = true;
  // La anterior se calla ya, no cuando la nueva esté lista.
  if (state.id && state.status !== 'error') ImpalaPlayer.stopPreview().catch(() => {});
  set({ id, status: 'loading', progress: 0 });
  if (mainIsPlaying && !resumeMain) {
    resumeMain = true;
    await ImpalaPlayer.pause().catch(() => {});
  }
  await play(source, 'direct', token);
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
