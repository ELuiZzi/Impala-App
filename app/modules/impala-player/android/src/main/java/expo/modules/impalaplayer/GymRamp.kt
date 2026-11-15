package expo.modules.impalaplayer

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.Player
import kotlin.math.roundToInt

/**
 * Volumen gradual para sesiones de gym: sube el volumen multimedia de Android paso a paso, desde el
 * que hay al activarlo hasta el máximo elegido en Ajustes, repartido a lo largo de los minutos
 * configurados. Solo avanza mientras suena música (en pausa se detiene la subida).
 *
 * Si el usuario mueve el volumen con los botones, la subida se cancela: manda él. Vive junto al
 * PlaybackService (como el temporizador de reposo) y sigue funcionando con la app minimizada.
 */
internal object GymRamp {
  private const val TAG = "ImpalaGymRamp"
  private const val TICK_MS = 1_000L
  const val KEY_MAX_PERCENT = "gym_max_percent"
  const val KEY_MINUTES = "gym_minutes"
  const val DEFAULT_MAX_PERCENT = 85
  const val DEFAULT_MINUTES = 20

  private val handler = Handler(Looper.getMainLooper())
  private var player: Player? = null
  private var audio: AudioManager? = null

  @Volatile var active = false
    private set
  /** Por qué terminó la última subida: "done", "manual" (botones), "limit" (Android no dejó subir) o "stopped". */
  @Volatile var lastEnd: String? = null
    private set
  @Volatile var startIndex = 0
    private set
  @Volatile var targetIndex = 0
    private set
  @Volatile var maxIndex = 15
    private set
  @Volatile var durationMs = 0L
    private set
  @Volatile var playedMs = 0L
    private set
  private var lastSet = -1

  /** El módulo lo usa para avisar al JS de cada cambio. */
  var onChange: (() -> Unit)? = null

  private val tick = object : Runnable {
    override fun run() {
      step()
      if (active) handler.postDelayed(this, TICK_MS)
    }
  }

  fun attach(p: Player) {
    player = p
  }

  fun detach(p: Player) {
    if (player === p) {
      player = null
      stop("stopped")
    }
  }

  fun maxPercent(context: Context) = prefs(context).getInt(KEY_MAX_PERCENT, DEFAULT_MAX_PERCENT).coerceIn(10, 100)
  fun minutes(context: Context) = prefs(context).getInt(KEY_MINUTES, DEFAULT_MINUTES).coerceIn(1, 120)

  fun configure(context: Context, maxPercent: Int, minutes: Int) {
    prefs(context).edit()
      .putInt(KEY_MAX_PERCENT, maxPercent.coerceIn(10, 100))
      .putInt(KEY_MINUTES, minutes.coerceIn(1, 120))
      .apply()
  }

  fun start(context: Context) {
    val am = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audio = am
    handler.removeCallbacks(tick)
    maxIndex = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    startIndex = am.getStreamVolume(AudioManager.STREAM_MUSIC)
    targetIndex = (maxIndex * maxPercent(context) / 100.0).roundToInt().coerceIn(0, maxIndex)
    durationMs = minutes(context) * 60_000L
    playedMs = 0L
    lastSet = startIndex
    lastEnd = null
    active = true
    onChange?.invoke()
    // Ya está en el máximo o por encima: no hay nada que subir (nunca se baja el volumen).
    if (startIndex >= targetIndex) {
      stop("done")
      return
    }
    handler.postDelayed(tick, TICK_MS)
  }

  fun stop(reason: String = "stopped") {
    handler.removeCallbacks(tick)
    if (!active) return
    active = false
    lastEnd = reason
    onChange?.invoke()
  }

  /** 0…1: cuánto de la subida ya se hizo. */
  val progress: Double
    get() = if (durationMs <= 0) 1.0 else (playedMs.toDouble() / durationMs).coerceIn(0.0, 1.0)

  private fun step() {
    val am = audio ?: return stop("stopped")
    val now = am.getStreamVolume(AudioManager.STREAM_MUSIC)
    if (now != lastSet) {
      // Lo movió el usuario (o el sistema): la subida automática se retira.
      Log.i(TAG, "volumen cambiado a mano ($lastSet → $now): se detiene la subida")
      return stop("manual")
    }
    if (player?.isPlaying == true) playedMs += TICK_MS
    val desired = (startIndex + (targetIndex - startIndex) * progress).roundToInt()
    if (desired > lastSet) {
      am.setStreamVolume(AudioManager.STREAM_MUSIC, desired, 0)
      val applied = am.getStreamVolume(AudioManager.STREAM_MUSIC)
      if (applied < desired) {
        // Android limita el volumen con audífonos ("volumen seguro"): no se insiste.
        Log.i(TAG, "Android no permitió subir a $desired (quedó en $applied)")
        lastSet = applied
        return stop("limit")
      }
      lastSet = applied
      onChange?.invoke()
    }
    if (progress >= 1.0) stop("done")
  }

  /** Volumen actual del sistema en %, para mostrarlo. */
  fun currentPercent(context: Context): Int {
    val am = audio ?: (context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager)
    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    return (am.getStreamVolume(AudioManager.STREAM_MUSIC) * 100.0 / max).roundToInt()
  }

  private fun prefs(context: Context) = context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
}
