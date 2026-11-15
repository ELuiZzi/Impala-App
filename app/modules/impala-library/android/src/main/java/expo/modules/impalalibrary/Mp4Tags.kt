package expo.modules.impalalibrary

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer

/** Etiquetas de estilo iTunes (moov/udta/meta/ilst) que Android, Navidrome y casi todos los reproductores leen. */
data class Mp4Tags(
  val title: String?,
  val artist: String?,
  val album: String?,
  val albumArtist: String?,
  val track: Int?,
  val year: Int?,
  /** JPEG (o PNG) de la carátula. */
  val cover: ByteArray?,
)

/**
 * Escribe etiquetas en un MP4/M4A sin recodificar ni depender de bibliotecas: reconstruye la caja `moov` con
 * un `udta` nuevo y, si `moov` va antes de los datos (`mdat`), corrige los desplazamientos de los trozos
 * (`stco`/`co64`), que son absolutos dentro del archivo.
 */
object Mp4Tagger {
  private data class Box(val type: String, val offset: Long, val size: Long)

  fun write(src: File, dst: File, tags: Mp4Tags) = writeUdta(src, dst, udtaBox(ilst(tags)))

  /**
   * La caja `udta` (etiquetas y carátula) de un MP4 ya abierto, tal cual; null si no tiene. Sirve para pasar las
   * etiquetas de un archivo a otro sin interpretarlas (recortes).
   */
  fun readUdta(input: RandomAccessFile): ByteArray? {
    val moov = topLevelBoxes(input).firstOrNull { it.type == "moov" } ?: return null
    if (moov.size >= MAX_MOOV) return null
    val data = ByteArray(moov.size.toInt()).also { input.seek(moov.offset); input.readFully(it) }
    var pos = 8
    while (pos + 8 <= data.size) {
      val size = readU32(data, pos).toInt()
      if (size < 8 || pos + size > data.size) return null
      if (typeOf(data, pos + 4) == "udta") return data.copyOfRange(pos, pos + size)
      pos += size
    }
    return null
  }

  /** Copia `src` en `dst` cambiando su `udta` por la dada (una caja completa, con cabecera). */
  fun writeUdta(src: File, dst: File, udta: ByteArray) {
    RandomAccessFile(src, "r").use { input ->
      val boxes = topLevelBoxes(input)
      val moov = boxes.firstOrNull { it.type == "moov" } ?: error("El archivo no tiene caja moov")
      require(moov.size < MAX_MOOV) { "Caja moov demasiado grande" }
      val old = ByteArray(moov.size.toInt()).also { input.seek(moov.offset); input.readFully(it) }
      val updated = rebuildMoov(old, udta)
      val delta = updated.size - old.size
      if (boxes.any { it.type == "mdat" && it.offset > moov.offset }) shiftChunkOffsets(updated, 8, updated.size, delta.toLong())

      RandomAccessFile(dst, "rw").use { out ->
        out.setLength(0)
        val inCh = input.channel
        val outCh = out.channel
        for (box in boxes) {
          if (box === moov) {
            outCh.write(ByteBuffer.wrap(updated))
            continue
          }
          var pos = box.offset
          val end = box.offset + box.size
          while (pos < end) pos += inCh.transferTo(pos, end - pos, outCh).also { if (it <= 0) error("No se pudo copiar el audio") }
        }
      }
    }
  }

  private fun topLevelBoxes(f: RandomAccessFile): List<Box> {
    val boxes = mutableListOf<Box>()
    val length = f.length()
    var pos = 0L
    while (pos + 8 <= length) {
      f.seek(pos)
      var size = f.readInt().toLong() and 0xffffffffL
      val type = typeOf(ByteArray(4).also { f.readFully(it) })
      if (size == 1L) size = f.readLong()
      if (size == 0L) size = length - pos
      if (size < 8 || pos + size > length) error("MP4 dañado (caja $type)")
      boxes += Box(type, pos, size)
      pos += size
    }
    return boxes
  }

  private fun udtaBox(ilst: ByteArray): ByteArray {
    val hdlr = box("hdlr", ByteArray(8) + "mdir".toByteArray(Charsets.ISO_8859_1) + "appl".toByteArray(Charsets.ISO_8859_1) + ByteArray(9))
    return box("udta", box("meta", ByteArray(4) + hdlr + ilst))
  }

