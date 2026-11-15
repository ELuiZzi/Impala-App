package expo.modules.impalalibrary

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** FileProvider propio (con su autoridad) para pasarle el APK descargado al instalador del sistema. */
class ImpalaUpdateFileProvider : FileProvider()

/**
 * Actualizaciones de la app desde GitHub Releases: el JS decide si hay versión nueva; aquí se descarga el APK a la
 * caché (cache/updates/) y se abre el instalador de Android, que siempre pide confirmación al usuario. Android solo
 * lo instala encima si está firmado con la misma llave que la app instalada.
 */
internal class AppUpdater(private val context: Context, private val onProgress: (Double) -> Unit) {
  private val worker = Executors.newSingleThreadExecutor()
  @Volatile private var cancelled = false

  fun versionInfo(): Map<String, Any> {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    return mapOf("versionName" to (info.versionName ?: ""), "versionCode" to code.toDouble())
  }

  /**
   * Para probar sin publicar: si existe Android/data/<paquete>/files/update-test.json (solo se puede poner con adb),
   * su contenido sustituye a la respuesta de GitHub. Las demás apps no pueden escribir ahí.
   */
  fun testOverride(): String? = context.getExternalFilesDir(null)?.let { File(it, "update-test.json") }?.takeIf { it.isFile }?.readText()

  /** Descarga a cache/updates/<fileName>; comprueba el tamaño esperado. Resuelve la ruta del archivo. */
  fun download(url: String, fileName: String, expectedSize: Long, done: (String) -> Unit, fail: (Exception) -> Unit) {
    cancelled = false
    worker.execute {
      val dir = File(context.cacheDir, "updates").apply { mkdirs() }
      dir.listFiles()?.forEach { it.delete() } // APKs de otras versiones
      val target = File(dir, fileName.replace(Regex("[^A-Za-z0-9._-]"), "_"))
      val partial = File(dir, "${target.name}.part")
      try {
        val connection = URL(url).openConnection()
        if (connection is HttpURLConnection) {
          connection.instanceFollowRedirects = true
          connection.connectTimeout = 15_000
          connection.readTimeout = 30_000
          connection.setRequestProperty("Accept", "application/octet-stream")
          if (connection.responseCode !in 200..299) throw Exception("El servidor respondió ${connection.responseCode}")
        }
        val total = connection.contentLengthLong.takeIf { it > 0 } ?: expectedSize
        var read = 0L
        var lastReported = -1.0
        connection.getInputStream().use { input ->
          partial.outputStream().use { output ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              if (cancelled) throw DownloadCancelled()
              val n = input.read(buffer)
              if (n < 0) break
              output.write(buffer, 0, n)
              read += n
              if (total > 0) {
                val progress = read.toDouble() / total
                if (progress - lastReported >= 0.01) {
                  lastReported = progress
                  onProgress(progress.coerceAtMost(1.0))
                }
              }
            }
          }
        }
        if (expectedSize > 0 && read != expectedSize) throw Exception("La descarga quedó incompleta ($read de $expectedSize bytes)")
        if (!partial.renameTo(target)) throw Exception("No se pudo guardar el APK")
        onProgress(1.0)
        done(target.absolutePath)
      } catch (e: Exception) {
        partial.delete()
        fail(e)
      }
    }
  }

  fun cancel() {
    cancelled = true
  }

  /** Si Android deja que Impala abra el instalador (Android 8+: «Instalar apps desconocidas» de Impala). */
  fun canInstall(): Boolean = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

  /** Abre el ajuste «Instalar apps desconocidas» de Impala. */
  fun openInstallSettings() {
    val intent = if (Build.VERSION.SDK_INT >= 26) {
      Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
    } else {
      Intent(Settings.ACTION_SECURITY_SETTINGS)
    }
    context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  /** Abre el instalador del sistema con el APK (content:// del FileProvider, con permiso de lectura). */
  fun install(path: String) {
    val file = File(path.removePrefix("file://"))
    if (!file.isFile) throw Exception("No se encontró el APK descargado")
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.impala.updates", file)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  fun shutdown() = worker.shutdown()
}
