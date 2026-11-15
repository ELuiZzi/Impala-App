import { Directory, File, Paths } from 'expo-file-system';
import ImpalaLibrary from '../../modules/impala-library';
import { cachedLyrics, localLyrics, replaceCachedLyrics } from './localLyrics';
import type { LyricLine, Lyrics, Range, Song, TrimInfo } from './types';

/**
 * Recortes de la música del teléfono, igual que en el servidor (uploader/src/library.js y trimmer.js): sin
 * recodificar (AAC en M4A y MP3; el corte cae en la trama más cercana), sobrescribiendo el archivo y guardando
 * el original la primera vez (en el almacenamiento privado de la app) para poder restaurarlo. La letra
 * sincronizada guardada se mueve al nuevo tiempo.
 *
 * FLAC, Opus, Vorbis y WAV no se recortan: habría que recodificarlos (canTrim=false).
 */
const WAVEFORM_POINTS = 300;
const MIN_KEPT_SECONDS = 1;

const backupDir = new Directory(Paths.document, 'trim-backups');

type BackupMeta = { suffix: string | null; createdAt: number; duration: number; lyrics: Lyrics | null };

const metaFile = (id: string) => new File(backupDir, `${id}.json`);
const backupFile = (id: string) => new File(backupDir, `${id}.audio`);

function readBackup(id: string): BackupMeta | null {
  try {
    const meta = metaFile(id);
    if (!meta.exists || !backupFile(id).exists) return null;
    return JSON.parse(meta.textSync()) as BackupMeta;
  } catch {
    return null;
  }
}

/** Al borrar la canción, su original guardado ya no sirve. */
export function removeBackup(id: string) {
  for (const f of [metaFile(id), backupFile(id)]) {
    try {
      if (f.exists) f.delete();
    } catch {
      // nada que borrar
    }
  }
}

export async function localTrimInfo(id: string): Promise<TrimInfo> {
  const p = await ImpalaLibrary.probeAudio(id);
  const backup = readBackup(id);
  return {
    admin: true,
    duration: p.durationMs / 1000,
    codec: p.codec,
    method: p.canTrim ? 'copy' : null,
    canTrim: p.canTrim,
    backup: backup ? { createdAt: backup.createdAt, duration: backup.duration } : null,
  };
}

export const localWaveform = (id: string) => ImpalaLibrary.waveform(id, WAVEFORM_POINTS);

export async function localTrim(song: Song, keepIn: Range[]): Promise<{ duration: number }> {
  const p = await ImpalaLibrary.probeAudio(song.id);
  if (!p.canTrim) throw new Error(`No se pueden recortar archivos ${p.codec.toUpperCase()}`);
  const duration = p.durationMs / 1000;
  const keep = normalizeKeep(keepIn, duration);

  const output = new File(Paths.cache, `trim-${Date.now()}.${p.suffix ?? 'audio'}`);
  try {
    const resultMs = await ImpalaLibrary.trimToFile(song.id, keep, output.uri);
    const expected = keep.reduce((t, [s, e]) => t + e - s, 0);
    if (Math.abs(resultMs / 1000 - expected) > 1) throw new Error('El recorte no salió con la duración esperada; el archivo no se tocó');

    // La letra de LRCLIB se busca antes de cambiar la duración (si no, después podría no encontrarse).
    await localLyrics(song).catch(() => null);
    const lyrics = cachedLyrics(song);

    // El original se guarda solo la primera vez.
    let created = false;
    if (!readBackup(song.id)) {
      if (!backupDir.exists) backupDir.create({ intermediates: true });
      await ImpalaLibrary.copySong(song.id, backupFile(song.id).uri);
      const meta: BackupMeta = { suffix: p.suffix, createdAt: Date.now(), duration, lyrics };
      metaFile(song.id).write(JSON.stringify(meta));
      created = true;
    }
    if (!(await ImpalaLibrary.overwriteSong(song.id, output.uri))) {
      if (created) removeBackup(song.id);
      throw new Error('Android no dio permiso para modificar el archivo');
    }
    if (lyrics?.synced && lyrics.lines.length) replaceCachedLyrics(song, { ...lyrics, lines: shiftLines(lyrics.lines, keep) });
    return { duration: resultMs / 1000 };
  } finally {
    try {
      if (output.exists) output.delete();
    } catch {
      // se queda en la caché, Android la limpia
    }
  }
}

export async function localRestore(song: Song): Promise<{ duration: number }> {
  const backup = readBackup(song.id);
  if (!backup) throw new Error('Esta canción no tiene un original guardado');
  const p = await ImpalaLibrary.probeAudio(song.id);
  if (p.suffix !== backup.suffix) throw new Error('El archivo cambió de formato desde que se recortó');
  if (!(await ImpalaLibrary.overwriteSong(song.id, backupFile(song.id).uri))) throw new Error('Android no dio permiso para modificar el archivo');
  replaceCachedLyrics(song, backup.lyrics);
  removeBackup(song.id);
  return { duration: backup.duration };
}

/** Como normalizeKeep del servidor: dentro de la canción, ordenados, sin solaparse y al menos 1 s en total. */
export function normalizeKeep(keep: Range[], duration: number): Range[] {
  if (!Array.isArray(keep) || keep.length === 0 || keep.length > 50) throw new Error('Tramos inválidos');
  const ranges = keep.map(([s, e]): Range => {
    if (!Number.isFinite(s) || !Number.isFinite(e)) throw new Error('Tramos inválidos');
    const start = Math.max(0, Math.round(s * 1000) / 1000);
    const end = Math.min(duration, Math.round(e * 1000) / 1000);
    if (end - start < 0.05) throw new Error('Hay un tramo vacío');
    return [start, end];
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw new Error('Los tramos se solapan');
  if (ranges.reduce((t, [s, e]) => t + e - s, 0) < MIN_KEPT_SECONDS) throw new Error('Quedaría menos de un segundo de canción');
  if (ranges.length === 1 && ranges[0][0] === 0 && duration - ranges[0][1] < 0.05) throw new Error('No hay nada que recortar');
  return ranges;
}

/** Instante de la canción original (ms) en la recortada; null si cae en un trozo quitado. */
export function mapTime(ms: number, keep: Range[]): number | null {
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

/** Mueve las líneas (y palabras) al tiempo de la canción recortada; las de trozos quitados se van. */
function shiftLines(lines: LyricLine[], keep: Range[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of lines) {
    if (line.timeMs === null) {
      out.push(line);
      continue;
    }
    const timeMs = mapTime(line.timeMs, keep);
    if (timeMs === null) continue;
    const shifted: LyricLine = { ...line, timeMs };
    if (line.words) {
      const words = line.words.flatMap((w) => {
        const t = mapTime(w.timeMs, keep);
        return t === null ? [] : [{ ...w, timeMs: t }];
      });
      if (words.length) shifted.words = words;
      else delete shifted.words;
    }
    out.push(shifted);
  }
  return out;
}
