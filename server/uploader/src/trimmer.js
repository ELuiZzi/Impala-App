import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './auth.js';

/** Puntos de la forma de onda que se envían a la app (uno cada ~0,8 s en una canción de 4 min). */
export const WAVEFORM_POINTS = 300;
/** Lo mínimo que puede quedar de una canción tras recortarla. */
export const MIN_KEPT_SECONDS = 1;

/**
 * Códecs sin pérdida: se decodifican y se vuelven a codificar con el mismo códec, así que las
 * muestras que se conservan quedan idénticas. Los demás (MP3, AAC, Opus, Vorbis) se cortan sin
 * recodificar (copia de tramas), para no perder calidad; el corte cae en el límite de trama más
 * cercano (~20-60 ms en MP3/AAC; en Ogg/Opus, en el de página, hasta ~0,5 s).
 */
const LOSSLESS_ENCODERS = new Map([
  ['flac', 'flac'],
  ['alac', 'alac'],
  ['wavpack', 'wavpack'],
  ['pcm_s16le', 'pcm_s16le'],
  ['pcm_s24le', 'pcm_s24le'],
  ['pcm_s32le', 'pcm_s32le'],
  ['pcm_s16be', 'pcm_s16be'],
  ['pcm_s24be', 'pcm_s24be'],
  ['pcm_f32le', 'pcm_f32le'],
]);
const LOSSY_COPY = new Set(['mp3', 'aac', 'opus', 'vorbis']);
/** Contenedores que guardan la carátula como un flujo de vídeo (attached_pic). */
const COVER_AS_STREAM = new Set(['.mp3', '.m4a', '.mp4', '.flac']);

/**
 * Ejecuta ffmpeg/ffprobe sobre los archivos de la biblioteca.
 * config: { ffmpeg?, ffprobe?, spawnImpl? }
 */
