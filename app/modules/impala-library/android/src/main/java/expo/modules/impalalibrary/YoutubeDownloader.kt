package expo.modules.impalalibrary

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min

/** Lo que pide el JS: la URL del audio (m4a de YouTube, pedida desde este teléfono) y los datos de las etiquetas. */
data class YoutubeDownload(
  val jobId: String,
  val url: String,
  val userAgent: String?,
  val contentLength: Long?,
  /** "Artista - Título" (sin extensión). */
  val baseName: String,
  /** Carpeta relativa a la raíz del almacenamiento ("Music/Impala"), o ruta absoluta para un archivo privado. */
  val folder: String,
  /** Volumen de MediaStore donde se guarda (tarjeta SD…); null = memoria interna. Solo Android 10+. */
  val volume: String?,
  val tags: Mp4Tags,
  /** Carátulas candidatas, por preferencia: se usa la primera que se pueda descargar. */
  val coverUrls: List<String>,
)

class DownloadCancelled : Exception("Descarga cancelada")

/**
 * Descarga el audio de YouTube al teléfono, sin ffmpeg: el m4a de YouTube viene fragmentado (DASH), así que se
 * re-empaqueta con MediaExtractor + MediaMuxer (sin recodificar) en un MP4 normal, se le escriben las
 * etiquetas y la carátula (Mp4Tagger) y se guarda en la carpeta pública con MediaStore. Android lo indexa al
 * terminar y el ContentObserver del módulo avisa a la biblioteca.
 *
 * Una descarga a la vez (la cola la lleva el JS). Corre en su propio hilo: sigue aunque se cambie de pantalla,
 * pero no si Android mata la app.
 */
