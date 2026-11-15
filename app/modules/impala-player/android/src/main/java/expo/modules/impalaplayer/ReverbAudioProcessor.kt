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

/**
 * Reverberación propia para «slowed + reverb», dentro de la cadena de audio de ExoPlayer (después de
 * Sonic, que cambia velocidad y tono). Al no depender de los efectos del fabricante suena igual de
 * marcada en cualquier teléfono (los Samsung con SoundAlive/Dolby apenas dejaban oír el EnvironmentalReverb).
 *
 * Es un Freeverb (Schroeder-Moorer): 8 filtros peine con amortiguación por canal y 4 pasa-todo, con los
 * tiempos del original escalados a la frecuencia de muestreo. Sala ~0,92 → cola de ~6 s, mezcla
 * ~40 % húmeda. No añade latencia (la señal seca sale en la misma muestra) ni cambia el número de
 * muestras, así que el gapless, el crossfade y la posición no se ven afectados.
 *
 * Siempre está activo para PCM de 16 bits o float (mono/estéreo); apagado solo copia la entrada. Al
 * encender o apagar, la mezcla cambia en ~60 ms para que no haya chasquidos.
 */
@OptIn(UnstableApi::class)
internal class ReverbAudioProcessor : BaseAudioProcessor() {
  /** Lo cambia [PlaybackTuning] desde el hilo principal; se lee en el hilo de audio. */
  @Volatile var enabled = false

  private var mix = 0f
  private var mixStep = 0f
  private var channels = 0
  private var float = false
  private var combsL: Array<Comb> = emptyArray()
  private var combsR: Array<Comb> = emptyArray()
  private var allpassL: Array<Allpass> = emptyArray()
  private var allpassR: Array<Allpass> = emptyArray()
  /** Hay cola sonando (o estado que limpiar) aunque ya esté apagado. */
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
    mixStep = 1f / (format.sampleRate * 0.06f)
    mix = if (enabled) 1f else 0f
    dirty = false
    Log.d("ImpalaTuning", "Freeverb en la cadena: ${format.sampleRate} Hz, ${format.channelCount} canales, ${if (float) "float" else "16 bits"}, ${if (enabled) "activa" else "apagada"}")
  }

  override fun onReset() {
    combsL = emptyArray(); combsR = emptyArray(); allpassL = emptyArray(); allpassR = emptyArray()
    mix = 0f
    dirty = false
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val size = inputBuffer.remaining()
    if (size == 0) return
    val out = replaceOutputBuffer(size)
    val target = if (enabled) 1f else 0f
    if (target == 0f && mix == 0f && !dirty) {
      out.put(inputBuffer)
      out.flip()
      return
    }
    if (target == 0f && mix == 0f) {
      // Recién apagado: se limpia la cola para que al volver a encender no suene un resto viejo.
      combsL.forEach(Comb::clear); combsR.forEach(Comb::clear)
      allpassL.forEach(Allpass::clear); allpassR.forEach(Allpass::clear)
      dirty = false
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
      val l = read(inputBuffer)
      val r = if (stereo) read(inputBuffer) else l
      // Entrada mono a la sala, como Freeverb; el ruido mínimo evita números desnormalizados en silencio.
      val input = (l + r) * FIXED_GAIN + 1e-18f
      var outL = 0f
      var outR = 0f
      for (c in combsL) outL += c.process(input)
      for (c in combsR) outR += c.process(input)
      for (a in allpassL) outL = a.process(outL)
      for (a in allpassR) outR = a.process(outR)
      if (mix != target) mix = if (mix < target) minOf(target, mix + mixStep) else maxOf(target, mix - mixStep)
      val dry = 1f - mix * (1f - DRY)
      val wet = mix * WET
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

  private fun read(b: ByteBuffer): Float = if (float) b.float else b.short / 32768f

  private fun write(b: ByteBuffer, v: Float) {
    if (float) b.putFloat(v) else b.putShort((v * 32767f).coerceIn(-32768f, 32767f).toInt().toShort())
  }

  private class Comb(size: Int) {
    private val buf = FloatArray(maxOf(1, size))
    private var i = 0
    private var store = 0f
    fun process(x: Float): Float {
      val y = buf[i]
      store = y * DAMP2 + store * DAMP1
      buf[i] = x + store * FEEDBACK
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
    /** Tamaño de sala 0,92 en Freeverb (0,92 × 0,28 + 0,7): cola de ~6 s. */
    const val FEEDBACK = 0.9576f
    /** Amortiguación 0,2: agudos que se apagan poco (sala brillante). */
    const val DAMP1 = 0.08f
    const val DAMP2 = 1f - DAMP1
    /** Ganancia de la mezcla: seco al 80 %, la sala con ganancia 1 (≈ 40 % de la energía, bien audible). */
    const val DRY = 0.8f
    const val WET = 1.0f
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
