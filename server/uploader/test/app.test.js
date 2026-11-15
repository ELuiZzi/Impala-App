import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, TMP_DIRNAME } from '../src/app.js';

const TOKEN = 'x'.repeat(40);
let musicDir;
/** Navidrome simulado: acepta t=buena; navidromeDown simula que no responde. */
const pings = [];
let navidromeDown = false;
async function fakeNavidrome(url) {
  if (navidromeDown) throw new Error('ECONNREFUSED');
  const t = new URL(url).searchParams.get('t');
  pings.push(t);
  return { json: async () => ({ 'subsonic-response': { status: t === 'buena' ? 'ok' : 'failed' } }) };
}
let server;
let baseUrl;

before(async () => {
  musicDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-test-'));
  const app = await createApp({
    musicDir,
    uploadSubdir: 'Todo',
    token: TOKEN,
    maxFileSize: 1024 * 1024,
    navidromeUrl: 'http://navidrome:4533',
    fetchImpl: fakeNavidrome,
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(musicDir, { recursive: true, force: true });
});

/** WAV PCM 16-bit mono de `samples` muestras; `seed` cambia el contenido. */
function wav(samples = 4410, seed = 0) {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(((i * 37 + seed) % 2000) - 1000, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);      // PCM
  header.writeUInt16LE(1, 22);      // mono
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function upload(content, filename, { token = TOKEN, prefix = '/upload', query = '' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([content]), filename);
  return fetch(`${baseUrl}${prefix}${query}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
const tmpEntries = async () => (await fs.readdir(path.join(musicDir, TMP_DIRNAME))).filter((f) => f !== '.ndignore');

test('health responde con y sin el prefijo /upload', async () => {
  for (const url of ['/upload/health', '/health']) {
    const res = await fetch(baseUrl + url);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  }
});

test('rechaza subidas sin token o con token incorrecto', async () => {
  assert.equal((await upload(wav(), 'a.wav', { token: null })).status, 401);
  assert.equal((await upload(wav(), 'a.wav', { token: 'y'.repeat(40) })).status, 401);
});

test('acepta las credenciales Subsonic de la app validándolas con Navidrome (y las recuerda)', async () => {
  pings.length = 0;
  const query = '?u=LuiZzi&t=buena&s=abc123';
  assert.equal((await upload(wav(4410, 11), 'Con sesión.wav', { token: null, query })).status, 201);
  assert.equal((await upload(wav(4410, 12), 'Con sesión 2.wav', { token: null, query })).status, 201);
  assert.deepEqual(pings, ['buena'], 'la segunda subida no debe volver a consultar a Navidrome');
});

test('rechaza credenciales Subsonic inválidas o incompletas', async () => {
  assert.equal((await upload(wav(), 'a.wav', { token: null, query: '?u=LuiZzi&t=mala&s=abc' })).status, 401);
  assert.equal((await upload(wav(), 'a.wav', { token: null, query: '?u=LuiZzi&t=buena' })).status, 401);
});

test('responde 503 si Navidrome no está disponible para validar', async () => {
  navidromeDown = true;
  try {
    const res = await upload(wav(), 'a.wav', { token: null, query: '?u=Otro&t=buena&s=zzz' });
    assert.equal(res.status, 503);
  } finally {
    navidromeDown = false;
  }
});

test('guarda el audio en Todo/ y devuelve MD5, tamaño y metadatos', async () => {
  const content = wav();
  const res = await upload(content, '- Mi Canción -.wav');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.file, 'Todo/Mi Canción.wav');
  assert.equal(body.md5, md5(content));
  assert.equal(body.size, content.length);
  assert.equal(body.duplicate, false);
  assert.equal(body.metadata.sampleRate, 44100);

  const saved = await fs.readFile(path.join(musicDir, 'Todo', 'Mi Canción.wav'));
  assert.equal(md5(saved), md5(content));
  assert.deepEqual(await tmpEntries(), []);
});

test('un reintento con el mismo contenido no duplica el archivo', async () => {
  const content = wav(4410, 7);
  assert.equal((await upload(content, 'Repetida.wav')).status, 201);
  const res = await upload(content, 'Repetida.wav');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.equal(body.file, 'Todo/Repetida.wav');
  const files = await fs.readdir(path.join(musicDir, 'Todo'));
  assert.equal(files.filter((f) => f.startsWith('Repetida')).length, 1);
});

test('mismo nombre con distinto contenido recibe sufijo (2)', async () => {
  assert.equal((await upload(wav(4410, 1), 'Igual.wav')).status, 201);
  const res = await upload(wav(4410, 2), 'Igual.wav');
  assert.equal(res.status, 201);
  assert.equal((await res.json()).file, 'Todo/Igual (2).wav');
});

test('funciona también si tailscale serve recorta el prefijo', async () => {
  const res = await upload(wav(4410, 3), 'Sin prefijo.wav', { prefix: '' });
  assert.equal(res.status, 201);
});

test('rechaza extensiones que no son audio', async () => {
  const res = await upload(Buffer.from('#!/bin/sh'), 'script.sh');
  assert.equal(res.status, 415);
  assert.deepEqual(await tmpEntries(), []);
});

test('rechaza contenido que no es audio aunque tenga extensión de audio', async () => {
  const res = await upload(Buffer.from('esto no es un flac'), 'falso.flac');
  assert.equal(res.status, 422);
  assert.deepEqual(await tmpEntries(), []);
  await assert.rejects(fs.access(path.join(musicDir, 'Todo', 'falso.flac')));
});

test('rechaza archivos diminutos que music-metadata no reconoce pero no hacen fallar al parser', async () => {
  for (const name of ['hola.flac', 'hola.mp3', 'hola.opus', 'hola.m4a']) {
    const res = await upload(Buffer.from('hola\n'), name);
    assert.equal(res.status, 422, name);
  }
  assert.deepEqual(await tmpEntries(), []);
});

test('rechaza archivos que superan el límite', async () => {
  const res = await upload(wav(600_000), 'enorme.wav'); // ~1.2 MB > 1 MB
  assert.equal(res.status, 413);
  assert.deepEqual(await tmpEntries(), []);
});

test('rechaza peticiones sin multipart o sin el campo file', async () => {
  const headers = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${baseUrl}/upload`, { method: 'POST', headers, body: 'hola' })).status, 415);

  const form = new FormData();
  form.append('otro', 'valor');
  assert.equal((await fetch(`${baseUrl}/upload`, { method: 'POST', headers, body: form })).status, 400);
});
