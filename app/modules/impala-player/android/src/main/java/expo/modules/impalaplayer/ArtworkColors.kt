package expo.modules.impalaplayer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.palette.graphics.Palette
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Colores de una carátula para el fondo animado del reproductor (como Apple Music). Se descarga una
 * versión pequeña, se analiza con Palette y se devuelven hasta 5 colores distintos en #rrggbb:
 * primero los vivos y oscuros, que lucen bien de fondo con texto blanco encima.
 * Se llama desde un hilo en segundo plano (AsyncFunction).
 */
internal object ArtworkColors {
  private const val SAMPLE_PX = 160
  private const val TIMEOUT_MS = 10_000
  private val cache = LruCache<String, List<String>>(80)

  fun get(context: Context, url: String): List<String> {
    cache.get(url)?.let { return it }
    val bitmap = load(context, url) ?: return emptyList()
    val palette = Palette.from(bitmap).maximumColorCount(16).generate()
    bitmap.recycle()
    val swatches = listOfNotNull(
      palette.darkVibrantSwatch,
      palette.vibrantSwatch,
      palette.dominantSwatch,
      palette.darkMutedSwatch,
      palette.mutedSwatch,
      palette.lightVibrantSwatch,
      palette.lightMutedSwatch,
    ) + palette.swatches.sortedByDescending { it.population }
    val colors = swatches.map { "#%06X".format(0xFFFFFF and it.rgb) }.distinct().take(5)
    cache.put(url, colors)
    return colors
  }

  private fun load(context: Context, url: String): Bitmap? = try {
    // Primero solo las dimensiones, para decodificar reducida (una carátula puede medir 3000 px).
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open(context, url)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= SAMPLE_PX && bounds.outHeight / (sample * 2) >= SAMPLE_PX) sample *= 2
    open(context, url)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
  } catch (e: Exception) {
    null
  }

  private fun open(context: Context, url: String): InputStream? {
    val uri = Uri.parse(url)
    return when (uri.scheme) {
      "http", "https" -> (URL(url).openConnection() as HttpURLConnection).run {
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        if (responseCode !in 200..299) {
          disconnect()
          null
        } else inputStream
      }
      else -> context.contentResolver.openInputStream(uri)
    }
  }
}
