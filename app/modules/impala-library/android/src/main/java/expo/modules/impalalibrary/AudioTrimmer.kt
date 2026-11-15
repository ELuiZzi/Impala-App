package expo.modules.impalalibrary

import android.content.ContentUris
import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.provider.MediaStore
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Lo que el editor de recortes necesita saber de un archivo. */
data class AudioProbe(
  val durationMs: Double,
  /** aac, mp3, flac, opus, vorbis, pcm, alac… (como lo llama ffprobe en el servidor). */
  val codec: String,
  /** mp4, mp3 u otro: decide cómo se corta. */
  val container: String,
  val suffix: String?,
  val size: Long,
  val modified: Long,
)

/**
 * Recortes de la música del teléfono, sin recodificar (como hace el servidor con ffmpeg `-c copy`):
 *
 * - **M4A/MP4 con AAC**: MediaExtractor lee las tramas de cada tramo conservado y MediaMuxer las escribe seguidas
 *   en un MP4 nuevo; luego se le pone la caja `udta` del original (etiquetas y carátula, tal cual).
 * - **MP3**: copia de tramas MPEG byte a byte (MediaMuxer no escribe MP3), conservando la cabecera ID3v2 y el ID3v1,
 *   y corrigiendo la trama Xing/Info (número de tramas, bytes y tabla de búsqueda).
 *
 * El corte cae en el límite de trama más cercano (~23-26 ms). FLAC, Opus, Vorbis y WAV no se recortan (ver
 * [canTrim]): habría que recodificarlos y en el teléfono se perdería la calidad o el formato.
 */
class AudioTrimmer(private val context: Context) {

