package expo.modules.impalaplayer

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.pow

/**
 * Velocidad y tono ("sped up" / "slowed"). [vinyl]: el tono sigue a la velocidad, como un disco a
 * otras revoluciones; si no, la velocidad cambia sin tocar el tono (Sonic, dentro de ExoPlayer).
 * [semitones] suma (o resta) tono por encima de eso. [reverb]: cantidad de reverberación, 0–100 (0 = apagada).
 */
internal data class Tuning(
  val speed: Float = 1f,
  val semitones: Float = 0f,
  val vinyl: Boolean = false,
  val reverb: Int = 0,
) {
  val pitch: Float get() = (if (vinyl) speed else 1f) * 2.0.pow(semitones / 12.0).toFloat()

  fun toJson(): String = JSONObject()
    .put("speed", speed.toDouble())
    .put("semitones", semitones.toDouble())
    .put("vinyl", vinyl)
    .put("reverb", reverb)
    .toString()

  fun clamped() = copy(speed = speed.coerceIn(MIN_SPEED, MAX_SPEED), semitones = semitones.coerceIn(-MAX_SEMITONES, MAX_SEMITONES), reverb = reverb.coerceIn(0, 100))

  companion object {
    const val MIN_SPEED = 0.5f
    const val MAX_SPEED = 2f
    const val MAX_SEMITONES = 12f
    /** Cantidad del preajuste «Slowed + reverb»; también la que reciben los ajustes viejos con reverb encendida. */
    const val DEFAULT_REVERB = 40

    fun parse(json: String?): Tuning? = try {
      json?.let {
        val o = JSONObject(it)
        Tuning(
          o.optDouble("speed", 1.0).toFloat(),
          o.optDouble("semitones", 0.0).toFloat(),
          o.optBoolean("vinyl", false),
          // Hasta ahora era un sí/no: encendida pasa a la cantidad por defecto.
          when (val r = o.opt("reverb")) {
            is Boolean -> if (r) DEFAULT_REVERB else 0
            is Number -> r.toInt()
            else -> 0
          },
        ).clamped()
      }
    } catch (e: Exception) {
      null
    }
  }
}

/**
 * Aplica la velocidad, el tono y la reverberación a cada reproductor (el principal y el fader del
 * crossfade), según la canción que tenga cargada: la de esa canción si se guardó aparte, o la global.
 * Todo vive en SharedPreferences (lo escribe el módulo) y se aplica al momento, como el potenciador.
 *
 * La reverberación es un procesador propio dentro de la cadena de audio de cada reproductor
 * ([ReverbAudioProcessor], tras Sonic): no depende de los efectos del fabricante y suena igual en
 * todos los teléfonos. ExoPlayer no usa audio offload aquí, así que siempre se procesa.
 */
internal class PlaybackTuning(context: Context) : SharedPreferences.OnSharedPreferenceChangeListener {
  private val prefs = context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
  private val listeners = mutableMapOf<ExoPlayer, Player.Listener>()
  private val reverbs = mutableMapOf<ExoPlayer, ReverbAudioProcessor>()

  init {
    prefs.registerOnSharedPreferenceChangeListener(this)
  }

  fun attach(player: ExoPlayer, reverb: ReverbAudioProcessor) {
    val listener = object : Player.Listener {
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) = apply(player)
    }
    player.addListener(listener)
    listeners[player] = listener
    reverbs[player] = reverb
    apply(player)
  }

  /** Llamar antes de liberar el reproductor. */
  fun detach(player: ExoPlayer) {
    listeners.remove(player)?.let { player.removeListener(it) }
    reverbs.remove(player)?.amount = 0f
  }

  fun release() {
    prefs.unregisterOnSharedPreferenceChangeListener(this)
    listeners.keys.toList().forEach(::detach)
  }

  private fun tuningFor(item: MediaItem?): Tuning {
    val id = item?.mediaId?.takeIf { it.isNotEmpty() }
    val own = id?.let { Tuning.parse(prefs.getString(songKey(prefs, it), null)) }
    return own ?: Tuning.parse(prefs.getString(KEY_GLOBAL, null)) ?: Tuning()
  }

  private fun apply(player: ExoPlayer) {
    val t = tuningFor(player.currentMediaItem)
    val params = PlaybackParameters(t.speed, t.pitch)
    val currentParams = player.playbackParameters
    if (abs(currentParams.speed - params.speed) > 1e-4f || abs(currentParams.pitch - params.pitch) > 1e-4f) {
      player.playbackParameters = params
      Log.d(TAG, "velocidad ${t.speed}× tono ${t.pitch} (${t.semitones} st, vinilo ${t.vinyl}) reverb ${t.reverb} en ${player.currentMediaItem?.mediaId}")
    }
    setReverb(player, t.reverb)
  }

  private fun setReverb(player: ExoPlayer, percent: Int) {
    val reverb = reverbs[player] ?: return
    val amount = percent / 100f
    if (reverb.amount != amount) {
      reverb.amount = amount
      Log.d(TAG, "reverberación $percent %: ${ReverbAudioProcessor.Mix.of(amount)} en ${player.currentMediaItem?.mediaId}")
    }
  }

  override fun onSharedPreferenceChanged(sharedPreferences: SharedPreferences?, key: String?) {
    if (key == null || key.startsWith(PREFIX)) listeners.keys.toList().forEach(::apply)
  }

  companion object {
    private const val PREFIX = "tuning_"
    const val KEY_GLOBAL = "tuning_global"
    /** Fuente de música actual (la fija la app): los ids de canción solo son únicos dentro de una fuente. */
    const val KEY_SCOPE = "tuning_scope"
    private const val TAG = "ImpalaTuning"

    fun songKey(prefs: SharedPreferences, songId: String) = "tuning_song:${prefs.getString(KEY_SCOPE, "") ?: ""}|$songId"
  }
}
