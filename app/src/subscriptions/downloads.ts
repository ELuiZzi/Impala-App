import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { audioStream } from '@/api/innertube';
import ImpalaLibrary from '../../modules/impala-library';
import ImpalaPlayer from '../../modules/impala-player';
import type { Episode } from './feeds';
import { downloadWifiOnly, setDownload, subscription, subscriptions, type Subscription, visibleEpisodes } from './store';

/**
 * Episodios descargados en el teléfono para escucharlos sin internet. Van a una carpeta privada de la app (no a
 * la biblioteca de música ni al índice de Android): se borran solos cuando ya se escucharon, sin pedir permiso.
 * Por ahora solo en Android (en el PC siempre hay conexión).
 */
export const canDownloadEpisodes = Platform.OS === 'android';

/** Descargas automáticas que no se escucharon y ya no están entre las más nuevas: se borran a los N días. */
const STALE_DAYS = 14;

const folder = () => new Directory(Paths.document, 'episodes');

/** Nombre de archivo estable y corto para un episodio (los ids pueden ser enlaces largos). */
function baseName(subId: string, episodeId: string): string {
  let h = 5381;
  for (const c of `${subId}\n${episodeId}`) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return `ep-${h.toString(36)}-${episodeId.length.toString(36)}`;
}

const key = (subId: string, episodeId: string) => `${subId}\n${episodeId}`;

// --- Estado de las descargas en curso (para la pantalla) ---------------------------------------------

const active = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

export function useEpisodeDownloading(subId: string, episodeId: string): boolean {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => version,
  );
  return active.has(key(subId, episodeId));
}

/** El archivo descargado del episodio, si sigue existiendo. */
export function downloadedUri(sub: Subscription, episode: Episode): string | null {
  const d = sub.downloads[episode.id];
  if (!d) return null;
  try {
    return new File(d.uri).exists ? d.uri : null;
  } catch {
    return null;
  }
}

/** ¿Se puede descargar ahora? Sin conexión no; con «solo Wi-Fi», solo en Wi-Fi o redes sin límite de datos. */
export function networkAllowsDownloads(): boolean {
  const n = ImpalaPlayer.getNetworkInfo();
  if (!n.connected) return false;
  return !downloadWifiOnly() || n.wifi || !n.metered;
}

/** Descarga un episodio (si ya lo estaba, no hace nada). Lanza un error con mensaje si no se puede. */
export async function downloadEpisode(sub: Subscription, episode: Episode): Promise<void> {
  if (!canDownloadEpisodes || downloadedUri(sub, episode)) return;
  const k = key(sub.id, episode.id);
  if (active.has(k)) return;
  active.add(k);
  notify();
  try {
    const dir = folder();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const name = baseName(sub.id, episode.id);
    let uri: string;
    if (episode.audioUrl) {
      const ext = /\.(m4a|mp3|aac|ogg|opus)(\?|$)/i.exec(episode.audioUrl)?.[1]?.toLowerCase() ?? 'mp3';
      const file = await File.downloadFileAsync(episode.audioUrl, new File(dir, `${name}.${ext}`), { idempotent: true });
      uri = file.uri;
    } else if (episode.videoId) {
      // Audio de YouTube: lo descarga, etiqueta y guarda el módulo nativo (como las canciones), aquí en privado.
      const stream = await audioStream(episode.videoId);
      if (!stream.mimeType.startsWith('audio/mp4')) throw new Error('YouTube no ofreció audio m4a para este video');
      const saved = await ImpalaLibrary.downloadYoutube({
        jobId: `episode-${name}`,
        url: stream.url,
        userAgent: stream.userAgent,
        contentLength: stream.contentLength,
        baseName: name,
        folder: decodeURIComponent(dir.uri.replace(/^file:\/\//, '')),
        title: episode.title,
        artist: sub.title,
        album: null,
        albumArtist: null,
        track: null,
        year: null,
        coverUrls: episode.image ? [episode.image] : [],
      });
      uri = saved.uri;
    } else {
      throw new Error('Este episodio no tiene audio');
    }
    // Si mientras tanto se quitó la suscripción, el archivo sobra.
    if (subscription(sub.id)) setDownload(sub.id, episode.id, uri);
    else deleteFile(uri);
  } finally {
    active.delete(k);
    notify();
  }
}

function deleteFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Ya no estaba.
  }
}

export function removeDownload(sub: Subscription, episodeId: string) {
  const d = sub.downloads[episodeId];
  if (d) deleteFile(d.uri);
  setDownload(sub.id, episodeId, null);
}

/** Al quitar una suscripción: sus descargas sobran. */
export function removeAllDownloads(sub: Subscription) {
  for (const d of Object.values(sub.downloads)) deleteFile(d.uri);
}

/** Los episodios que la descarga automática quiere tener: los N más nuevos sin escuchar. */
const wanted = (sub: Subscription): Episode[] =>
  sub.autoDownload > 0 ? visibleEpisodes(sub).filter((e) => !sub.progress[e.id]?.done).slice(0, sub.autoDownload) : [];

let syncing = false;
/** Se pidió otra vuelta mientras había una en marcha (p. ej. al suscribirse a algo nuevo). */
let again = false;

/**
 * Pone al día las descargas de todas las suscripciones: borra lo escuchado (y lo viejo que ya no se quiere) y
 * descarga los episodios más nuevos que falten, uno detrás de otro, si la red lo permite.
 */
export async function syncDownloads(): Promise<void> {
  if (!canDownloadEpisodes) return;
  if (syncing) {
    again = true;
    return;
  }
  syncing = true;
  try {
    for (const initial of subscriptions()) {
      const sub = subscription(initial.id);
      if (!sub) continue;
      const keep = new Set(wanted(sub).map((e) => e.id));
      for (const [episodeId, d] of Object.entries(sub.downloads)) {
        const progress = sub.progress[episodeId];
        const stillListed = sub.episodes.some((e) => e.id === episodeId);
        const stale = !keep.has(episodeId) && !progress && Date.now() - Date.parse(d.at) > STALE_DAYS * 86_400_000;
        if (progress?.done || !stillListed || stale) removeDownload(sub, episodeId);
      }
      for (const episode of wanted(sub)) {
        if (!networkAllowsDownloads()) return;
        const current = subscription(sub.id);
        if (!current || downloadedUri(current, episode)) continue;
        await downloadEpisode(current, episode).catch(() => {});
      }
    }
  } finally {
    syncing = false;
  }
  if (again) {
    again = false;
    await syncDownloads();
  }
}
