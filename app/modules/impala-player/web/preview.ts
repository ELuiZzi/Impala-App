import type { PreviewEvent } from '../index';
import { emit } from './events';

/**
 * Vista previa (YouTube o un recorte): un <audio> aparte, fuera de la cola y de la Media Session, como el
 * ExoPlayer de vista previa de Android. No pasa por Web Audio, así que no necesita CORS.
 */
const TICK_MS = 500;
const CLIP_TICK_MS = 30;

let audio: HTMLAudioElement | null = null;
let clips: [number, number][] | null = null;
let clipIndex = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function send(event: PreviewEvent) {
  emit('onPreview', event);
}

function state(a: HTMLAudioElement): PreviewEvent {
  const clip = clips?.[clipIndex];
  const positionMs = a.currentTime * 1000 - (clip ? clip[0] : 0);
  const durationMs = clip ? clip[1] - clip[0] : Number.isFinite(a.duration) ? a.duration * 1000 : null;
  const loading = a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  return { state: loading ? 'loading' : 'playing', positionMs: Math.max(0, positionMs), durationMs, itemIndex: clip ? clipIndex : 0 };
}

function release() {
  if (timer) clearInterval(timer);
  timer = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  audio = null;
  clips = null;
}

function finish(event: PreviewEvent) {
  release();
  send(event);
}

function start(url: string, positionMs: number, list: [number, number][] | null = null, index = 0) {
  release();
  clips = list;
  clipIndex = index;
  const a = new Audio();
  audio = a;
  a.preload = 'auto';
  a.addEventListener('error', () => audio === a && finish({ state: 'error', message: 'No se pudo reproducir la vista previa' }));
  a.addEventListener('ended', () => audio === a && finish({ state: 'ended' }));
  for (const name of ['playing', 'waiting', 'pause'] as const) a.addEventListener(name, () => audio === a && send(state(a)));
  a.src = url;
  if (positionMs > 0) a.currentTime = positionMs / 1000;
  a.play().catch((e) => {
    if (audio === a && (e as DOMException)?.name !== 'AbortError') finish({ state: 'error', message: String((e as Error)?.message ?? e) });
  });
  timer = setInterval(() => {
    if (audio !== a) return;
    if (clips) {
      // Recorte: al llegar al final de un tramo, salta al siguiente; tras el último, termina.
      const clip = clips[clipIndex];
      if (a.currentTime * 1000 >= clip[1]) {
        if (clipIndex + 1 >= clips.length) return finish({ state: 'ended' });
        clipIndex++;
        a.currentTime = clips[clipIndex][0] / 1000;
      }
    }
    send(state(a));
  }, clips ? CLIP_TICK_MS : TICK_MS);
  send({ state: 'loading', positionMs: 0, durationMs: null });
}

export async function startPreview(url: string) {
  start(url, 0);
}

export async function startPreviewClips(url: string, list: [number, number][], index: number, positionMs: number) {
  if (list.length === 0) return;
  const i = Math.min(Math.max(0, index), list.length - 1);
  start(url, list[i][0] + positionMs, list, i);
}

export async function stopPreview() {
  if (!audio) return;
  release();
  send({ state: 'stopped' });
}
