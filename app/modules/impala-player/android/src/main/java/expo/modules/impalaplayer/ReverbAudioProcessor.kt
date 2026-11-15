package expo.modules.impalaplayer

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessorChain
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.pow

/**
 * Reverberación propia para «slowed + reverb», dentro de la cadena de audio de ExoPlayer (después de
 * Sonic, que cambia velocidad y tono). Al no depender de los efectos del fabricante suena igual de
 * marcada en cualquier teléfono (los Samsung con SoundAlive/Dolby apenas dejaban oír el EnvironmentalReverb).
 *
 * Es un Freeverb (Schroeder-Moorer): 8 filtros peine con amortiguación por canal y 4 pasa-todo, con los
 * tiempos del original escalados a la frecuencia de muestreo. La cantidad ([amount], 0–1) decide a la
 * vez cuánto se oye la sala y lo grande que es ([Mix.of]): poca cantidad = sala corta y discreta; 100 %
 * = sala de ~6 s bien presente. No añade latencia (la señal seca sale en la misma muestra) ni cambia el
 * número de muestras, así que el gapless, el crossfade y la posición no se ven afectados.
 *
 * Procesa PCM de 16 bits o float (mono/estéreo). A 0 % solo copia la entrada. Los cambios de cantidad
 * se deslizan en ~60 ms (seco, húmedo y realimentación), así que no hay chasquidos al subir o bajar.
 */
@OptIn(UnstableApi::class)
internal class ReverbAudioProcessor : BaseAudioProcessor() {
  /** 0 = apagada, 1 = máxima. Lo cambia [PlaybackTuning] desde el hilo principal; se lee en el de audio. */
  @Volatile var amount = 0f

  private var dry = 1f
  private var wet = 0f
  private var feedback = Mix.FEEDBACK_MAX
  private var glide = 0f
  private var channels = 0
  private var float = false
  private var combsL: Array<Comb> = emptyArray()
  private var combsR: Array<Comb> = emptyArray()
  private var allpassL: Array<Allpass> = emptyArray()
  private var allpassR: Array<Allpass> = emptyArray()
  /** Hay cola sonando (o estado que limpiar) aunque ya esté apagada. */
  private var dirty = false

  override fun onConfigure(inputAudioFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
    val enc = inputAudioFormat.encoding
    if ((enc != C.ENCODING_PCM_16BIT && enc != C.ENCODING_PCM_FLOAT) || inputAudioFormat.channelCount !in 1..2) {
      return AudioProcessor.AudioFormat.NOT_SET
    }
    return inputAudioFormat
  }