export function createTrimmer({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', spawnImpl = spawn } = {}) {
  function run(cmd, args, { binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [];
      let err = '';
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.on('error', (e) => reject(httpError(500, `No se pudo ejecutar ${cmd}: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) return reject(httpError(500, `${cmd} falló: ${err.trim().split('\n').pop() || `código ${code}`}`));
        const buffer = Buffer.concat(out);
        resolve(binary ? buffer : buffer.toString('utf8'));
      });
    });
  }

  /** { duration (s), codec, bitsPerSample } del primer flujo de audio. */
  async function probe(file) {
    const json = JSON.parse(
      await run(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,bits_per_raw_sample,bits_per_sample:format=duration', '-of', 'json', file]),
    );
    const stream = json.streams?.[0];
    const duration = Number(json.format?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0) throw httpError(422, 'No se pudo leer el audio del archivo');
    const bits = Number(stream.bits_per_raw_sample) || Number(stream.bits_per_sample) || null;
    return { duration, codec: String(stream.codec_name), bitsPerSample: bits };
  }

  /** Si este archivo se puede recortar y cómo (sin pérdida o copiando tramas). */
  function method(codec) {
    if (LOSSLESS_ENCODERS.has(codec)) return 'reencode';
    if (LOSSY_COPY.has(codec)) return 'copy';
    return null;
  }

  /**
   * Picos de la forma de onda, de 0 a 1: el audio se decodifica en mono a 1 kHz (de sobra para
   * dibujarla) y se toma el máximo de cada tramo.
   */
  async function waveform(file, points = WAVEFORM_POINTS) {
    const pcm = await run(ffmpeg, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '1000', '-f', 's16le', '-'], { binary: true });
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) return [];
    const per = samples / points;
    const peaks = [];
    let max = 0;
    for (let p = 0; p < points; p++) {
      let peak = 0;
      const end = Math.min(samples, Math.floor((p + 1) * per));
      for (let i = Math.floor(p * per); i < end; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
      peaks.push(peak);
      max = Math.max(max, peak);
    }
    return peaks.map((v) => (max ? Math.round((v / max) * 1000) / 1000 : 0));
  }

  /**
   * Escribe en `output` el audio de `input` conservando solo los tramos `keep` ([[inicio, fin], …]
   * en segundos, ordenados y sin solaparse), con sus etiquetas y carátula.
   */
  async function cut(input, output, keep, info) {
    const how = method(info.codec);
    if (!how) throw httpError(422, `No se pueden recortar archivos ${info.codec.toUpperCase()}`);
    const ext = path.extname(output).toLowerCase();
    const cover = COVER_AS_STREAM.has(ext);
    const mp3 = ext === '.mp3' ? ['-id3v2_version', '3'] : [];

    if (how === 'reencode') {
      const parts = keep.map(([s, e], i) => `[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      const graph = `${parts.join(';')};${keep.map((_, i) => `[a${i}]`).join('')}concat=n=${keep.length}:v=0:a=1[out]`;
      const depth = info.codec === 'flac' && info.bitsPerSample ? ['-bits_per_raw_sample', String(info.bitsPerSample)] : [];
      await run(ffmpeg, [
        '-v', 'error', '-y', '-i', input,
        '-filter_complex', graph,
        '-map', '[out]',
        ...(cover ? ['-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
        '-map_metadata', '0',
        '-c:a', LOSSLESS_ENCODERS.get(info.codec), ...depth,
        ...(info.codec === 'flac' ? ['-compression_level', '8'] : []),
        ...mp3,
        output,
      ]);
      return;
    }

    // Copia de tramas: el demuxer concat lee cada tramo (inpoint/outpoint) del original sin decodificarlo.
    const list = `${output}.ffconcat`;
    const quoted = `'${input.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(list, ['ffconcat version 1.0', ...keep.flatMap(([s, e]) => [`file ${quoted}`, `inpoint ${s}`, `outpoint ${e}`])].join('\n'));
    // Ogg/Opus guarda la carátula en una etiqueta (METADATA_BLOCK_PICTURE) que ffmpeg lee como imagen
    // pero no sabe volver a escribir: se rehace la etiqueta y va, con las demás, en un archivo de metadatos.
    const meta = ext === '.opus' || ext === '.ogg' ? await oggMetadata(input, `${output}.ffmeta`) : null;
    try {
      await run(ffmpeg, [
        '-v', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', list,
        '-i', input,
        ...(meta ? ['-f', 'ffmetadata', '-i', meta] : []),
        '-map', '0:a',
        ...(cover ? ['-map', '1:v?', '-disposition:v', 'attached_pic'] : []),
        '-map_metadata', '1',
        ...(meta ? ['-map_metadata:s:a:0', '2:s:0'] : []),
        '-c', 'copy',
        ...mp3,
        output,
      ]);
    } finally {
      await fs.rm(list, { force: true });
      if (meta) await fs.rm(meta, { force: true });
    }
  }

  /**
   * Archivo ffmetadata con las etiquetas del audio de un Ogg/Opus y su carátula como
   * METADATA_BLOCK_PICTURE (bloque PICTURE de FLAC en base64). null si no hay nada que conservar.
   */
  async function oggMetadata(input, file) {
    const json = JSON.parse(await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:stream_tags', '-of', 'json', input]));
    const audio = json.streams?.find((s) => s.codec_type === 'audio');
    const picture = json.streams?.find((s) => s.codec_type === 'video');
    const tags = { ...(audio?.tags ?? {}) };
    if (picture) {
      const image = await run(ffmpeg, ['-v', 'error', '-i', input, '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-'], { binary: true });
      if (image.length) tags.METADATA_BLOCK_PICTURE = pictureBlock(image, picture).toString('base64');
    }
    if (Object.keys(tags).length === 0) return null;
    const escape = (v) => String(v).replace(/[=;#\\\n]/g, (c) => `\\${c}`);
    const lines = [';FFMETADATA1', '[STREAM]', ...Object.entries(tags).map(([k, v]) => `${escape(k)}=${escape(v)}`)];
    await fs.writeFile(file, `${lines.join('\n')}\n`);
    return file;
  }

  return { probe, method, waveform, cut };
}

/** Bloque PICTURE de FLAC (el formato de METADATA_BLOCK_PICTURE): tipo 3 = portada. */
export function pictureBlock(image, { codec_name: codec, width = 0, height = 0 }) {
  const mime = Buffer.from(codec === 'png' ? 'image/png' : 'image/jpeg');
  const block = Buffer.alloc(32 + mime.length + image.length);
  let at = 0;
  const u32 = (v) => (at = block.writeUInt32BE(v >>> 0, at));
  u32(3);
  u32(mime.length);
  at += mime.copy(block, at);
  u32(0); // sin descripción
  u32(width);
  u32(height);
  u32(24);
  u32(0);
  u32(image.length);
  image.copy(block, at);
  return block;
}

/**
 * Valida y normaliza los tramos que se conservan: dentro de la canción, ordenados, sin solaparse y
 * con al menos MIN_KEPT_SECONDS en total. Segundos con 3 decimales.
 */
export function normalizeKeep(keep, duration) {
  if (!Array.isArray(keep) || keep.length === 0 || keep.length > 50) throw httpError(400, 'Tramos inválidos');
  const ranges = keep.map((r) => {
    if (!Array.isArray(r) || r.length !== 2) throw httpError(400, 'Tramos inválidos');
    const [s, e] = r.map(Number);
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw httpError(400, 'Tramos inválidos');
    const start = Math.max(0, Math.round(s * 1000) / 1000);
    const end = Math.min(duration, Math.round(e * 1000) / 1000);
    if (end - start < 0.05) throw httpError(400, 'Hay un tramo vacío');
    return [start, end];
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw httpError(400, 'Los tramos se solapan');
  const kept = ranges.reduce((t, [s, e]) => t + e - s, 0);
  if (kept < MIN_KEPT_SECONDS) throw httpError(400, 'Quedaría menos de un segundo de canción');
  if (ranges.length === 1 && ranges[0][0] === 0 && duration - ranges[0][1] < 0.05) throw httpError(400, 'No hay nada que recortar');
  return ranges;
}

/**
 * Traduce un instante de la canción original (ms) al de la recortada; null si cae en un trozo
 * eliminado. Sirve para mover las letras sincronizadas.
 */
export function mapTime(ms, keep) {
  let removedBefore = 0;
  let previousEnd = 0;
  for (const [s, e] of keep) {
    removedBefore += s * 1000 - previousEnd;
    if (ms < s * 1000) return null;
    if (ms <= e * 1000) return Math.round(ms - removedBefore);
    previousEnd = e * 1000;
  }
  return null;
}