  /** moov sin su udta (si lo había) más el udta nuevo al final. */
  private fun rebuildMoov(moov: ByteArray, udta: ByteArray): ByteArray {
    val out = ByteArrayOutputStream(moov.size + udta.size + 64)
    out.write(ByteArray(8)) // cabecera, se rellena al final
    var pos = 8
    while (pos + 8 <= moov.size) {
      val size = readU32(moov, pos).toInt()
      if (size < 8 || pos + size > moov.size) error("MP4 dañado (moov)")
      if (typeOf(moov, pos + 4) != "udta") out.write(moov, pos, size)
      pos += size
    }
    out.write(udta)
    val result = out.toByteArray()
    writeU32(result, 0, result.size.toLong())
    "moov".toByteArray(Charsets.ISO_8859_1).copyInto(result, 4)
    return result
  }

  private val CONTAINERS = setOf("trak", "mdia", "minf", "stbl")

  private fun shiftChunkOffsets(data: ByteArray, start: Int, end: Int, delta: Long) {
    var pos = start
    while (pos + 8 <= end) {
      val size = readU32(data, pos).toInt()
      if (size < 8 || pos + size > end) return
      when (val type = typeOf(data, pos + 4)) {
        in CONTAINERS -> shiftChunkOffsets(data, pos + 8, pos + size, delta)
        "stco", "co64" -> {
          val count = readU32(data, pos + 12).toInt()
          val wide = type == "co64"
          for (i in 0 until count) {
            val at = pos + 16 + i * (if (wide) 8 else 4)
            if (wide) {
              val v = ByteBuffer.wrap(data, at, 8).long + delta
              ByteBuffer.wrap(data, at, 8).putLong(v)
            } else {
              val v = readU32(data, at) + delta
              require(v in 0..0xffffffffL) { "Desplazamiento fuera de rango" }
              writeU32(data, at, v)
            }
          }
        }
      }
      pos += size
    }
  }

  private fun ilst(t: Mp4Tags): ByteArray {
    val items = ByteArrayOutputStream()
    fun text(name: String, value: String?) {
      if (!value.isNullOrBlank()) items.write(item(name, 1, value.trim().toByteArray(Charsets.UTF_8)))
    }
    text("©nam", t.title)
    text("©ART", t.artist)
    text("©alb", t.album)
    text("aART", t.albumArtist)
    text("©day", t.year?.toString())
    t.track?.takeIf { it in 1..65535 }?.let { n ->
      items.write(item("trkn", 0, byteArrayOf(0, 0, (n shr 8).toByte(), n.toByte(), 0, 0, 0, 0)))
    }
    t.cover?.let { img ->
      val png = img.size > 4 && img[0] == 0x89.toByte() && img[1] == 'P'.code.toByte()
      items.write(item("covr", if (png) 14 else 13, img))
    }
    return box("ilst", items.toByteArray())
  }

  private fun item(name: String, dataType: Int, payload: ByteArray): ByteArray {
    val header = ByteArray(8)
    writeU32(header, 0, dataType.toLong())
    return box(name, box("data", header + payload))
  }

  private fun box(type: String, payload: ByteArray): ByteArray {
    val out = ByteArray(8 + payload.size)
    writeU32(out, 0, out.size.toLong())
    type.toByteArray(Charsets.ISO_8859_1).copyInto(out, 4)
    payload.copyInto(out, 8)
    return out
  }

  private fun typeOf(b: ByteArray, at: Int = 0) = String(b, at, 4, Charsets.ISO_8859_1)

  private fun readU32(b: ByteArray, at: Int): Long =
    ((b[at].toLong() and 0xff) shl 24) or ((b[at + 1].toLong() and 0xff) shl 16) or ((b[at + 2].toLong() and 0xff) shl 8) or (b[at + 3].toLong() and 0xff)

  private fun writeU32(b: ByteArray, at: Int, v: Long) {
    b[at] = (v shr 24).toByte(); b[at + 1] = (v shr 16).toByte(); b[at + 2] = (v shr 8).toByte(); b[at + 3] = v.toByte()
  }

  private const val MAX_MOOV = 64L * 1024 * 1024
}