  override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
    val format = inputAudioFormat
    if (format.sampleRate <= 0 || format.channelCount !in 1..2) return
    channels = format.channelCount
    float = format.encoding == C.ENCODING_PCM_FLOAT
    val scale = format.sampleRate / 44100f
    combsL = COMBS.map { Comb((it * scale).toInt()) }.toTypedArray()
    combsR = COMBS.map { Comb(((it + SPREAD) * scale).toInt()) }.toTypedArray()
    allpassL = ALLPASSES.map { Allpass((it * scale).toInt()) }.toTypedArray()
    allpassR = ALLPASSES.map { Allpass(((it + SPREAD) * scale).toInt()) }.toTypedArray()
    // Deslizamiento de un polo con constante de 20 ms: llega al valor nuevo en ~60 ms.
    glide = 1f - exp(-1.0 / (format.sampleRate * 0.02)).toFloat()
    val m = Mix.of(amount)
    dry = m.dry; wet = m.wet; feedback = m.feedback
    dirty = false
    Log.d("ImpalaTuning", "Freeverb en la cadena: ${format.sampleRate} Hz, ${format.channelCount} canales, ${if (float) "float" else "16 bits"}, $m")
  }

  override fun onReset() {
    combsL = emptyArray(); combsR = emptyArray(); allpassL = emptyArray(); allpassR = emptyArray()
    dry = 1f; wet = 0f
    dirty = false
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val size = inputBuffer.remaining()
    if (size == 0) return
    val out = replaceOutputBuffer(size)
    val target = Mix.of(amount)
    if (target.wet == 0f && wet == 0f) {
      if (dirty) {
        // Recién apagada: se limpia la cola para que al volver a encender no suene un resto viejo.
        combsL.forEach(Comb::clear); combsR.forEach(Comb::clear)
        allpassL.forEach(Allpass::clear); allpassR.forEach(Allpass::clear)
        dirty = false
      }
      dry = 1f
      feedback = target.feedback
      out.put(inputBuffer)
      out.flip()
      return
    }
    dirty = true
    val stereo = channels == 2
    val bytes = if (float) 4 else 2
    val frames = size / (bytes * channels)
    inputBuffer.order(ByteOrder.nativeOrder())
    for (f in 0 until frames) {
      if (wet != target.wet || dry != target.dry || feedback != target.feedback) {
        wet = slide(wet, target.wet)
        dry = slide(dry, target.dry)
        feedback = slide(feedback, target.feedback)
      }
      val l = read(inputBuffer)
      val r = if (stereo) read(inputBuffer) else l
      // Entrada mono a la sala, como Freeverb; el ruido mínimo evita números desnormalizados en silencio.
      val input = (l + r) * FIXED_GAIN + 1e-18f
      var outL = 0f
      var outR = 0f
      for (c in combsL) outL += c.process(input, feedback)
      for (c in combsR) outR += c.process(input, feedback)
      for (a in allpassL) outL = a.process(outL)
      for (a in allpassR) outR = a.process(outR)
      if (stereo) {
        write(out, l * dry + outL * wet)
        write(out, r * dry + outR * wet)
      } else {
        write(out, l * dry + (outL + outR) * 0.5f * wet)
      }
    }
    inputBuffer.position(inputBuffer.limit())
    out.flip()
  }

  private fun slide(from: Float, to: Float): Float {
    val next = from + (to - from) * glide
    return if (abs(to - next) < 1e-4f) to else next
  }

  private fun read(b: ByteBuffer): Float = if (float) b.float else b.short / 32768f

  private fun write(b: ByteBuffer, v: Float) {
    if (float) b.putFloat(v) else b.putShort((v * 32767f).coerceIn(-32768f, 32767f).toInt().toShort())
  }

  /**
   * Cantidad → mezcla. Húmedo = cantidad^1,5 (50 % ≈ 0,35: discreto pero claro); cola de 1 s + 5 s ×
   * cantidad (50 % ≈ 3,5 s, 100 % ≈ 6 s, la sala de antes); el seco se queda al 100 % hasta la mitad y
   * baja al 80 % en el máximo (como antes), para que la canción siga nítida.
   */
  data class Mix(val wet: Float, val dry: Float, val feedback: Float, val tailSeconds: Float) {
    override fun toString() =
      if (wet == 0f) "apagada (sin procesar)"
      else "húmedo %.2f seco %.2f realimentación %.4f cola ~%.1f s".format(java.util.Locale.ROOT, wet, dry, feedback, tailSeconds)

    companion object {
      /** Tamaño de sala 0,92 en Freeverb (0,92 × 0,28 + 0,7): cola de ~6 s. */
      const val FEEDBACK_MAX = 0.9576f
      private const val TAIL_MAX = 6f

      fun of(amount: Float): Mix {
        val a = amount.coerceIn(0f, 1f)
        if (a < 0.001f) return Mix(0f, 1f, FEEDBACK_MAX, 0f)
        val tail = 1f + 5f * a
        // La cola crece con 1 / log(realimentación): se escala desde la sala de 6 s.
        val fb = FEEDBACK_MAX.toDouble().pow((TAIL_MAX / tail).toDouble()).toFloat()
        val dry = 1f - 0.2f * ((a - 0.5f) / 0.5f).coerceAtLeast(0f)
        return Mix(a.toDouble().pow(1.5).toFloat(), dry, fb, tail)
      }
    }
  }

  private class Comb(size: Int) {
    private val buf = FloatArray(maxOf(1, size))
    private var i = 0
    private var store = 0f
    fun process(x: Float, feedback: Float): Float {
      val y = buf[i]
      store = y * DAMP2 + store * DAMP1
      buf[i] = x + store * feedback
      if (++i >= buf.size) i = 0
      return y
    }
    fun clear() { buf.fill(0f); store = 0f }
  }

  private class Allpass(size: Int) {
    private val buf = FloatArray(maxOf(1, size))
    private var i = 0
    fun process(x: Float): Float {
      val b = buf[i]
      buf[i] = x + b * 0.5f
      if (++i >= buf.size) i = 0
      return b - x
    }
    fun clear() = buf.fill(0f)
  }

  companion object {
    /** Amortiguación 0,2: agudos que se apagan poco (sala brillante). */
    const val DAMP1 = 0.08f
    const val DAMP2 = 1f - DAMP1
    private const val FIXED_GAIN = 0.015f
    private const val SPREAD = 23
    private val COMBS = intArrayOf(1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)
    private val ALLPASSES = intArrayOf(556, 441, 341, 225)
  }
}

/** Silencio-saltado y Sonic de siempre, y la reverberación al final (así su cola no se estira con Sonic). */
@OptIn(UnstableApi::class)
private class ReverbProcessorChain(private val reverb: ReverbAudioProcessor) : AudioProcessorChain {
  private val base = DefaultAudioSink.DefaultAudioProcessorChain()
  override fun getAudioProcessors(): Array<AudioProcessor> = base.audioProcessors + reverb
  override fun applyPlaybackParameters(playbackParameters: PlaybackParameters): PlaybackParameters = base.applyPlaybackParameters(playbackParameters)
  override fun applySkipSilenceEnabled(skipSilenceEnabled: Boolean): Boolean = base.applySkipSilenceEnabled(skipSilenceEnabled)
  override fun getMediaDuration(playoutDuration: Long): Long = base.getMediaDuration(playoutDuration)
  override fun getSkippedOutputFrameCount(): Long = base.skippedOutputFrameCount
}

/** Un factory por reproductor (el principal y el fader del crossfade), cada uno con su reverberación. */
@OptIn(UnstableApi::class)
internal class ImpalaRenderersFactory(context: Context) : DefaultRenderersFactory(context) {
  val reverb = ReverbAudioProcessor()

  override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParameters: Boolean): AudioSink =
    DefaultAudioSink.Builder(context)
      .setEnableFloatOutput(enableFloatOutput)
      .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParameters)
      .setAudioProcessorChain(ReverbProcessorChain(reverb))
      .build()
}
