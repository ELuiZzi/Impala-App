import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { candidateName } from './filename.js';

const MAX_ATTEMPTS = 1000;

export async function md5File(file) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Mueve el archivo temporal a `destDir` sin sobrescribir nunca nada.
 * - Usa link() + unlink(): link falla con EEXIST si el nombre ya existe, así que no hay carreras.
 * - Si ya existe un archivo idéntico (mismo tamaño y MD5) lo reutiliza: un reintento de la app
 *   tras perder la respuesta no crea duplicados.
 */
export async function storeUnique(tmpFile, destDir, name, { size, md5 }) {
  await fs.mkdir(destDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const fileName = candidateName(name, attempt);
    const dest = path.join(destDir, fileName);
    try {
      await fs.link(tmpFile, dest);
      await fs.unlink(tmpFile);
      return { fileName, dest, duplicate: false };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await isSameContent(dest, size, md5)) {
        await fs.unlink(tmpFile);
        return { fileName, dest, duplicate: true };
      }
    }
  }
  throw new Error(`Demasiados archivos con el nombre "${name.base}"`);
}

async function isSameContent(file, size, md5) {
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() && stat.size === size && (await md5File(file)) === md5;
}
