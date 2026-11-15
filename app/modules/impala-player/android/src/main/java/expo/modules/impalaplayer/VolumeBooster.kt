package expo.modules.impalaplayer

import android.content.Context
import android.content.SharedPreferences
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer

/**
 * Potenciador de volumen: un LoudnessEnhancer (efecto de Android) sobre la sesión de audio de cada
 * reproductor, el principal y el fader del crossfade. Sube el nivel por encima del 100 % del
 * volumen multimedia; su limitador interno evita el recorte digital, pero comprime la dinámica.
 *
 * La ganancia vive en SharedPreferences (la escribe el módulo) y se aplica al momento: el
 * servicio corre en el mismo proceso que la app, así que el listener de preferencias se dispara.
 */
internal class VolumeBooster(context: Context) : SharedPreferences.OnSharedPreferenceChangeListener {
  private val prefs = context.getSharedPreferences(CrossfadeController.PREFS, Context.MODE_PRIVATE)
  private val enhancers = mutableMapOf<ExoPlayer, LoudnessEnhancer>()
  private val sessionListeners = mutableMapOf<ExoPlayer, Player.Listener>()

  init {
    prefs.registerOnSharedPreferenceChangeListener(this)
  }

  private val gainMb: Int get() = prefs.getInt(KEY_BOOST_DB, 0).coerceIn(0, MAX_BOOST_DB) * 100

  fun attach(player: ExoPlayer) {
    bind(player, player.audioSessionId)
    // La sesión de audio puede cambiar (p. ej. al reconfigurar la salida): seguimos a la nueva.
    val listener = object : Player.Listener {
      override fun onAudioSessionIdChanged(audioSessionId: Int) = bind(player, audioSessionId)
    }
    player.addListener(listener)
    sessionListeners[player] = listener
  }

  /** Llamar antes de liberar el reproductor. */
  fun detach(player: ExoPlayer) {
    sessionListeners.remove(player)?.let { player.removeListener(it) }
    enhancers.remove(player)?.release()
  }

  fun release() {
    prefs.unregisterOnSharedPreferenceChangeListener(this)
    (sessionListeners.keys + enhancers.keys).toList().forEach(::detach)
  }

  private fun bind(player: ExoPlayer, sessionId: Int) {
    enhancers.remove(player)?.release()
    if (sessionId == C.AUDIO_SESSION_ID_UNSET) return
    try {
      enhancers[player] = LoudnessEnhancer(sessionId).also(::applyGain)
    } catch (e: RuntimeException) {
      // Algunos dispositivos no ofrecen el efecto; la reproducción sigue sin potenciar.
      Log.w(TAG, "LoudnessEnhancer no disponible", e)
    }
  }

  private fun applyGain(enhancer: LoudnessEnhancer) {
    val gain = gainMb
    enhancer.setTargetGain(gain)
    enhancer.enabled = gain > 0
  }

  override fun onSharedPreferenceChanged(sharedPreferences: SharedPreferences?, key: String?) {
    if (key == KEY_BOOST_DB) enhancers.values.forEach(::applyGain)
  }

  companion object {
    const val KEY_BOOST_DB = "volume_boost_db"
    const val MAX_BOOST_DB = 15
    private const val TAG = "ImpalaVolumeBooster"
  }
}
