import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createLibrary } from '../src/library.js';

let musicDir;
const creds = { u: 'luizzi', t: 'token', s: 'salt' };
/** Navidrome simulado: canciones por id con la ruta que reportaría (real, relativa o absoluta). */
const songs = {};
let admin = true;
const requests = [];

async function fakeNavidrome(url) {
  const { pathname, searchParams } = new URL(url);
  requests.push({ endpoint: pathname.split('/').pop(), client: searchParams.get('c') });
  const ok = (data) => ({ json: async () => ({ 'subsonic-response': { status: 'ok', ...data } }) });
  if (pathname.endsWith('/getUser')) return ok({ user: { username: searchParams.get('username'), adminRole: admin } });
  if (pathname.endsWith('/startScan')) return ok({ scanStatus: { scanning: true } });
  const song = songs[searchParams.get('id')];
  if (!song) return { json: async () => ({ 'subsonic-response': { status: 'failed', error: { code: 70, message: 'Song not found' } } }) };
  return ok({ song: { id: searchParams.get('id'), path: song } });
}

const library = () => createLibrary({ musicDir, tmpDir: path.join(musicDir, '.impala-tmp'), navidromeUrl: 'http://navidrome:4533', fetchImpl: fakeNavidrome });

before(async () => {
  musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-lib-'));
  await fs.mkdir(path.join(musicDir, 'Todo'), { recursive: true });
  await fs.mkdir(path.join(musicDir, '.impala-tmp'), { recursive: true });
});

after(() => fs.rm(musicDir, { recursive: true, force: true }));

test('borra el archivo que reporta Navidrome (ruta relativa o con /music/)', async () => {
  await fs.writeFile(path.join(musicDir, 'Todo', 'A - B.opus'), 'x');
  await fs.writeFile(path.join(musicDir, 'Todo', 'C - D.flac'), 'x');
  songs.uno = 'Todo/A - B.opus';
  songs.dos = '/music/Todo/C - D.flac';
  assert.deepEqual(await library().deleteSong('uno', creds), { deleted: 'Todo/A - B.opus' });
  assert.deepEqual(await library().deleteSong('dos', creds), { deleted: 'Todo/C - D.flac' });
  assert.deepEqual(await fs.readdir(path.join(musicDir, 'Todo')), []);
  assert.ok(requests.every((r) => r.client === 'impala-library'), 'cliente propio para que Navidrome reporte la ruta real');
});

test('no sale de la carpeta de música ni toca temporales o archivos que no son audio', async () => {
  songs.fuera = '../../etc/passwd.mp3';
  songs.tmp = '.impala-tmp/x.opus';
  songs.texto = 'Todo/notas.txt';
  await assert.rejects(library().deleteSong('fuera', creds), { status: 422 });
  await assert.rejects(library().deleteSong('tmp', creds), { status: 422 });
  await assert.rejects(library().deleteSong('texto', creds), { status: 422 });
});

test('canción inexistente o archivo ausente → 404', async () => {
  await assert.rejects(library().deleteSong('nada', creds), { status: 404 });
  songs.fantasma = 'Todo/no-existe.opus';
  await assert.rejects(library().deleteSong('fantasma', creds), { status: 404 });
});

test('solo administradores y con credenciales Subsonic', async () => {
  admin = false;
  await fs.writeFile(path.join(musicDir, 'Todo', 'E.opus'), 'x');
  songs.tres = 'Todo/E.opus';
  await assert.rejects(library().deleteSong('tres', creds), { status: 403 });
  admin = true;
  await assert.rejects(library().deleteSong('tres', {}), { status: 400 });
  await fs.access(path.join(musicDir, 'Todo', 'E.opus'));
});

// --- Recortar ----------------------------------------------------------------------------------------

/** ffmpeg simulado: el "audio" es un texto; cortar escribe los tramos conservados. */
const fakeTrimmer = {
  probe: async (file) => {
    const content = await fs.readFile(file, 'utf8');
    const duration = content.startsWith('cut:') ? JSON.parse(content.slice(4)).reduce((t, [s, e]) => t + e - s, 0) : 200;
    return { duration, codec: 'flac', bitsPerSample: 16 };
  },
  method: (codec) => (codec === 'flac' ? 'reencode' : null),
  waveform: async () => [0, 0.5, 1],
  cut: async (_input, output, keep) => fs.writeFile(output, `cut:${JSON.stringify(keep)}`),
};

