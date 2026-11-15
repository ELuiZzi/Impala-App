import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './auth.js';
import { AUDIO_EXTENSIONS } from './filename.js';
import { createSubsonic } from './navidrome.js';
import { createTrimmer, mapTime, normalizeKeep } from './trimmer.js';

const MAX_WAVEFORMS = 50;

/**
 * Operaciones sobre la biblioteca que la API Subsonic no ofrece (borrar y recortar canciones). Se
 * hacen con las credenciales Subsonic del usuario: Navidrome dice dónde está el archivo y si el
 * usuario es administrador. Navidrome debe reportar la ruta real (ND_SUBSONIC_DEFAULTREPORTREALPATH=true);
 * la consulta usa su propio nombre de cliente (impala-library, distinto del de la validación de
 * credenciales) para que Navidrome lo registre como reproductor nuevo, con esa opción activada.
 *
 * Recortar sobrescribe el archivo, pero antes guarda el original en backupDir (solo la primera vez:
 * el que se restaura es siempre el original de verdad, aunque se recorte varias veces).
 *
 * config: { musicDir, tmpDir, navidromeUrl, backupDir?, lyrics?, trimmer?, fetchImpl? }
 */
export function createLibrary({ musicDir, tmpDir, navidromeUrl, backupDir = null, lyrics = null, trimmer = createTrimmer(), fetchImpl = fetch }) {
  const root = path.resolve(musicDir);
  const subsonic = createSubsonic({ navidromeUrl, client: 'impala-library', fetchImpl });
  const waveforms = new Map();

  function checkId(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw httpError(400, 'Identificador inválido');
  }

  async function requireAdmin(creds, action) {
    const { user } = await subsonic(creds, 'getUser', { username: creds.u });
    if (!user?.adminRole) throw httpError(403, `Solo un administrador puede ${action} canciones`);
  }

  /** El archivo de la canción `id`, comprobando que está dentro de la biblioteca y es audio. */
  async function songFile(id, creds) {
    const { song } = await subsonic(creds, 'getSong', { id });
    const reported = String(song?.path ?? '');
    const file = path.resolve(root, reported.replace(/^\/music\//, ''));
    const relative = path.relative(root, file);
    if (!reported || relative.startsWith('..') || path.isAbsolute(relative) || file.startsWith(path.resolve(tmpDir) + path.sep)) {
      throw httpError(422, 'La ruta del archivo no está dentro de la biblioteca');
    }
    if (!AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) throw httpError(422, 'No es un archivo de audio');
    return { file, relative: relative.split(path.sep).join('/'), reported };
  }

  async function mustExist(file, id, reported) {
    try {
      return await fs.stat(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      console.warn(`${id}: Navidrome reporta "${reported}", no existe en el disco`);
      throw httpError(404, 'No se encontró el archivo en el disco (¿Navidrome reporta la ruta real?)');
    }
  }

  /** Borra del disco el archivo de una canción; Navidrome la retira de la biblioteca al detectarlo. */
  async function deleteSong(id, creds) {
    if (typeof id !== 'string' || !id || id.length > 100) throw httpError(400, 'Identificador inválido');
    await requireAdmin(creds, 'borrar');
    const { file, relative, reported } = await songFile(id, creds);
    await mustExist(file, id, reported);
    await fs.unlink(file);
    console.log(`borrado: ${relative}`);
    return { deleted: relative };
  }

  // --- Recortar ------------------------------------------------------------------------------------

  const backupMeta = (id) => path.join(backupDir, `${id}.json`);

  async function readBackup(id) {
    if (!backupDir) return null;
    try {
      return JSON.parse(await fs.readFile(backupMeta(id), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Lo que la pantalla de recorte necesita saber antes de empezar. */
  async function trimInfo(id, creds) {
    checkId(id);
    const { file, reported } = await songFile(id, creds);
    await mustExist(file, id, reported);
    const info = await trimmer.probe(file);
    const backup = await readBackup(id);
    const { user } = await subsonic(creds, 'getUser', { username: creds.u });
    return {
      // Solo un administrador puede guardar el recorte; los demás ven la pantalla pero no pueden guardar.
      admin: !!user?.adminRole,
      duration: info.duration,
      codec: info.codec,
      // 'reencode': sin pérdida, exacto a la muestra; 'copy': sin recodificar, el corte cae en la trama más cercana.
      method: trimmer.method(info.codec),
      canTrim: !!backupDir && trimmer.method(info.codec) !== null,
      backup: backup ? { createdAt: backup.createdAt, duration: backup.duration } : null,
    };
  }

  /** Forma de onda (picos de 0 a 1) para dibujar la canción; se guarda mientras el archivo no cambie. */
  async function waveform(id, creds) {
    checkId(id);
    const { file, reported } = await songFile(id, creds);
    const stat = await mustExist(file, id, reported);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (!waveforms.has(key)) {
      if (waveforms.size >= MAX_WAVEFORMS) waveforms.delete(waveforms.keys().next().value);
      waveforms.set(key, await trimmer.waveform(file));
    }
    return { peaks: waveforms.get(key) };
  }

  /**
   * Recorta la canción: conserva solo los tramos `keep` ([[inicio, fin], …] en segundos) y
   * sobrescribe el archivo. Las letras sincronizadas guardadas se mueven al nuevo tiempo.
   */
  async function trimSong(id, creds, body) {
    checkId(id);
    if (!backupDir) throw httpError(503, 'El servidor no tiene carpeta para guardar los originales');
    await requireAdmin(creds, 'recortar');
    const { file, relative, reported } = await songFile(id, creds);
    await mustExist(file, id, reported);
    const info = await trimmer.probe(file);
    const keep = normalizeKeep(body?.keep, info.duration);

    const ext = path.extname(file);
    const output = path.join(tmpDir, `trim-${randomUUID()}${ext}`);
    try {
      await trimmer.cut(file, output, keep, info);
      const result = await trimmer.probe(output);
      const expected = keep.reduce((t, [s, e]) => t + e - s, 0);
      if (Math.abs(result.duration - expected) > 1) throw httpError(500, 'El recorte no salió con la duración esperada; el archivo no se tocó');

      // El original se guarda solo la primera vez.
      if (!(await readBackup(id))) {
        await fs.mkdir(backupDir, { recursive: true });
        await fs.copyFile(file, path.join(backupDir, `${id}${ext}`));
        const meta = { relative, ext, createdAt: Date.now(), duration: info.duration, lyrics: (await lyrics?.entry(id)) ?? null };
        await fs.writeFile(backupMeta(id), JSON.stringify(meta));
      }
      // Mismo montaje que la música: el cambio es atómico.
      await fs.rename(output, file);

      const current = await lyrics?.entry(id);
      if (current?.synced && current.lines?.length) await lyrics.replace(id, { ...current, lines: shiftLines(current.lines, keep) });

      await rescan(creds);
      console.log(`recortado: ${relative} (${info.duration.toFixed(1)} s → ${result.duration.toFixed(1)} s)`);
      return { duration: result.duration, backup: true };
    } finally {
      await fs.rm(output, { force: true });
    }
  }

  /** Devuelve el archivo original (y su letra) y borra la copia guardada. */
  async function restoreSong(id, creds) {
    checkId(id);
    await requireAdmin(creds, 'restaurar');
    const backup = await readBackup(id);
    if (!backup) throw httpError(404, 'Esta canción no tiene un original guardado');
    const { file, relative, reported } = await songFile(id, creds);
    await mustExist(file, id, reported);
    if (path.extname(file) !== backup.ext) throw httpError(409, 'El archivo cambió de formato desde que se recortó');

    const saved = path.join(backupDir, `${id}${backup.ext}`);
    const staging = path.join(tmpDir, `restore-${randomUUID()}${backup.ext}`);
    try {
      // La copia vive en otro montaje: primero a temporales (mismo montaje que la música) y luego rename.
      await fs.copyFile(saved, staging);
      await fs.rename(staging, file);
    } finally {
      await fs.rm(staging, { force: true });
    }
    await lyrics?.replace(id, backup.lyrics ?? null);
    await fs.rm(saved, { force: true });
    await fs.rm(backupMeta(id), { force: true });
    await rescan(creds);
    console.log(`restaurado: ${relative}`);
    return { duration: backup.duration };
  }

  /** Navidrome detecta el cambio en su próximo escaneo; se le pide uno ya para que la duración se actualice. */
  async function rescan(creds) {
    try {
      await subsonic(creds, 'startScan', {});
    } catch (err) {
      console.warn('no se pudo pedir un escaneo a Navidrome:', err.message);
    }
  }

  return { deleteSong, trimInfo, waveform, trimSong, restoreSong };
}

/** Mueve las líneas (y palabras) al tiempo de la canción recortada; las de trozos eliminados se van. */
export function shiftLines(lines, keep) {
  const out = [];
  for (const line of lines) {
    if (line.timeMs === null) {
      out.push(line);
      continue;
    }
    const timeMs = mapTime(line.timeMs, keep);
    if (timeMs === null) continue;
    const shifted = { ...line, timeMs };
    if (line.words) {
      const words = line.words.map((w) => ({ ...w, timeMs: mapTime(w.timeMs, keep) })).filter((w) => w.timeMs !== null);
      if (words.length) shifted.words = words;
      else delete shifted.words;
    }
    out.push(shifted);
  }
  return out;
}
