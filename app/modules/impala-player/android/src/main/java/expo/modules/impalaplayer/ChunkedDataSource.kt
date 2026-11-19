package expo.modules.impalaplayer

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener

/**
 * Pide el audio por trozos de [chunkBytes] (cabecera Range con fin) en vez de una sola petición abierta hasta el
 * final. YouTube manda el archivo a toda velocidad y, aunque ExoPlayer deje de leer al llenar su búfer, el
 * sistema sigue recibiendo varios MB en el búfer del socket: en Descubrir (se pasa de canción a los pocos
 * segundos) eso eran ~2,8 MB por canción. Con trozos de 256 KB (~16 s de audio) solo llega lo que se escucha (cada trozo
 * que se empieza llega entero aunque se deje de leer: por eso son pequeños).
 *
 * Para quien lo usa es transparente: lee de seguido y, al acabar un trozo, se abre el siguiente.
 */
@OptIn(UnstableApi::class)
class ChunkedDataSource(private val upstream: DataSource, private val chunkBytes: Long) : DataSource {
  companion object {
    const val HEADER_CHUNK_BYTES = 64L * 1024
  }

  class Factory(private val upstream: DataSource.Factory, private val chunkBytes: Long) : DataSource.Factory {
    override fun createDataSource(): DataSource = ChunkedDataSource(upstream.createDataSource(), chunkBytes)
  }

  private var spec: DataSpec? = null
  /** Posición absoluta del siguiente byte que se entregará. */
  private var position = 0L
  /** Fin absoluto (exclusivo) si se sabe: el pedido o el tamaño del archivo (Content-Range). */
  private var end = C.LENGTH_UNSET.toLong()
  private var chunkLeft = 0L
  /** El primer trozo al abrir desde el principio es pequeño: suele ser solo para leer la cabecera (~3 KB). */
  private var nextChunk = 0L

  override fun addTransferListener(transferListener: TransferListener) = upstream.addTransferListener(transferListener)

  override fun open(dataSpec: DataSpec): Long {
    spec = dataSpec
    position = dataSpec.position
    end = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.position + dataSpec.length else C.LENGTH_UNSET.toLong()
    nextChunk = if (dataSpec.position == 0L) minOf(HEADER_CHUNK_BYTES, chunkBytes) else chunkBytes
    openChunk()
    // "bytes 0-524287/3800000": el tamaño total, para no pedir un trozo más allá del final.
    if (end == C.LENGTH_UNSET.toLong()) {
      val total = upstream.responseHeaders.entries
        .firstOrNull { it.key.equals("Content-Range", ignoreCase = true) }
        ?.value?.firstOrNull()?.substringAfter('/')?.trim()?.toLongOrNull()
      if (total != null) end = total
    }
    return if (end != C.LENGTH_UNSET.toLong()) end - position else C.LENGTH_UNSET.toLong()
  }

  private fun openChunk(): Long {
    val s = spec!!
    val size = nextChunk
    nextChunk = chunkBytes
    val length = if (end != C.LENGTH_UNSET.toLong()) minOf(size, end - position) else size
    val opened = upstream.open(s.subrange(position - s.position, length))
    chunkLeft = if (opened == C.LENGTH_UNSET.toLong()) length else minOf(opened, length)
    return opened
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (end != C.LENGTH_UNSET.toLong() && position >= end) return C.RESULT_END_OF_INPUT
    if (chunkLeft <= 0L) {
      upstream.close()
      if (openChunk() == 0L) return C.RESULT_END_OF_INPUT
    }
    val read = upstream.read(buffer, offset, minOf(length.toLong(), chunkLeft).toInt())
    // El servidor dio menos de lo pedido: era el final del archivo.
    if (read == C.RESULT_END_OF_INPUT) return C.RESULT_END_OF_INPUT
    position += read
    chunkLeft -= read
    return read
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    upstream.close()
  }
}
