import type { NativeTrack, ProgressEvent } from '../index';

/**
 * Media Session: el panel multimedia de Windows (con carátula), las teclas multimedia del teclado y los
 * botones de los auriculares Bluetooth. Es lo que en Android hacen la notificación y la MediaSession.
 */
type Handlers = { play(): void; pause(): void; next(): void; previous(): void; seekTo(ms: number): void };

const session = (): MediaSession | null => (typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null);

export function setMediaSessionHandlers(h: Handlers) {
  const s = session();
  if (!s) return;
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
    try {
      s.setActionHandler(action, handler);
    } catch {
      // Acción no soportada por este navegador.
    }
  };
  set('play', () => h.play());
  set('pause', () => h.pause());
  set('nexttrack', () => h.next());
  set('previoustrack', () => h.previous());
  set('seekto', (d) => d.seekTime != null && h.seekTo(d.seekTime * 1000));
}

export function updateMediaSession(track: NativeTrack | null, progress?: ProgressEvent) {
  const s = session();
  if (!s) return;
  if (track) {
    s.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '600x600' }] : [],
    });
  }
  if (progress?.durationMs) {
    try {
      s.setPositionState({
        duration: progress.durationMs / 1000,
        position: Math.min(progress.positionMs, progress.durationMs) / 1000,
        playbackRate: progress.speed || 1,
      });
    } catch {
      // Posición fuera de rango mientras carga: se ignora.
    }
  }
}

export function clearMediaSession() {
  const s = session();
  if (!s) return;
  s.metadata = null;
  s.playbackState = 'none';
}