  fun songUri(id: Long): Uri = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)

  fun probe(id: Long): AudioProbe {
    val uri = songUri(id)
    var name: String? = null
    var size = 0L
    var modified = 0L
    context.contentResolver.query(
      uri,
      arrayOf(MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.DATE_MODIFIED),
      null, null, null,
    )?.use { c ->
      if (!c.moveToFirst()) error("La canción ya no está en el teléfono")
      name = c.getString(0)
      size = c.getLong(1)
      modified = c.getLong(2)
    } ?: error("La canción ya no está en el teléfono")
    val suffix = name?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.isNotEmpty() }
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(context, uri, null)
      val format = audioTrack(extractor)?.let { extractor.getTrackFormat(it) } ?: error("No se pudo leer el audio del archivo")
      val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L
      if (durationUs <= 0) error("No se pudo leer la duración del archivo")
      val container = when (suffix) {
        "m4a", "mp4", "m4b" -> "mp4"
        "mp3" -> "mp3"
        else -> suffix ?: "?"
      }
      return AudioProbe(durationUs / 1000.0, codecOf(format.getString(MediaFormat.KEY_MIME)), container, suffix, size, modified)
    } finally {
      extractor.release()
    }
  }

  fun canTrim(p: AudioProbe) = (p.container == "mp4" && p.codec == "aac") || (p.container == "mp3" && p.codec == "mp3")

  // --- Forma de onda ---------------------------------------------------------------------------------

  /**
   * Picos de 0 a 1 (`points` tramos): se decodifica el audio con MediaCodec y se toma el máximo de cada tramo
   * (mirando una de cada pocas muestras: para dibujarla sobra). Se guarda en caché por id, tamaño y fecha.
   */
  fun waveform(id: Long, points: Int): List<Double> {
    val p = probe(id)
    val dir = File(context.cacheDir, "waveforms").apply { mkdirs() }
    val cache = File(dir, "$id-${p.size}-${p.modified}-$points.txt")
    if (cache.isFile) {
      runCatching { return cache.readText().split(',').map { it.toDouble() } }
    }
    val peaks = decodePeaks(songUri(id), (p.durationMs * 1000).toLong(), points)
    dir.listFiles()?.filter { it.name.startsWith("$id-") }?.forEach { it.delete() }
    runCatching { cache.writeText(peaks.joinToString(",")) }
    return peaks
  }

  private fun decodePeaks(uri: Uri, durationUs: Long, points: Int): List<Double> {
    val raw = DoubleArray(points)
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(context, uri, null)
      val track = audioTrack(extractor) ?: error("No se pudo leer el audio del archivo")
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      codec.configure(format, null, null, 0)
      codec.start()
      val info = MediaCodec.BufferInfo()
      var float = false
      var inputDone = false
      while (true) {
        if (!inputDone) {
          val i = codec.dequeueInputBuffer(10_000)
          if (i >= 0) {
            val buf = codec.getInputBuffer(i)!!
            val n = extractor.readSampleData(buf, 0)
            if (n < 0) {
              codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              codec.queueInputBuffer(i, 0, n, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        val o = codec.dequeueOutputBuffer(info, 10_000)
        if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val out = codec.outputFormat
          float = out.containsKey(MediaFormat.KEY_PCM_ENCODING) && out.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT
        } else if (o >= 0) {
          if (info.size > 0) {
            val buf = codec.getOutputBuffer(o)!!.apply { position(info.offset); limit(info.offset + info.size) }.order(ByteOrder.nativeOrder())
            var peak = 0.0
            if (float) {
              val f = buf.asFloatBuffer()
              var k = 0
              while (k < f.limit()) { peak = max(peak, abs(f.get(k).toDouble())); k += STRIDE }
            } else {
              val s = buf.asShortBuffer()
              var k = 0
              while (k < s.limit()) { peak = max(peak, abs(s.get(k).toInt()) / 32768.0); k += STRIDE }
            }
            val bucket = min(points - 1, max(0, (info.presentationTimeUs * points / max(1L, durationUs)).toInt()))
            raw[bucket] = max(raw[bucket], peak)
          }
          codec.releaseOutputBuffer(o, false)
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
        }
      }
    } finally {
      runCatching { codec?.stop() }
      runCatching { codec?.release() }
      extractor.release()
    }
    val top = raw.maxOrNull() ?: 0.0
    return raw.map { if (top > 0) (it / top * 1000).roundToInt() / 1000.0 else 0.0 }
  }

  // --- Recorte ---------------------------------------------------------------------------------------

  /**
   * Escribe en `output` la canción conservando solo `keep` (tramos en segundos, ordenados y sin solaparse).
   * Devuelve la duración del resultado en ms.
   */
  fun cut(id: Long, keep: List<Pair<Double, Double>>, output: File): Double {
    val p = probe(id)
    if (!canTrim(p)) error("No se pueden recortar archivos ${p.codec.uppercase()}")
    val source = File(context.cacheDir, "trim-source-${System.nanoTime()}.${p.suffix ?: "bin"}")
    try {
      copyUri(songUri(id), source)
      return if (p.container == "mp4") cutMp4(source, keep, output) else cutMp3(source, keep, output)
    } finally {
      source.delete()
    }
  }

  fun copyUri(uri: Uri, dst: File) {
    val input = context.contentResolver.openInputStream(uri) ?: error("No se pudo leer el archivo")
    input.use { i -> dst.outputStream().use { o -> i.copyTo(o, 256 * 1024) } }
  }

  private fun cutMp4(src: File, keep: List<Pair<Double, Double>>, output: File): Double {
    val muxed = File(output.path + ".mux")
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    var outUs = 0L
    try {
      extractor.setDataSource(src.path)
      val track = audioTrack(extractor) ?: error("No se pudo leer el audio del archivo")
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      val sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      val frameUs = 1024L * 1_000_000 / sampleRate
      muxer = MediaMuxer(muxed.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val out = muxer.addTrack(format)
      muxer.start()
      val size = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
      val buffer = ByteBuffer.allocateDirect(max(size, 256 * 1024))
      val info = MediaCodec.BufferInfo()
      var samples = 0
      for ((s, e) in keep) {
        val startUs = (s * 1_000_000).toLong()
        val endUs = (e * 1_000_000).toLong()
        // Todas las tramas AAC son de sincronía: se va a la que contiene el inicio y se avanza a la más cercana.
        extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
        while (extractor.sampleTime in 0 until startUs - frameUs / 2) if (!extractor.advance()) break
        var first = -1L
        var last = -1L
        while (true) {
          val t = extractor.sampleTime
          if (t < 0 || t + frameUs / 2 > endUs) break
          val n = extractor.readSampleData(buffer, 0)
          if (n < 0) break
          if (first < 0) first = t
          last = t
          info.set(0, n, outUs + (t - first), MediaCodec.BUFFER_FLAG_KEY_FRAME)
          muxer.writeSampleData(out, buffer, info)
          samples++
          if (!extractor.advance()) break
        }
        if (first >= 0) outUs += last - first + frameUs
      }
      if (samples == 0) error("El recorte quedó vacío")
      muxer.stop()
    } catch (e: Exception) {
      muxed.delete()
      throw e
    } finally {
      runCatching { muxer?.release() }
      extractor.release()
    }
    try {
      val udta = RandomAccessFile(src, "r").use { Mp4Tagger.readUdta(it) }
      if (udta != null) Mp4Tagger.writeUdta(muxed, output, udta) else check(muxed.renameTo(output)) { "No se pudo escribir el recorte" }
    } finally {
      muxed.delete()
    }
    return outUs / 1000.0
  }

  private class Mp3Frame(val offset: Int, val length: Int)

  private fun cutMp3(src: File, keep: List<Pair<Double, Double>>, output: File): Double {
    require(src.length() < MAX_MP3) { "Archivo MP3 demasiado grande" }
    val data = src.readBytes()
    var pos = 0
    // ID3v2 (etiquetas y carátula): se copia tal cual. Puede haber más de uno seguido.
    while (pos + 10 <= data.size && data[pos] == 'I'.code.toByte() && data[pos + 1] == 'D'.code.toByte() && data[pos + 2] == '3'.code.toByte()) {
      val tagSize = ((data[pos + 6].toInt() and 0x7f) shl 21) or ((data[pos + 7].toInt() and 0x7f) shl 14) or
        ((data[pos + 8].toInt() and 0x7f) shl 7) or (data[pos + 9].toInt() and 0x7f)
      pos += 10 + tagSize + if (data[pos + 5].toInt() and 0x10 != 0) 10 else 0
    }
    val id3v2End = min(pos, data.size)
    val tail = if (data.size >= 128 && data[data.size - 128] == 'T'.code.toByte() && data[data.size - 127] == 'A'.code.toByte() &&
      data[data.size - 126] == 'G'.code.toByte()) data.size - 128 else data.size

    // Tramas MPEG: cada cabecera dice su tamaño; se exige que la siguiente también lo sea para no tomar basura.
    val frames = mutableListOf<Mp3Frame>()
    var header: Mp3Header? = null
    pos = id3v2End
    while (pos + 4 <= tail) {
      val h = Mp3Header.parse(data, pos)
      if (h == null || pos + h.length > tail) { pos++; continue }
      if (frames.isEmpty()) {
        val next = Mp3Header.parse(data, pos + h.length)
        if (pos + h.length < tail && (next == null || next.sampleRate != h.sampleRate)) { pos++; continue }
        header = h
      }
      frames += Mp3Frame(pos, h.length)
      pos += h.length
    }
    val h = header ?: error("No se encontraron tramas MP3")
    // La primera trama puede ser Xing/Info o VBRI (sin audio): se rehace con los datos nuevos.
    val xingAt = h.offset(data, frames[0].offset)
    val vbri = frames[0].offset + 36 + 4 <= data.size && String(data, frames[0].offset + 36, 4, Charsets.ISO_8859_1) == "VBRI"
    val info = if (xingAt >= 0 || vbri) frames.removeAt(0) else null

    val frameS = h.samplesPerFrame.toDouble() / h.sampleRate
    val kept = frames.filterIndexed { i, _ ->
      val mid = (i + 0.5) * frameS
      keep.any { (s, e) -> mid >= s && mid < e }
    }
    if (kept.isEmpty()) error("El recorte quedó vacío")

    val xing = if (info != null && xingAt >= 0) data.copyOfRange(info.offset, info.offset + info.length) else null
    val audioBytes = kept.sumOf { it.length.toLong() }
    if (xing != null) fixXing(xing, xingAt - info!!.offset, kept, audioBytes + xing.size)

    output.outputStream().buffered(256 * 1024).use { o ->
      o.write(data, 0, id3v2End)
      if (xing != null) o.write(xing)
      for (f in kept) o.write(data, f.offset, f.length)
      if (tail < data.size) o.write(data, tail, data.size - tail)
    }
    return kept.size * frameS * 1000
  }

  /** Trama Xing/Info: número de tramas, bytes y la tabla de búsqueda (TOC) del archivo recortado. */
  private fun fixXing(frame: ByteArray, at: Int, kept: List<Mp3Frame>, totalBytes: Long) {
    val flags = readU32(frame, at + 4).toInt()
    var p = at + 8
    if (flags and 1 != 0) { writeU32(frame, p, kept.size.toLong()); p += 4 }
    if (flags and 2 != 0) { writeU32(frame, p, totalBytes); p += 4 }
    if (flags and 4 != 0 && p + 100 <= frame.size) {
      var offset = frame.size.toLong()
      val starts = LongArray(kept.size).also { for (i in kept.indices) { it[i] = offset; offset += kept[i].length } }
      for (i in 0 until 100) {
        val f = min(kept.size - 1, (i / 100.0 * kept.size).toInt())
        frame[p + i] = min(255L, starts[f] * 256 / totalBytes).toByte()
      }
    }
  }

  private class Mp3Header(val mpeg1: Boolean, val mono: Boolean, val crc: Boolean, val sampleRate: Int, val length: Int) {
    val samplesPerFrame get() = if (mpeg1) 1152 else 576

    /** Dónde empieza la etiqueta "Xing"/"Info" en esta trama, o -1. */
    fun offset(data: ByteArray, frame: Int): Int {
      val side = if (mpeg1) (if (mono) 17 else 32) else (if (mono) 9 else 17)
      val at = frame + 4 + (if (crc) 2 else 0) + side
      if (at + 8 > data.size) return -1
      val tag = String(data, at, 4, Charsets.ISO_8859_1)
      return if (tag == "Xing" || tag == "Info") at else -1
    }

    companion object {
      private val BITRATE_V1 = intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
      private val BITRATE_V2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
      private val RATES = intArrayOf(44100, 48000, 32000)

      /** Solo MPEG capa III (lo que es un .mp3). */
      fun parse(d: ByteArray, at: Int): Mp3Header? {
        if (at + 4 > d.size) return null
        val b1 = d[at + 1].toInt() and 0xff
        val b2 = d[at + 2].toInt() and 0xff
        val b3 = d[at + 3].toInt() and 0xff
        if ((d[at].toInt() and 0xff) != 0xff || (b1 and 0xe0) != 0xe0) return null
        val version = (b1 shr 3) and 3 // 0: 2.5, 2: 2, 3: 1
        if (version == 1 || ((b1 shr 1) and 3) != 1) return null
        val bitrateIdx = b2 shr 4
        val rateIdx = (b2 shr 2) and 3
        if (bitrateIdx == 0 || bitrateIdx == 15 || rateIdx == 3) return null
        val mpeg1 = version == 3
        val rate = RATES[rateIdx] / (if (mpeg1) 1 else if (version == 2) 2 else 4)
        val bitrate = (if (mpeg1) BITRATE_V1 else BITRATE_V2)[bitrateIdx] * 1000
        val padding = (b2 shr 1) and 1
        val length = (if (mpeg1) 144 else 72) * bitrate / rate + padding
        return Mp3Header(mpeg1, (b3 shr 6) == 3, (b1 and 1) == 0, rate, length)
      }
    }
  }

  private fun audioTrack(e: MediaExtractor) =
    (0 until e.trackCount).firstOrNull { e.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true }

  private fun codecOf(mime: String?) = when (mime) {
    MediaFormat.MIMETYPE_AUDIO_AAC -> "aac"
    MediaFormat.MIMETYPE_AUDIO_MPEG -> "mp3"
    MediaFormat.MIMETYPE_AUDIO_FLAC -> "flac"
    MediaFormat.MIMETYPE_AUDIO_OPUS -> "opus"
    MediaFormat.MIMETYPE_AUDIO_VORBIS -> "vorbis"
    MediaFormat.MIMETYPE_AUDIO_RAW -> "pcm"
    "audio/alac" -> "alac"
    else -> mime?.removePrefix("audio/") ?: "?"
  }

  private fun readU32(b: ByteArray, at: Int): Long =
    ((b[at].toLong() and 0xff) shl 24) or ((b[at + 1].toLong() and 0xff) shl 16) or ((b[at + 2].toLong() and 0xff) shl 8) or (b[at + 3].toLong() and 0xff)

  private fun writeU32(b: ByteArray, at: Int, v: Long) {
    b[at] = (v shr 24).toByte(); b[at + 1] = (v shr 16).toByte(); b[at + 2] = (v shr 8).toByte(); b[at + 3] = v.toByte()
  }

  companion object {
    private const val STRIDE = 4
    private const val MAX_MP3 = 300L * 1024 * 1024
  }
}
