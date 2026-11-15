package expo.modules.impalalibrary

import android.app.Activity
import android.app.RecoverableSecurityException
import android.content.ContentUris
import android.content.Context
import android.database.ContentObserver
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * La música del teléfono, tal como la indexa Android (MediaStore.Audio). No lee los archivos: el
 * sistema ya extrae título, artista, álbum, duración y carátula al escanearlos.
 *
 * Las carpetas son rutas relativas a la raíz del almacenamiento ("Music/Impala/") e incluyen sus
 * subcarpetas. Cuando el índice cambia (archivos copiados, borrados o escaneados) se avisa al JS.
 */
class ImpalaLibraryModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var observer: ContentObserver? = null

  /** Un escaneo genera decenas de avisos seguidos: se agrupan en uno. */
  private val notifyChange = Runnable { sendEvent(EVENT_CHANGE, Bundle.EMPTY) }

  /** Borrado esperando la confirmación del sistema (solo uno a la vez). */
  private var pendingDelete: Pair<Long, Promise>? = null

  /** Escritura esperando el permiso del sistema (Android 11+, archivos de otras apps). */
  private var pendingWrite: Triple<Long, File, Promise>? = null

  /** Recortes y formas de onda: tardan segundos, van en su propio hilo para no frenar al resto del módulo. */
  private val worker = Executors.newSingleThreadExecutor()
  private val trimmer by lazy { AudioTrimmer(context) }

  private fun background(promise: Promise, code: String, work: () -> Any?) = worker.execute {
    try {
      promise.resolve(work())
    } catch (e: Exception) {
      promise.reject(CodedException(code, e.message ?: "Error al procesar el audio", e))
    }
  }

  private val downloader by lazy {
    YoutubeDownloader(context) { jobId, stage, progress ->
      sendEvent(EVENT_DOWNLOAD, Bundle().apply {
        putString("jobId", jobId)
        putString("stage", stage)
        putDouble("progress", progress)
      })
    }
  }

  private val updater by lazy {
    AppUpdater(context) { progress -> sendEvent(EVENT_UPDATE, Bundle().apply { putDouble("progress", progress) }) }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "Contexto de Android no disponible", null)

  override fun definition() = ModuleDefinition {
    Name("ImpalaLibrary")
    Events(EVENT_CHANGE, EVENT_DOWNLOAD, EVENT_UPDATE)

    OnStartObserving(EVENT_CHANGE) { startObserving() }
    OnStopObserving(EVENT_CHANGE) { stopObserving() }
    OnDestroy {
      stopObserving()
      worker.shutdown()
      updater.cancel()
      updater.shutdown()
    }

    // Actualizaciones desde GitHub Releases (AppUpdater.kt).
    Function("getAppVersion") { updater.versionInfo() }
    Function("readUpdateOverride") { updater.testOverride() }
    Function("canInstallPackages") { updater.canInstall() }
    Function("openInstallSettings") { updater.openInstallSettings() }
    Function("cancelUpdateDownload") { updater.cancel() }
    AsyncFunction("downloadUpdate") { url: String, fileName: String, size: Double, promise: Promise ->
      updater.download(url, fileName, size.toLong(), { promise.resolve(it) }) { e ->
        if (e is DownloadCancelled) promise.reject(CodedException("ERR_CANCELLED", "Descarga cancelada", null))
        else promise.reject(CodedException("ERR_DOWNLOAD", e.message ?: "No se pudo descargar", e))
      }
    }
    AsyncFunction("installUpdate") { path: String ->
      try {
        updater.install(path)
      } catch (e: Exception) {
        throw CodedException("ERR_INSTALL", e.message ?: "No se pudo abrir el instalador", e)
      }
    }

    /** Las canciones de esas carpetas (y sus subcarpetas). Requiere el permiso de leer música. */
    AsyncFunction("getSongs") { folders: List<String> -> querySongs(folders) }

    /** Todas las carpetas que contienen audio, con cuántas canciones hay directamente en cada una. */
    AsyncFunction("getFolders") { queryFolders() }

    /** El .lrc con el mismo nombre que el audio, en su carpeta; null si no hay o no se puede leer. */
    AsyncFunction("readSidecarLyrics") { id: String -> readSidecar(id.toLong()) }

    /**
     * Borra la canción del teléfono. Android 11+ pide confirmación con su propio diálogo; en Android 10, si el
     * archivo es de otra app, también. Resuelve true si se borró y false si el usuario canceló.
     */
    AsyncFunction("deleteSong") { id: String, promise: Promise -> deleteSong(id.toLong(), promise) }

    /** Duración, códec y contenedor del archivo, y si se puede recortar sin recodificar. */
    AsyncFunction("probeAudio") { id: String, promise: Promise ->
      background(promise, "ERR_PROBE") {
        val p = trimmer.probe(id.toLong())
        mapOf(
          "durationMs" to p.durationMs, "codec" to p.codec, "container" to p.container, "suffix" to p.suffix,
          "size" to p.size.toDouble(), "modified" to p.modified.toDouble(), "canTrim" to trimmer.canTrim(p),
        )
      }
    }

    /** Picos de la forma de onda (0 a 1), decodificando el audio en el teléfono. */
    AsyncFunction("waveform") { id: String, points: Int, promise: Promise ->
      background(promise, "ERR_WAVEFORM") { trimmer.waveform(id.toLong(), points.coerceIn(10, 2000)) }
    }

    /** Escribe en `output` la canción con solo los tramos `keep` ([[inicio, fin]] en s). Devuelve la duración en ms. */
    AsyncFunction("trimToFile") { id: String, keep: List<List<Double>>, output: String, promise: Promise ->
      background(promise, "ERR_TRIM") { trimmer.cut(id.toLong(), keep.map { it[0] to it[1] }, fileOf(output)) }
    }

    /** Copia el archivo de la canción a `output` (la copia del original antes del primer recorte). */
    AsyncFunction("copySong") { id: String, output: String, promise: Promise ->
      background(promise, "ERR_COPY") { trimmer.copyUri(songUri(id.toLong()), fileOf(output)); null }
    }

    /**
     * Sustituye el contenido de la canción por el de `input` (mismo formato). Si el archivo es de otra app,
     * Android 11+ pide permiso con su diálogo: resuelve false si el usuario no lo dio.
     */
    AsyncFunction("overwriteSong") { id: String, input: String, promise: Promise -> overwrite(id.toLong(), fileOf(input), promise) }

    OnActivityResult { _, payload ->
      if (payload.requestCode == WRITE_REQUEST) {
        val (id, file, promise) = pendingWrite ?: return@OnActivityResult
        pendingWrite = null
        if (payload.resultCode != Activity.RESULT_OK) return@OnActivityResult promise.resolve(false)
        background(promise, "ERR_WRITE") { writeSong(id, file); true }
        return@OnActivityResult
      }
      if (payload.requestCode != DELETE_REQUEST) return@OnActivityResult
      val (id, promise) = pendingDelete ?: return@OnActivityResult
      pendingDelete = null
      if (payload.resultCode != Activity.RESULT_OK) return@OnActivityResult promise.resolve(false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        promise.resolve(true) // el sistema ya lo borró
      } else {
        // Android 10: el usuario dio permiso sobre el archivo; ahora sí se puede borrar.
        try {
          promise.resolve(context.contentResolver.delete(songUri(id), null, null) > 0)
        } catch (e: Exception) {
          promise.reject(CodedException("ERR_DELETE", e.message ?: "No se pudo borrar el archivo", e))
        }
      }
    }

    /**
     * Descarga un audio de YouTube (m4a) a la carpeta pública con etiquetas y carátula. Avisa del progreso con
     * onDownload; resuelve { id, uri, fileName } o rechaza (ERR_CANCELLED si se canceló).
     */
    AsyncFunction("downloadYoutube") { options: Map<String, Any?>, promise: Promise ->
      val job = try {
        youtubeJob(options)
      } catch (e: Exception) {
        return@AsyncFunction promise.reject(CodedException("ERR_ARGS", e.message ?: "Datos de descarga inválidos", e))
      }
      downloader.start(job, { promise.resolve(it) }) { e ->
        if (e is DownloadCancelled) promise.reject(CodedException("ERR_CANCELLED", "Descarga cancelada", null))
        else promise.reject(CodedException("ERR_DOWNLOAD", e.message ?: "No se pudo descargar", e))
      }
    }

    /** Cancela la descarga de YouTube en curso con ese id (si ya terminó, no hace nada). */
    Function("cancelDownload") { jobId: String -> downloader.cancel(jobId) }

    /** Crea la carpeta si no existe (p. ej. Music/Impala la primera vez). Devuelve si existe al terminar. */
    Function("ensureFolder") { relativePath: String ->
      try {
        val dir = File(storageRoot(), relativePath)
        dir.isDirectory || dir.mkdirs()
      } catch (_: SecurityException) {
        false
      }
    }
  }

  private fun youtubeJob(o: Map<String, Any?>): YoutubeDownload {
    fun str(key: String) = (o[key] as? String)?.takeIf { it.isNotBlank() }
    fun int(key: String) = (o[key] as? Number)?.toInt()?.takeIf { it > 0 }
    return YoutubeDownload(
      jobId = str("jobId") ?: error("Falta jobId"),
      url = str("url") ?: error("Falta la URL del audio"),
      userAgent = str("userAgent"),
      contentLength = (o["contentLength"] as? Number)?.toLong(),
      baseName = str("baseName") ?: error("Falta el nombre del archivo"),
      folder = str("folder") ?: "Music/Impala",
      tags = Mp4Tags(str("title"), str("artist"), str("album"), str("albumArtist"), int("track"), int("year"), null),
      coverUrls = (o["coverUrls"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
    )
  }

  private fun fileOf(path: String) = File(if (path.startsWith("file:")) Uri.parse(path).path!! else path)

  private fun overwrite(id: Long, file: File, promise: Promise) = worker.execute {
    try {
      writeSong(id, file)
      promise.resolve(true)
    } catch (e: SecurityException) {
      // Sin permiso sobre el archivo (no lo creó Impala): Android abre su diálogo antes de tocar nada.
      val activity = appContext.currentActivity
      val sender = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> MediaStore.createWriteRequest(context.contentResolver, listOf(songUri(id))).intentSender
        Build.VERSION.SDK_INT == Build.VERSION_CODES.Q && e is RecoverableSecurityException -> e.userAction.actionIntent.intentSender
        else -> null
      }
      if (activity == null || sender == null || pendingWrite != null) {
        return@execute promise.reject(CodedException("ERR_WRITE", "Android no deja modificar este archivo", e))
      }
      pendingWrite = Triple(id, file, promise)
      main.post {
        try {
          activity.startIntentSenderForResult(sender, WRITE_REQUEST, null, 0, 0, 0)
        } catch (err: Exception) {
          pendingWrite = null
          promise.reject(CodedException("ERR_WRITE", err.message ?: "No se pudo pedir permiso", err))
        }
      }
    } catch (e: Exception) {
      promise.reject(CodedException("ERR_WRITE", e.message ?: "No se pudo escribir el archivo", e))
    }
  }

  /** Escribe encima ("wt" vacía el archivo antes) y espera a que Android lo vuelva a indexar (duración nueva). */
  @Suppress("DEPRECATION")
  private fun writeSong(id: Long, file: File) {
    val uri = songUri(id)
    val out = context.contentResolver.openOutputStream(uri, "wt") ?: error("No se pudo abrir el archivo para escribir")
    out.use { o -> file.inputStream().use { it.copyTo(o, 256 * 1024) } }
    val path = context.contentResolver.query(uri, arrayOf(MediaStore.Audio.Media.DATA), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    } ?: return
    val done = CountDownLatch(1)
    MediaScannerConnection.scanFile(context, arrayOf(path), null) { _, _ -> done.countDown() }
    done.await(SCAN_TIMEOUT_S, TimeUnit.SECONDS)
  }

  private fun songUri(id: Long) = ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id)

  @Suppress("DEPRECATION")
  private fun readSidecar(id: Long): String? {
    val path = context.contentResolver.query(songUri(id), arrayOf(MediaStore.Audio.Media.DATA), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    } ?: return null
    val audio = File(path)
    val base = audio.nameWithoutExtension
    val dir = audio.parentFile ?: return null
    return try {
      val lrc = File(dir, "$base.lrc").takeIf { it.isFile }
        ?: dir.listFiles()?.firstOrNull { it.isFile && it.name.equals("$base.lrc", ignoreCase = true) }
      lrc?.takeIf { it.length() < MAX_LRC_BYTES }?.readText()
    } catch (_: Exception) {
      null // sin permiso para leer archivos que no son audio (Android 11+ con almacenamiento acotado)
    }
  }

  private fun deleteSong(id: Long, promise: Promise) {
    if (pendingDelete != null) {
      return promise.reject(CodedException("ERR_BUSY", "Ya hay un borrado esperando confirmación", null))
    }
    val activity = appContext.currentActivity
      ?: return promise.reject(CodedException("ERR_NO_ACTIVITY", "La app no está en primer plano", null))
    val uri = songUri(id)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val request = MediaStore.createDeleteRequest(context.contentResolver, listOf(uri))
        pendingDelete = id to promise
        activity.startIntentSenderForResult(request.intentSender, DELETE_REQUEST, null, 0, 0, 0)
        return
      }
      promise.resolve(context.contentResolver.delete(uri, null, null) > 0)
    } catch (e: SecurityException) {
      if (Build.VERSION.SDK_INT == Build.VERSION_CODES.Q && e is RecoverableSecurityException) {
        pendingDelete = id to promise
        activity.startIntentSenderForResult(e.userAction.actionIntent.intentSender, DELETE_REQUEST, null, 0, 0, 0)
      } else {
        pendingDelete = null
        promise.reject(CodedException("ERR_DELETE", "Android no deja borrar este archivo", e))
      }
    } catch (e: Exception) {
      pendingDelete = null
      promise.reject(CodedException("ERR_DELETE", e.message ?: "No se pudo borrar el archivo", e))
    }
  }

  private fun startObserving() {
    if (observer != null) return
    val o = object : ContentObserver(main) {
      override fun onChange(selfChange: Boolean) {
        main.removeCallbacks(notifyChange)
        main.postDelayed(notifyChange, CHANGE_DEBOUNCE_MS)
      }
    }
    context.contentResolver.registerContentObserver(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, true, o)
    observer = o
  }

  private fun stopObserving() {
    observer?.let { appContext.reactContext?.contentResolver?.unregisterContentObserver(it) }
    observer = null
    main.removeCallbacks(notifyChange)
  }

  @Suppress("DEPRECATION")
  private fun storageRoot(): File = Environment.getExternalStorageDirectory()

  /** Android 10+ guarda la ruta relativa; antes solo la absoluta (_data), de la que se deduce. */
  private val hasRelativePath = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

  @Suppress("DEPRECATION")
  private val pathColumn = if (hasRelativePath) MediaStore.Audio.Media.RELATIVE_PATH else MediaStore.Audio.Media.DATA

  /** "Music/Impala/" a partir de la columna de ruta (en la API < 29, de la ruta absoluta del archivo). */
  private fun relativePathOf(value: String?): String? {
    if (value == null) return null
    if (hasRelativePath) return value
    val root = storageRoot().absolutePath.trimEnd('/') + "/"
    if (!value.startsWith(root)) return null
    return value.removePrefix(root).substringBeforeLast('/', "").let { if (it.isEmpty()) "" else "$it/" }
  }

  private fun querySongs(folders: List<String>): List<Map<String, Any?>> {
    val prefixes = folders.map { it.trim('/') }.filter { it.isNotEmpty() }.distinct()
    if (prefixes.isEmpty()) return emptyList()

    // LIKE no distingue mayúsculas (como el almacenamiento de Android); se escapan % y _ de los nombres.
    val root = storageRoot().absolutePath.trimEnd('/')
    val selection = prefixes.joinToString(" OR ", "(", ")") { "$pathColumn LIKE ? ESCAPE '\\'" }
    val args = prefixes.map { (if (hasRelativePath) "" else "$root/") + escapeLike(it) + "/%" }.toTypedArray()

    val albumArtistColumn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) MediaStore.Audio.Media.ALBUM_ARTIST else null
    val bitrateColumn = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) MediaStore.Audio.Media.BITRATE else null
    val projection = listOfNotNull(
      MediaStore.Audio.Media._ID,
      MediaStore.Audio.Media.TITLE,
      MediaStore.Audio.Media.ARTIST,
      MediaStore.Audio.Media.ARTIST_ID,
      MediaStore.Audio.Media.ALBUM,
      MediaStore.Audio.Media.ALBUM_ID,
      MediaStore.Audio.Media.TRACK,
      MediaStore.Audio.Media.YEAR,
      MediaStore.Audio.Media.DURATION,
      MediaStore.Audio.Media.DATE_ADDED,
      MediaStore.Audio.Media.MIME_TYPE,
      MediaStore.Audio.Media.DISPLAY_NAME,
      MediaStore.Audio.Media.SIZE,
      pathColumn,
      albumArtistColumn,
      bitrateColumn,
    ).toTypedArray()

    val songs = mutableListOf<Map<String, Any?>>()
    context.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection, selection, args, null)?.use { c ->
      val col = projection.associateWith { c.getColumnIndexOrThrow(it) }
      fun str(name: String) = c.getString(col.getValue(name))
      fun long(name: String) = if (c.isNull(col.getValue(name))) null else c.getLong(col.getValue(name))

      while (c.moveToNext()) {
        val id = c.getLong(col.getValue(MediaStore.Audio.Media._ID))
        val displayName = str(MediaStore.Audio.Media.DISPLAY_NAME)
        // TRACK lleva el disco en los millares (2005 = disco 2, pista 5).
        val track = long(MediaStore.Audio.Media.TRACK)?.toInt()?.takeIf { it > 0 }
        songs += mapOf(
          "id" to id.toString(),
          "uri" to ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id).toString(),
          "title" to (str(MediaStore.Audio.Media.TITLE)?.takeIf { it.isNotBlank() } ?: displayName?.substringBeforeLast('.')),
          "artist" to known(str(MediaStore.Audio.Media.ARTIST)),
          "artistId" to long(MediaStore.Audio.Media.ARTIST_ID)?.toString(),
          "albumArtist" to albumArtistColumn?.let { known(str(it)) },
          "album" to known(str(MediaStore.Audio.Media.ALBUM)),
          "albumId" to long(MediaStore.Audio.Media.ALBUM_ID)?.toString(),
          "track" to track?.rem(1000)?.takeIf { it > 0 },
          "disc" to track?.div(1000)?.takeIf { it > 0 },
          "year" to long(MediaStore.Audio.Media.YEAR)?.toInt()?.takeIf { it > 0 },
          "durationMs" to (long(MediaStore.Audio.Media.DURATION) ?: 0L).toDouble(),
          "dateAdded" to (long(MediaStore.Audio.Media.DATE_ADDED) ?: 0L).toDouble(),
          "mimeType" to str(MediaStore.Audio.Media.MIME_TYPE),
          "suffix" to displayName?.substringAfterLast('.', "")?.lowercase()?.takeIf { it.isNotEmpty() },
          "size" to (long(MediaStore.Audio.Media.SIZE) ?: 0L).toDouble(),
          "bitRate" to bitrateColumn?.let { long(it) }?.takeIf { it > 0 }?.let { (it / 1000).toInt() },
          "folder" to relativePathOf(str(pathColumn)),
        )
      }
    } ?: throw CodedException("ERR_QUERY", "No se pudo leer la música del teléfono", null)
    return songs
  }

  private fun queryFolders(): List<Map<String, Any>> {
    val counts = mutableMapOf<String, Int>()
    context.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, arrayOf(pathColumn), null, null, null)?.use { c ->
      while (c.moveToNext()) {
        val path = relativePathOf(c.getString(0)) ?: continue
        counts[path] = (counts[path] ?: 0) + 1
      }
    } ?: throw CodedException("ERR_QUERY", "No se pudo leer la música del teléfono", null)
    return counts.map { (path, count) -> mapOf("path" to path, "count" to count) }
  }

  private fun escapeLike(text: String) = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

  /** MediaStore pone "<unknown>" cuando el archivo no trae el dato. */
  private fun known(value: String?) = value?.takeIf { it.isNotBlank() && it != MediaStore.UNKNOWN_STRING }

  companion object {
    const val EVENT_CHANGE = "onChange"
    const val EVENT_DOWNLOAD = "onDownload"
    const val EVENT_UPDATE = "onUpdateDownload"
    private const val CHANGE_DEBOUNCE_MS = 1500L
    private const val DELETE_REQUEST = 0x1A9A
    private const val WRITE_REQUEST = 0x1A9B
    private const val SCAN_TIMEOUT_S = 10L
    private const val MAX_LRC_BYTES = 512 * 1024L
  }
}
