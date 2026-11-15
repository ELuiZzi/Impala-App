package expo.modules.impalaplayer

import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player

/**
 * Temporizador de reposo: pausa el reproductor principal al cumplirse el tiempo o al terminar la
 * canción actual. Vive en el proceso junto al PlaybackService (que le entrega su reproductor), así
 * que sigue contando aunque se recargue el JS o la app esté minimizada. Todo en el hilo principal.
 */
internal object SleepTimer {
  private val handler = Handler(Looper.getMainLooper())
  private var player: Player? = null

  /** Hora (System.currentTimeMillis) en que pausará; 0 si no hay temporizador por tiempo. */
  @Volatile var endsAtMs = 0L
    private set

  /** Pausa al terminar la canción actual. El crossfade se desactiva mientras tanto. */
  @Volatile var endOfTrack = false
    private set

  /** El módulo lo usa para avisar al JS de cada cambio. */
  var onChange: (() -> Unit)? = null

  private val fire = Runnable {
    player?.pause()
    clear()
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      if (endOfTrack && (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)) {
        player?.pause()
        clear()
      }
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      // La última canción de la cola terminó: no hay transición, pero ya no suena nada.
      if (endOfTrack && playbackState == Player.STATE_ENDED) clear()
    }
  }

  fun attach(p: Player) {
    player?.removeListener(listener)
    player = p
    p.addListener(listener)
  }

  fun detach(p: Player) {
    p.removeListener(listener)
    if (player === p) {
      player = null
      clear()
    }
  }

  fun start(durationMs: Long) {
    handler.removeCallbacks(fire)
    endOfTrack = false
    endsAtMs = System.currentTimeMillis() + durationMs
    handler.postDelayed(fire, durationMs)
    onChange?.invoke()
  }

  fun startEndOfTrack() {
    handler.removeCallbacks(fire)
    endsAtMs = 0L
    endOfTrack = true
    onChange?.invoke()
  }

  fun clear() {
    handler.removeCallbacks(fire)
    val changed = endsAtMs != 0L || endOfTrack
    endsAtMs = 0L
    endOfTrack = false
    if (changed) onChange?.invoke()
  }
}