/** Letras simuladas en memoria. */
function fakeLyrics(initial) {
  const store = new Map(Object.entries(initial));
  return { store, entry: async (id) => store.get(id) ?? null, replace: async (id, e) => (e ? store.set(id, e) : store.delete(id)) };
}

test('recortar guarda el original, sobrescribe, mueve la letra y restaurar lo deshace', async () => {
  const backupDir = path.join(musicDir, '..', `${path.basename(musicDir)}-backups`);
  const file = path.join(musicDir, 'Todo', 'Larga intro.flac');
  await fs.writeFile(file, 'original');
  songs.larga = 'Todo/Larga intro.flac';
  const original = { source: 'lrclib', synced: true, fetchedAt: 1, lines: [{ timeMs: 5_000, text: 'intro' }, { timeMs: 30_000, text: 'verso' }] };
  const lyrics = fakeLyrics({ larga: original });
  const lib = createLibrary({ musicDir, tmpDir: path.join(musicDir, '.impala-tmp'), navidromeUrl: 'http://navidrome:4533', backupDir, lyrics, trimmer: fakeTrimmer, fetchImpl: fakeNavidrome });

  assert.deepEqual((await lib.trimInfo('larga', creds)).backup, null);
  requests.length = 0;
  assert.deepEqual(await lib.trimSong('larga', creds, { keep: [[20, 180]] }), { duration: 160, backup: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'cut:[[20,180]]');
  assert.equal(await fs.readFile(path.join(backupDir, 'larga.flac'), 'utf8'), 'original');
  assert.deepEqual(lyrics.store.get('larga').lines, [{ timeMs: 10_000, text: 'verso' }]);
  assert.ok(requests.some((r) => r.endpoint === 'startScan'), 'pide a Navidrome que vuelva a escanear');
  assert.equal((await lib.trimInfo('larga', creds)).backup.duration, 200);
  assert.deepEqual(await fs.readdir(path.join(musicDir, '.impala-tmp')), [], 'no deja temporales');

  // Un segundo recorte no pisa el original guardado.
  await lib.trimSong('larga', creds, { keep: [[0, 100]] });
  assert.equal(await fs.readFile(path.join(backupDir, 'larga.flac'), 'utf8'), 'original');

  assert.deepEqual(await lib.restoreSong('larga', creds), { duration: 200 });
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  assert.deepEqual(lyrics.store.get('larga'), original);
  assert.deepEqual(await fs.readdir(backupDir), []);
  await assert.rejects(lib.restoreSong('larga', creds), { status: 404 });
  await fs.rm(backupDir, { recursive: true, force: true });
});

test('recortar: solo administradores, tramos válidos y formatos soportados', async () => {
  const backupDir = path.join(musicDir, '..', `${path.basename(musicDir)}-backups2`);
  await fs.writeFile(path.join(musicDir, 'Todo', 'Otra.flac'), 'original');
  songs.otra = 'Todo/Otra.flac';
  const lib = createLibrary({ musicDir, tmpDir: path.join(musicDir, '.impala-tmp'), navidromeUrl: 'http://navidrome:4533', backupDir, trimmer: fakeTrimmer, fetchImpl: fakeNavidrome });
  admin = false;
  await assert.rejects(lib.trimSong('otra', creds, { keep: [[10, 100]] }), { status: 403 });
  admin = true;
  await assert.rejects(lib.trimSong('otra', creds, { keep: [[0, 200]] }), { status: 400 });
  await assert.rejects(lib.trimSong('../x', creds, { keep: [[10, 100]] }), { status: 400 });
  const noBackups = createLibrary({ musicDir, tmpDir: path.join(musicDir, '.impala-tmp'), navidromeUrl: 'http://navidrome:4533', trimmer: fakeTrimmer, fetchImpl: fakeNavidrome });
  await assert.rejects(noBackups.trimSong('otra', creds, { keep: [[10, 100]] }), { status: 503 });
  assert.equal(await fs.readFile(path.join(musicDir, 'Todo', 'Otra.flac'), 'utf8'), 'original');
  assert.deepEqual(await lib.waveform('otra', creds), { peaks: [0, 0.5, 1] });
});
