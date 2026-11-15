package expo.modules.impalaplayer

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.CacheDataSink
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File

/**
 * Caché en disco de lo que se descarga del servidor, compartida por el reproductor principal y el
 * fader del crossfade.
 *
 * Sin ella, en el relevo del crossfade el principal tenía que volver a pedir por red la canción que el
 * fader ya estaba sonando y buscar en ella (en FLAC, varias peticiones): tardaba cientos de ms y cada
 * resincronización volvía a desfasarse, así que al cruzar los volúmenes se oía un salto atrás. Con la
 * caché, el principal lee del disco el tramo que el fader ya bajó, igual de rápido que un archivo local.
 *
 * Solo envuelve http(s): los archivos locales (file://, content://) los sigue leyendo DefaultDataSource
 * directamente. Y solo guarda los archivos originales (`format=raw`): un flujo transcodificado (ahorro de
 * datos) anuncia una longitud estimada que no coincide con la real, y guardarla puede hacer fallar con EOF la
 * búsqueda del final del Ogg. Se vacía al crear el servicio, para que nunca sirva una versión vieja.
 */
@OptIn(UnstableApi::class)
internal object StreamCache {
  private const val MAX_BYTES = 300L * 1024 * 1024
  /** Fragmentos pequeños: lo que el fader descargó queda legible para el principal casi al momento. */
  private const val FRAGMENT_BYTES = 512L * 1024

  private var cache: SimpleCache? = null

  @Synchronized
  fun dataSourceFactory(context: Context, upstream: DataSource.Factory): DataSource.Factory {
    val c = cache ?: create(context.applicationContext).also { cache = it }
    val cached = CacheDataSource.Factory()
      .setCache(c)
      .setUpstreamDataSourceFactory(upstream)
      .setCacheWriteDataSinkFactory(CacheDataSink.Factory().setCache(c).setFragmentSize(FRAGMENT_BYTES))
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    return DataSource.Factory { RawOnly(cached.createDataSource(), upstream.createDataSource()) }
  }

  /** Abre con la caché los originales del servidor y sin ella todo lo demás. */
  private class RawOnly(private val cached: DataSource, private val plain: DataSource) : DataSource {
    private var current: DataSource? = null

    override fun addTransferListener(transferListener: TransferListener) {
      cached.addTransferListener(transferListener)
      plain.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
      val source = if (dataSpec.uri.getQueryParameter("format") == "raw") cached else plain
      current = source
      return source.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
      checkNotNull(current).read(buffer, offset, length)

    override fun getUri(): Uri? = current?.uri

    override fun getResponseHeaders(): Map<String, List<String>> = current?.responseHeaders ?: emptyMap()

    override fun close() {
      try {
        current?.close()
      } finally {
        current = null
      }
    }
  }

  @Synchronized
  fun release() {
    cache?.release()
    cache = null
  }

  private fun create(context: Context): SimpleCache {
    val dir = File(context.cacheDir, "stream-cache")
    val db = StandaloneDatabaseProvider(context)
    runCatching { SimpleCache.delete(dir, db) }
    return SimpleCache(dir, LeastRecentlyUsedCacheEvictor(MAX_BYTES), db)
  }
}
