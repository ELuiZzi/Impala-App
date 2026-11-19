import { useSyncExternalStore } from 'react';
import { localData } from '@/sources/localData';
import { localSource, refreshLocalLibrary } from '@/sources/local';
import type { Song } from '@/sources';
import ImpalaLibrary from '../../modules/impala-library';
import { audioStream, resetVisitor } from './innertube';
import { findInLibrary } from './youtubeMatch';
import type { YoutubeJob } from './youtube';

/**
 * Descargas de YouTube al propio teléfono (modo local, sin servidor): la cola vive aquí, en memoria, y cada
 * canción la descarga el módulo nativo (audio m4a de YouTube → MP4 con etiquetas y carátula → Music/Impala).
 * Sigue al salir de la pantalla, pero no sobrevive a que se cierre la app (no hay servicio en primer plano).
 */

/** Lo que se sabe de la canción antes de descargarla; con `album` (descarga de un álbum) va tal cual a los tags. */
export type LocalDownloadItem = {
  videoId: string;
  title: string;
  artist: string | null;
  album?: string | null;
  albumArtist?: string | null;
  trackNumber?: number | null;
  year?: number | null;
  durationSec?: number | null;
  /** Carátula preferida (la del álbum o la miniatura de YouTube Music). */
  cover?: string | null;
};

/** Una pausa corta entre canciones de una tanda: YouTube bloquea antes a quien descarga muy seguido. */
const PACE_MS: [number, number] = [1500, 3500];
const MAX_FINISHED = 60;

let jobs: YoutubeJob[] = [];
const items = new Map<string, LocalDownloadItem>();
const queue: string[] = [];
const cancelled = new Set<string>();
const songIds = new Map<string, string>();
const waiters = new Map<string, { resolve: (songId: string) => void; reject: (e: Error) => void }[]>();
const listeners = new Set<() => void>();
let working = false;
let progressSub: { remove(): void } | null = null;

const isActive = (j: YoutubeJob) => j.status === 'queued' || j.status === 'downloading' || j.status === 'processing';

function update(id: string, patch: Partial<YoutubeJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  listeners.forEach((l) => l());
  if (patch.status && !isActive({ ...jobs.find((j) => j.id === id)!, ...patch })) settle(id, patch);
}

function settle(id: string, patch: Partial<YoutubeJob>) {
  const list = waiters.get(id) ?? [];
  waiters.delete(id);
  const songId = songIds.get(id);
  for (const w of list) {
    if (patch.status === 'done' && songId) w.resolve(songId);
    else w.reject(new Error(patch.status === 'cancelled' ? 'Descarga cancelada' : (patch.error ?? 'No se pudo descargar')));
  }
}

function listen() {
  progressSub ??= ImpalaLibrary.addListener('onDownload', (e) => {
    const job = jobs.find((j) => j.id === e.jobId);
    if (!job || !isActive(job) || cancelled.has(job.id)) return;
    if (e.stage === 'processing') update(job.id, { status: 'processing', progress: 0.99 });
    else update(job.id, { status: 'downloading', progress: Math.min(0.98, e.progress) });
  });
}

const newId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Encola canciones; las que ya se están descargando no se repiten. Devuelve los trabajos (nuevos o existentes). */
export function enqueueLocal(list: LocalDownloadItem[]): YoutubeJob[] {
  listen();
  const result: YoutubeJob[] = [];
  const added: YoutubeJob[] = [];
  for (const item of list) {
    const existing = jobs.find((j) => j.videoId === item.videoId && isActive(j));
    if (existing) {
      result.push(existing);
      continue;
    }
    const job: YoutubeJob = { id: newId(), videoId: item.videoId, title: item.title, artist: item.artist, status: 'queued', progress: 0 };
    items.set(job.id, item);
    queue.push(job.id);
    added.push(job);
    result.push(job);
  }
  // Las más recientes primero (como la lista del servidor); se olvidan las terminadas más antiguas.
  const finished = jobs.filter((j) => !isActive(j));
  for (const old of finished.slice(MAX_FINISHED)) {
    items.delete(old.id);
    songIds.delete(old.id);
  }
  jobs = [...added.reverse(), ...jobs.filter((j) => isActive(j) || finished.indexOf(j) < MAX_FINISHED)];
  listeners.forEach((l) => l());
  void drain();
  return result;
}

export function cancelLocal(ids: string[]) {
  for (const id of ids) {
    const job = jobs.find((j) => j.id === id);
    if (!job || !isActive(job)) continue;
    cancelled.add(id);
    const at = queue.indexOf(id);
    if (at >= 0) {
      queue.splice(at, 1);
      update(id, { status: 'cancelled' });
    } else {
      ImpalaLibrary.cancelDownload(id);
    }
  }
}