class YoutubeDownloader(
  private val context: Context,
  private val onProgress: (jobId: String, stage: String, progress: Double) -> Unit,
) {
  private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "impala-youtube").apply { isDaemon = true } }
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val active = AtomicReference<HttpURLConnection?>(null)

  fun cancel(jobId: String) {
    cancelled += jobId
    // Corta la lectura en curso en seguida en vez de esperar al siguiente bloque.
    active.get()?.let { runCatching { it.disconnect() } }
  }

  fun start(job: YoutubeDownload, resolve: (Map<String, Any?>) -> Unit, reject: (Exception) -> Unit) {
    executor.execute {
      val work = File(context.cacheDir, "yt-${job.jobId}").apply { mkdirs() }
      try {
        resolve(run(job, work))
      } catch (e: Exception) {
        reject(if (job.jobId in cancelled) DownloadCancelled() else e)
      } finally {
        cancelled -= job.jobId
        work.deleteRecursively()
      }
    }
  }

  private fun check(job: YoutubeDownload) {
    if (job.jobId in cancelled) throw DownloadCancelled()
  }

  private fun run(job: YoutubeDownload, work: File): Map<String, Any?> {
    val raw = File(work, "audio.mp4")
    fetchAudio(job, raw)
    check(job)
    onProgress(job.jobId, "processing", 1.0)
    val remuxed = File(work, "remux.m4a")
    remux(raw, remuxed, job)
    raw.delete()
    val cover = job.coverUrls.firstNotNullOfOrNull { runCatching { squareCover(get(it, job.userAgent)) }.getOrNull() }
    val tagged = File(work, "tagged.m4a")
    Mp4Tagger.write(remuxed, tagged, job.tags.copy(cover = cover))
    remuxed.delete()
    check(job)
    return store(tagged, job)
  }

  // --- 1. Descarga -----------------------------------------------------------------------------------

  private fun open(url: String, userAgent: String?): HttpURLConnection =
    (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = TIMEOUT_MS
      readTimeout = TIMEOUT_MS
      if (!userAgent.isNullOrBlank()) setRequestProperty("User-Agent", userAgent)
    }

  /**
   * Por tramos de 10 MB con el parámetro `range` (como yt-dlp): las peticiones del archivo entero las frena
   * YouTube a velocidad de reproducción.
   */
  private fun fetchAudio(job: YoutubeDownload, file: File) {
    FileOutputStream(file).use { out ->
      val buf = ByteArray(64 * 1024)
      var total = job.contentLength?.takeIf { it > 0 }
      var pos = 0L
      var lastReport = 0L
      while (true) {
        check(job)
        val end = total?.let { min(pos + CHUNK, it) - 1 }
        val sep = if ('?' in job.url) '&' else '?'
        val conn = open(if (end != null) "${job.url}${sep}range=$pos-$end" else job.url, job.userAgent)
        active.set(conn)
        try {
          val code = conn.responseCode
          if (code !in 200..299) throw Exception("YouTube respondió HTTP $code")
          if (total == null) total = conn.contentLengthLong.takeIf { it > 0 }
          val before = pos
          conn.inputStream.use { input ->
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              pos += n
              val now = System.currentTimeMillis()
              if (now - lastReport > PROGRESS_MS) {
                lastReport = now
                total?.let { onProgress(job.jobId, "downloading", pos.toDouble() / it) }
              }
            }
          }
          if (end == null) break
          if (pos == before) throw Exception("YouTube cortó la descarga")
          if (pos >= total!!) break
        } catch (e: Exception) {
          check(job)
          throw e
        } finally {
          active.set(null)
          conn.disconnect()
        }
      }
    }
  }

  private fun get(url: String, userAgent: String?): ByteArray {
    val conn = open(url, userAgent)
    try {
      if (conn.responseCode !in 200..299) throw Exception("HTTP ${conn.responseCode}")
      return conn.inputStream.use { it.readBytes() }
    } finally {
      conn.disconnect()
    }
  }

  // --- 2. Re-empaquetar ------------------------------------------------------------------------------

  private fun remux(src: File, dst: File, job: YoutubeDownload) {
    val extractor = MediaExtractor()
    var muxer: MediaMuxer? = null
    try {
      extractor.setDataSource(src.path)
      val track = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: throw Exception("El archivo de YouTube no trae audio")
      extractor.selectTrack(track)
      val format = extractor.getTrackFormat(track)
      if (format.getString(MediaFormat.KEY_MIME) != MediaFormat.MIMETYPE_AUDIO_AAC) {
        throw Exception("Formato de audio no compatible: ${format.getString(MediaFormat.KEY_MIME)}")
      }
      muxer = MediaMuxer(dst.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val out = muxer.addTrack(format)
      muxer.start()
      val size = if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
      val buffer = ByteBuffer.allocateDirect(max(size, 256 * 1024))
      val info = MediaCodec.BufferInfo()
      var samples = 0
      while (true) {
        val n = extractor.readSampleData(buffer, 0)
        if (n < 0) break
        info.set(0, n, extractor.sampleTime, if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        muxer.writeSampleData(out, buffer, info)
        extractor.advance()
        if (++samples % 2000 == 0) check(job)
      }
      if (samples == 0) throw Exception("El audio descargado está vacío")
      muxer.stop()
    } finally {
      runCatching { muxer?.release() }
      extractor.release()
    }
  }

  /** La miniatura recortada al centro en cuadrado (las de videos son 16:9 o 4:3) y como mucho de 1200 px. */
  private fun squareCover(bytes: ByteArray): ByteArray {
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw Exception("Carátula ilegible")
    val side = min(bitmap.width, bitmap.height)
    var square = Bitmap.createBitmap(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side)
    if (side > MAX_COVER) square = Bitmap.createScaledBitmap(square, MAX_COVER, MAX_COVER, true)
    return ByteArrayOutputStream().also { square.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
  }

  // --- 3. A la carpeta pública -----------------------------------------------------------------------

  private fun store(file: File, job: YoutubeDownload): Map<String, Any?> {
    val name = "${job.baseName}.m4a"
    val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension("m4a") ?: "audio/mp4"
    val resolver = context.contentResolver
    // Ruta absoluta (episodios de suscripciones): archivo privado de la app, fuera de la biblioteca y del
    // índice de Android; se borra sin pedir permiso cuando ya se escuchó.
    if (job.folder.startsWith("/")) {
      val dir = File(job.folder).apply { mkdirs() }
      val target = File(dir, name)
      file.copyTo(target, overwrite = true)
      return result(Uri.fromFile(target), target.name)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val values = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, name)
        put(MediaStore.Audio.Media.MIME_TYPE, mime)
        put(MediaStore.Audio.Media.RELATIVE_PATH, job.folder.trimEnd('/') + "/")
        put(MediaStore.Audio.Media.IS_PENDING, 1)
      }
      val volume = job.volume ?: MediaStore.VOLUME_EXTERNAL_PRIMARY
      if (volume !in MediaStore.getExternalVolumeNames(context)) {
        throw Exception("La tarjeta SD no está disponible. Insértala o elige otra carpeta de descargas en Ajustes.")
      }
      val uri = resolver.insert(MediaStore.Audio.Media.getContentUri(volume), values)
        ?: throw Exception("Android no dejó crear el archivo")
      try {
        resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } } ?: throw Exception("No se pudo escribir el archivo")
        resolver.update(uri, ContentValues().apply { put(MediaStore.Audio.Media.IS_PENDING, 0) }, null, null)
      } catch (e: Exception) {
        runCatching { resolver.delete(uri, null, null) }
        throw e
      }
      return result(uri, resolver.query(uri, arrayOf(MediaStore.Audio.Media.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: name)
    }
    // Android 9 o anterior: archivo directo (permiso de escritura) y escaneo para que entre en el índice.
    @Suppress("DEPRECATION")
    val dir = File(Environment.getExternalStorageDirectory(), job.folder).apply { mkdirs() }
    var target = File(dir, name)
    var i = 1
    while (target.exists()) target = File(dir, "${job.baseName} (${i++}).m4a")
    file.copyTo(target)
    val latch = CountDownLatch(1)
    var scanned: Uri? = null
    MediaScannerConnection.scanFile(context, arrayOf(target.path), arrayOf(mime)) { _, uri -> scanned = uri; latch.countDown() }
    latch.await(15, TimeUnit.SECONDS)
    return result(scanned ?: throw Exception("Android no indexó el archivo"), target.name)
  }

  private fun result(uri: Uri, fileName: String) = mapOf("id" to uri.lastPathSegment, "uri" to uri.toString(), "fileName" to fileName)

  companion object {
    private const val CHUNK = 10L * 1024 * 1024
    private const val TIMEOUT_MS = 20_000
    private const val PROGRESS_MS = 300L
    private const val MAX_COVER = 1200
  }
}
