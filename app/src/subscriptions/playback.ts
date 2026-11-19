import { youtubePreviewSource } from '@/api/youtube';
import type { Session } from '@/api/subsonic';
import { currentSong, isEpisodeId, playerState, playSongs, subscribePlayer } from '@/player/store';
import ImpalaPlayer from '../../modules/impala-player';
import { downloadedUri, syncDownloads } from './downloads';
import type { Episode } from './feeds';
import { episodeSpeed, setProgress, subscription, type Subscription } from './store';

/**
 * Escuchar episodios de las suscripciones en el reproductor principal (notificación, pantalla de bloqueo,
 * pantalla apagada), recordando dónde se quedó cada uno. Suenan solos (la cola es ese episodio), sin pasar por
 * la biblioteca: el audio sale del enlace del podcast o, si es de YouTube, del audio del video.
 */

/** Al seguir un episodio a medias, se retrocede un poco para recordar lo último que se oyó. */
const RESUME_REWIND_MS = 3000;
/** A partir de aquí cuenta como escuchado (los créditos finales no hace falta oírlos). */
const DONE_RATIO = 0.95;
/** Cada cuánto se guarda la posición mientras suena (y siempre al pausar o cambiar de pista). */
const SAVE_EVERY_MS = 10_000;

/** Id de la pista en el reproductor: «ep:<suscripción>:<episodio>» (ambos codificados, pueden ser enlaces). */
export const episodeTrackId = (subId: string, episodeId: string) => `ep:${encodeURIComponent(subId)}:${encodeURIComponent(episodeId)}`;

function parseTrackId(id: string): { subId: string; episodeId: string } | null {
  const m = /^ep:([^:]+):([^:]+)$/.exec(id);
  return m ? { subId: decodeURIComponent(m[1]), episodeId: decodeURIComponent(m[2]) } : null;
}

let session: Session | null = null;
/** Sesión del servidor (o null en modo local): para el audio de YouTube a través del servidor si el directo falla. */
export function setEpisodeSession(s: Session | null) {
  session = s;
}

/**
 * El audio: el archivo descargado si lo hay; si no, el enlace del podcast o el de YouTube (directo; con otra
 * identidad; o a través del servidor).
 */
async function audioUrl(sub: Subscription, episode: Episode, attempt: number): Promise<string> {
  const local = attempt === 0 ? downloadedUri(sub, episode) : null;
  if (local) return local;
  if (episode.audioUrl) return episode.audioUrl;
  if (!episode.videoId) throw new Error('Este episodio no tiene audio');
  const source = youtubePreviewSource(session, episode.videoId);
  if (attempt < 2) {
    try {
      return await source.direct(attempt === 1);
    } catch {
      // Sin URL directa: se prueba el servidor.
    }
  }
  if (source.server) return source.server;
  throw new Error('No se pudo obtener el audio de YouTube');
}

/** Lo que guarda el progreso a medias de un episodio (o null si se escuchó entero o nunca). */
export function resumePosition(sub: Subscription, episode: Episode): number {
  const p = sub.progress[episode.id];
  return p && !p.done ? Math.max(0, p.positionMs - RESUME_REWIND_MS) : 0;
}

async function start(sub: Subscription, episode: Episode, positionMs: number, attempt: number) {
  const url = await audioUrl(sub, episode, attempt);
  const id = episodeTrackId(sub.id, episode.id);
  // Velocidad propia de los episodios, sin cambiar el tono ni la reverb (el «sped up» de la música no se aplica).
  ImpalaPlayer.setPlaybackTuning(id, episodeSpeed(), 0, false, 0);
  attempts.set(id, attempt);
  await playSongs(
    [
      {
        id,
        title: episode.title,
        artist: sub.title,
        album: sub.kind === 'youtube' ? 'YouTube' : 'Podcast',
        coverArt: episode.image ?? sub.image ?? undefined,
        duration: episode.durationSec ?? undefined,
        streamUrl: url,
      },
    ],
    0,
    { startPositionMs: positionMs },
  );
}

/** Reproduce el episodio desde donde se quedó (o desde el principio si se escuchó entero). */
export function playEpisode(sub: Subscription, episode: Episode, { fromStart = false } = {}) {
  return start(sub, episode, fromStart ? 0 : resumePosition(sub, episode), 0);
}

/** Cambia la velocidad del episodio que suena (las siguientes ya la toman de episodeSpeed). */
export function applyEpisodeSpeed(speed: number) {
  const id = currentSong(playerState())?.id;
  if (isEpisodeId(id)) ImpalaPlayer.setPlaybackTuning(id!, speed, 0, false, 0);
}

// --- Progreso -------------------------------------------------------------------------------

/** Intento de audio de cada pista (0 directo, 1 otra identidad, 2 servidor), para reintentar si falla. */
const attempts = new Map<string, number>();
let tracking = false;
let last: { id: string; positionMs: number; durationMs: number | null; playing: boolean; savedAt: number } | null = null;

function save(id: string, positionMs: number, durationMs: number | null, ended = false) {
  const ref = parseTrackId(id);
  if (!ref) return;
  // Al empezar, el reproductor aún no sabe la duración: se conserva la que ya se conocía.
  const known = durationMs ?? subscription(ref.subId)?.progress[ref.episodeId]?.durationMs ?? null;
  const done = ended || (!!known && positionMs >= known * DONE_RATIO);
  setProgress(ref.subId, ref.episodeId, { positionMs: done ? 0 : positionMs, durationMs: known, done });
  // Escuchado: su descarga sobra (y quizá toca descargar el siguiente).
  if (done) void syncDownloads();
}

/** Sigue al reproductor: guarda la posición de los episodios y reintenta si falla su audio. Una vez, al arrancar. */
export function startEpisodeTracking() {
  if (tracking) return;
  tracking = true;
  subscribePlayer(() => {
    const s = playerState();
    const song = currentSong(s);
    const id = song && isEpisodeId(song.id) ? song.id : null;

    // Cambió de pista: lo último que se supo de la anterior.
    if (last && last.id !== id) {
      save(last.id, last.positionMs, last.durationMs);
      last = null;
    }
    if (!id) return;

    if (s.playbackState === 'ended') {
      if (last) save(id, last.positionMs, last.durationMs, true);
      last = { id, positionMs: 0, durationMs: s.durationMs, playing: false, savedAt: Date.now() };
      return;
    }

    const now = Date.now();
    const paused = !s.playWhenReady && (last?.playing ?? false);
    last = { id, positionMs: s.positionMs, durationMs: s.durationMs, playing: s.playWhenReady, savedAt: last?.id === id ? last.savedAt : now };
    if (paused || now - last.savedAt >= SAVE_EVERY_MS) {
      save(id, s.positionMs, s.durationMs);
      last.savedAt = now;
    }

    // El audio de YouTube a veces no suena (enlace caducado, de otra IP…): siguiente forma de pedirlo.
    if (s.error) void retry(id, s.positionMs);
  });
}

async function retry(id: string, positionMs: number) {
  const attempt = attempts.get(id) ?? 0;
  const ref = parseTrackId(id);
  const sub = ref && subscription(ref.subId);
  const episode = sub?.episodes.find((e) => e.id === ref!.episodeId);
  if (!sub || !episode?.videoId || attempt >= 2) return;
  attempts.set(id, attempt + 1);
  await start(sub, episode, positionMs, attempt + 1).catch(() => {});
}