/** Espera a que termine la descarga y devuelve el id de la canción ya en la biblioteca local. */
export function waitForLocalJob(id: string): Promise<string> {
  const job = jobs.find((j) => j.id === id);
  if (job?.status === 'done' && songIds.has(id)) return Promise.resolve(songIds.get(id)!);
  if (job && !isActive(job)) return Promise.reject(new Error(job.error ?? 'No se pudo descargar'));
  return new Promise((resolve, reject) => waiters.set(id, [...(waiters.get(id) ?? []), { resolve, reject }]));
}

/** Avisa de cada cambio en la cola (progreso incluido); devuelve la función para dejar de escuchar. */
export function subscribeLocalJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const localJobs = (): YoutubeJob[] => jobs;

export function useLocalYoutubeJobs(): YoutubeJob[] {
  return useSyncExternalStore(subscribeLocalJobs, localJobs);
}

/** "AC/DC - Back In Black?" → "AC_DC - Back In Black" (válido en FAT/exFAT de las tarjetas SD). */
const fileName = (artist: string, title: string) =>
  `${artist} - ${title}`
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.\-–—•]+|[\s.\-–—•]+$/g, '')
    .slice(0, 150) || 'YouTube';

/** Carátula grande: las de YouTube Music llevan "=w120-h120"; para los videos, la miniatura de mayor tamaño. */
function coverUrls(item: LocalDownloadItem): string[] {
  const urls: string[] = [];
  const music = item.cover && !item.cover.includes('i.ytimg.com');
  if (music) urls.push(/=w\d+-h\d+/.test(item.cover!) ? item.cover!.replace(/=w\d+-h\d+/, '=w1200-h1200') : item.cover!);
  urls.push(`https://i.ytimg.com/vi/${item.videoId}/maxresdefault.jpg`);
  if (item.cover && !music) urls.push(item.cover);
  urls.push(`https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`);
  return [...new Set(urls)];
}

async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const item = items.get(id);
      if (!item || cancelled.has(id)) continue;
      try {
        await download(id, item);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (cancelled.has(id) || code === 'ERR_CANCELLED') update(id, { status: 'cancelled' });
        else update(id, { status: 'error', error: err instanceof Error ? err.message : 'No se pudo descargar' });
      } finally {
        cancelled.delete(id);
      }
      if (queue.length > 0) await new Promise((r) => setTimeout(r, PACE_MS[0] + Math.random() * (PACE_MS[1] - PACE_MS[0])));
    }
  } finally {
    working = false;
  }
}

async function download(id: string, item: LocalDownloadItem) {
  const title = item.title.trim() || 'Sin título';
  const artist = item.artist?.trim() || 'Artista desconocido';
  update(id, { status: 'downloading', progress: 0, title, artist });

  // Ya está en el teléfono (otra descarga, o copiada a mano): no se duplica.
  const existing: Song | null = await findInLibrary(localSource, { title, artist, durationSec: item.durationSec ?? null }).catch(() => null);
  if (existing) {
    songIds.set(id, existing.id);
    return update(id, { status: 'done', progress: 1, duplicate: true });
  }

  for (let attempt = 0; ; attempt++) {
    if (cancelled.has(id)) throw Object.assign(new Error('Descarga cancelada'), { code: 'ERR_CANCELLED' });
    const stream = await audioStream(item.videoId);
    if (!stream.mimeType.startsWith('audio/mp4')) throw new Error('YouTube no ofreció audio m4a para este video');
    if (cancelled.has(id)) throw Object.assign(new Error('Descarga cancelada'), { code: 'ERR_CANCELLED' });
    try {
      const saved = await ImpalaLibrary.downloadYoutube({
        jobId: id,
        url: stream.url,
        userAgent: stream.userAgent,
        contentLength: stream.contentLength,
        baseName: fileName(artist, title),
        folder: localData().downloadFolder,
        volume: localData().downloadVolume,
        title,
        artist,
        album: item.album ?? null,
        albumArtist: item.album ? (item.albumArtist ?? artist) : null,
        track: item.trackNumber ?? null,
        year: item.year ?? null,
        coverUrls: coverUrls(item),
      });
      songIds.set(id, saved.id);
      // La biblioteca se relee ya (el aviso del índice de Android también llega, agrupado).
      await refreshLocalLibrary();
      // La letra se busca ya, con conexión (queda guardada en el teléfono para cuando se escuche).
      void localSource.lyrics(saved.id).catch(() => {});
      return update(id, { status: 'done', progress: 1, file: saved.fileName });
    } catch (err) {
      // La URL no valió (403: PO token o identidad): una vez más con otra identidad.
      if (attempt === 0 && !cancelled.has(id) && /HTTP 403/.test(err instanceof Error ? err.message : '')) {
        resetVisitor();
        continue;
      }
      throw err;
    }
  }
}
