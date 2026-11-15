// `npm run ffmpeg`: descarga ffmpeg para Windows (compilación LGPL de BtbN/FFmpeg-Builds, la que enlaza ffmpeg.org),
// comprueba su SHA-256 con la lista de huellas de la misma versión y deja solo ffmpeg.exe donde Tauri lo empaqueta
// (src-tauri/binaries/ffmpeg-<triple>.exe, ver bundle.externalBin). No va en git: pesa demasiado.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';
const ASSET = 'ffmpeg-master-latest-win64-lgpl.zip';
const target = fileURLToPath(new URL('../src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe', import.meta.url));

if (existsSync(target) && !process.argv.includes('--force')) {
  console.log(`Ya está: ${target} (usa --force para volver a descargarlo)`);
  process.exit(0);
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const sums = (await download(`${RELEASE}/checksums.sha256`)).toString('utf8');
const expected = sums
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find(([, name]) => name?.replace(/^\*/, '') === ASSET)?.[0];
if (!expected) throw new Error(`${ASSET} no aparece en checksums.sha256`);

console.log(`Descargando ${ASSET}…`);
const zip = await download(`${RELEASE}/${ASSET}`);
const actual = createHash('sha256').update(zip).digest('hex');
if (actual !== expected.toLowerCase()) throw new Error(`SHA-256 distinto: esperado ${expected}, obtenido ${actual}`);
console.log(`SHA-256 correcto (${actual}), ${(zip.length / 1024 ** 2).toFixed(1)} MB`);

// En una carpeta temporal propia; tar (bsdtar de Windows 10+) sabe abrir .zip.
const work = mkdtempSync(join(tmpdir(), 'impala-ffmpeg-'));
try {
  const zipPath = join(work, ASSET);
  writeFileSync(zipPath, zip);
  const out = join(work, 'out');
  mkdirSync(out);
  execFileSync('tar', ['-xf', zipPath, '-C', out]);
  const find = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        const found = find(p);
        if (found) return found;
      } else if (name.toLowerCase() === 'ffmpeg.exe') return p;
    }
    return null;
  };
  const exe = find(out);
  if (!exe) throw new Error('ffmpeg.exe no está en el zip');
  mkdirSync(fileURLToPath(new URL('../src-tauri/binaries/', import.meta.url)), { recursive: true });
  copyFileSync(exe, target);
  console.log(`Listo: ${target} (${(statSync(target).size / 1024 ** 2).toFixed(1)} MB)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
