package expo.modules.impalaplayer

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.exoplayer.ExoPlayer
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Crossfade entre pistas con un segundo ExoPlayer ("fader").
 *
 * El reproductor principal sigue siendo el único que ve la MediaSession (notificación, pantalla de
 * bloqueo, Bluetooth). Cerca del final de una pista:
 *  1. PREPARING: el fader carga la siguiente pista en pausa, para que suene sin demora.
 *  2. FADING: el principal baja y el fader sube con curvas de igual potencia (cos/sin).
 *  3. HANDOFF: el principal salta a la siguiente pista en la posición del fader y, cuando ya suena,
 *     un micro-fundido de 200 ms le devuelve el volumen mientras el fader se apaga.
 *
 * Pausar, buscar, saltar o editar la cola cancela el fundido. No se aplica entre pistas del mismo
 * álbum (discos sin pausas), con "repetir una" ni en pistas demasiado cortas.
 */
internal class CrossfadeController(
  context: Context,
  private val main: ExoPlayer,
  private val createFader: () -> ExoPlayer,
  private val releaseFader: (ExoPlayer) -> Unit = { it.release() },
) : Player.Listener {

  private enum class Phase { IDLE, PREPARING, FADING, HANDOFF }

  private val handler = Handler(Looper.getMainLooper())
  private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private var phase = Phase.IDLE
  private var fader: ExoPlayer? = null
  private var fadeStartedAt = 0L
  private var fadeMs = 0L
  private var handoffStartedAt = 0L
  private var handoffReadyAt = 0L
  /** Saltos de resincronización hechos en el relevo actual. */
  private var resyncs = 0
  /** Desde cuándo el principal suena (en silencio) tras el último salto; 0 si aún carga. */
  private var playingSince = 0L
  private val driftSamples = mutableListOf<Long>()
  /** Discontinuidades provocadas por el propio relevo: no deben cancelar el fundido. */
  private var ownSeekPending = false
  private var ticking = false

  private val tick = object : Runnable {
    override fun run() {
      step()
      if (phase == Phase.IDLE && !main.isPlaying) {
        ticking = false
      } else {
        handler.postDelayed(this, TICK_MS)
      }
    }
  }

  fun start() {
    main.addListener(this)
    if (main.isPlaying) ensureTicking()
  }

  fun release() {
    handler.removeCallbacks(tick)
    ticking = false
    main.removeListener(this)
    reset()
  }

  // Con el temporizador "al terminar la canción" no hay fundido: la siguiente no debe empezar a sonar.
  private val crossfadeMs: Long get() = if (SleepTimer.endOfTrack) 0L else prefs.getInt(KEY_CROSSFADE_MS, 0).toLong()

  private fun ensureTicking() {
    if (!ticking) {
      ticking = true
      handler.post(tick)
    }
  }

  private fun now() = SystemClock.elapsedRealtime()

  private fun step() {
    when (phase) {
      Phase.IDLE -> maybePrepare()
      Phase.PREPARING -> maybeStartFade()
      Phase.FADING -> {
        val p = ((now() - fadeStartedAt).toFloat() / fadeMs).coerceIn(0f, 1f)
        main.volume = cos(p * PI / 2).toFloat()
        fader?.volume = sin(p * PI / 2).toFloat()
        if (p >= 1f) handoff(main.nextMediaItemIndex)
      }
      Phase.HANDOFF -> {
        val f = fader ?: return reset()
        if (main.playbackState == Player.STATE_READY && main.isPlaying) {
          if (handoffReadyAt == 0L) {
            // El principal tardó en cargar mientras el fader seguía sonando: si quedó atrás (o adelante),
            // se oiría un salto al cruzar los volúmenes. Ya tiene ese tramo en búfer (o en StreamCache),
            // así que un salto corto a la posición actual del fader es casi instantáneo.
            // Recién arrancada, la posición del audio aún no es fiable, y la que se lee de cada reproductor
            // avanza a saltos (en diente de sierra, ±100 ms): se deja asentar y se promedian varias medidas
            // seguidas. Con una sola, cada resincronización apuntaba mal y el relevo acababa desfasado.
            if (playingSince == 0L) playingSince = now()
            if (now() - playingSince < SETTLE_MS) return
            driftSamples.add(f.currentPosition - main.currentPosition)
            if (driftSamples.size < DRIFT_SAMPLES) return
            val drift = driftSamples.average().toLong()
            Log.d(TAG, "relevo: desfase $drift ms $driftSamples; sonando a los ${playingSince - handoffStartedAt} ms del salto (resincronizaciones: $resyncs)")
            driftSamples.clear()
            if (abs(drift) > MAX_DRIFT_MS && resyncs < MAX_RESYNCS) {
              resyncs++
              ownSeekPending = true
              playingSince = 0L
              main.seekTo(main.currentPosition + drift + (RESYNC_LEAD_MS * f.playbackParameters.speed).toLong())
              return
            }
            handoffReadyAt = now()
          }
          val p = ((now() - handoffReadyAt).toFloat() / HANDOFF_FADE_MS).coerceIn(0f, 1f)
          main.volume = p
          f.volume = 1f - p
          if (p >= 1f) reset()
        } else {
          playingSince = 0L
          driftSamples.clear()
          if (now() - handoffStartedAt > HANDOFF_TIMEOUT_MS) {
            reset() // el principal tardó demasiado en cargar: devolvemos el volumen y seguimos
          }
        }
      }
    }
  }

  /** Velocidad del principal ("sped up"/"slowed"): las posiciones son del audio; los fundidos, de reloj. */
  private val speed: Float get() = main.playbackParameters.speed.coerceAtLeast(0.1f)

  /** Tiempo real (de reloj) que le queda a la pista actual, contando su velocidad. */
  private fun remainingMs(): Long? {
    val duration = main.duration
    if (duration == C.TIME_UNSET) return null
    return ((duration - main.currentPosition) / speed).toLong()
  }

  /** ¿La transición actual → siguiente admite crossfade? */
  private fun nextCandidate(ms: Long): MediaItem? {
    if (ms <= 0 || !main.isPlaying || main.repeatMode == Player.REPEAT_MODE_ONE) return null
    val nextIndex = main.nextMediaItemIndex
    if (nextIndex == C.INDEX_UNSET) return null
    val duration = main.duration
    if (duration == C.TIME_UNSET || duration / speed < ms * 3) return null
    val current = main.currentMediaItem ?: return null
    val next = main.getMediaItemAt(nextIndex)
    if (next.localConfiguration == null || sameAlbum(current, next)) return null
    return next
  }

  private fun maybePrepare() {
    val ms = crossfadeMs
    val remaining = remainingMs() ?: return
    if (remaining > ms + PREPARE_LEAD_MS) return
    val next = nextCandidate(ms) ?: return
    fader = createFader().apply {
      volume = 0f
      setMediaItem(next)
      playWhenReady = false
      prepare()
    }
    phase = Phase.PREPARING
  }

  private fun maybeStartFade() {
    val f = fader ?: return reset()
    val remaining = remainingMs() ?: return
    if (remaining > crossfadeMs + END_MARGIN_MS) return
    // Si el fader aún no está listo seguimos esperando; si ya no queda margen, nos rendimos.
    if (f.playbackState != Player.STATE_READY) {
      if (remaining < MIN_FADE_MS + END_MARGIN_MS) reset()
      return
    }
    fadeMs = min(crossfadeMs, remaining - END_MARGIN_MS).coerceAtLeast(MIN_FADE_MS)
    fadeStartedAt = now()
    f.play()
    phase = Phase.FADING
  }

  /** El principal salta a [targetIndex] en la posición del fader, todavía en silencio. */
  private fun handoff(targetIndex: Int) {
    val f = fader
    if (f == null || targetIndex == C.INDEX_UNSET) return reset()
    main.volume = 0f
    f.volume = 1f
    ownSeekPending = true
    // El fader pudo ir a otra velocidad (la de la siguiente canción): la compensación es en su tiempo de audio.
    main.seekTo(targetIndex, f.currentPosition + (SEEK_COMPENSATION_MS * f.playbackParameters.speed).toLong())
    handoffStartedAt = now()
    handoffReadyAt = 0L
    resyncs = 0
    playingSince = 0L
    driftSamples.clear()
    phase = Phase.HANDOFF
  }

  /** Vuelve al estado normal: un solo reproductor a volumen completo. */
  private fun reset() {
    fader?.let(releaseFader)
    fader = null
    main.volume = 1f
    phase = Phase.IDLE
    ownSeekPending = false
  }

  private fun sameAlbum(a: MediaItem, b: MediaItem): Boolean {
    val albumA = a.mediaMetadata.albumTitle?.toString() ?: return false
    val albumB = b.mediaMetadata.albumTitle?.toString() ?: return false
    return albumA == albumB && a.mediaMetadata.artist?.toString() == b.mediaMetadata.artist?.toString()
  }

  // --- Eventos del reproductor principal ------------------------------------------------------

  override fun onIsPlayingChanged(isPlaying: Boolean) {
    if (isPlaying) ensureTicking()
  }

  override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
    if (!playWhenReady && phase != Phase.IDLE) reset() // el usuario pausó
  }

  override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
    if (reason != Player.DISCONTINUITY_REASON_SEEK) return
    if (ownSeekPending) {
      ownSeekPending = false
    } else if (phase != Phase.IDLE) {
      reset() // el usuario buscó o saltó de pista
    }
  }

  override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
    // Si el principal llegó al final antes del relevo, el relevo se hace sobre la pista ya actual.
    if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && phase == Phase.FADING) {
      handoff(main.currentMediaItemIndex)
    }
  }

  override fun onTimelineChanged(timeline: Timeline, reason: Int) {
    if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED && (phase == Phase.PREPARING || phase == Phase.FADING)) {
      reset() // la cola cambió: la "siguiente" que precargamos puede ya no serlo
    }
  }

  companion object {
    const val PREFS = "impala_player"
    const val KEY_CROSSFADE_MS = "crossfade_ms"

    private const val TAG = "ImpalaCrossfade"
    private const val TICK_MS = 50L
    private const val PREPARE_LEAD_MS = 4_000L
    private const val END_MARGIN_MS = 300L
    private const val MIN_FADE_MS = 1_000L
    private const val HANDOFF_FADE_MS = 200f
    private const val HANDOFF_TIMEOUT_MS = 8_000L
    /** Tiempo sonando antes de medir el desfase, y cuántas medidas (cada TICK_MS) se toman. */
    private const val SETTLE_MS = 250L
    private const val DRIFT_SAMPLES = 8
    private const val SEEK_COMPENSATION_MS = 60L
    /** Desfase tolerable entre principal y fader al cruzar volúmenes (por debajo no se percibe). */
    private const val MAX_DRIFT_MS = 40L
    private const val MAX_RESYNCS = 5
    /** Lo que tarda en aplicarse un salto dentro del búfer. */
    private const val RESYNC_LEAD_MS = 25L
  }
}
