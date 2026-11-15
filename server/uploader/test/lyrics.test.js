import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLyrics, parseLrc } from '../src/lyrics.js';

const creds = { u: 'luis', t: 'tok', s: 'salt' };

test('parseLrc: marcas de tiempo, varias por línea, offset y líneas sin marca', () => {
  const lines = parseLrc('[ar:Tame Impala]\n[offset:+500]\n[00:12.50]Primera\n[01:02.3][02:00.00]Coro\nsin marca\n[00:30]Sin decimales');
  assert.deepEqual(lines, [
    { timeMs: 12000, text: 'Primera' },
    { timeMs: 29500, text: 'Sin decimales' },
    { timeMs: 61800, text: 'Coro' },
    { timeMs: 119500, text: 'Coro' },
  ]);
});

test('parseLrc: LRC mejorado con tiempos por palabra', () => {
  const [line] = parseLrc('[00:10.00]<00:10.00>So <00:10.40>hold <00:11.05>on');
  assert.deepEqual(line, {
    timeMs: 10000,
    text: 'So hold on',
    words: [{ timeMs: 10000, text: 'So' }, { timeMs: 10400, text: 'hold' }, { timeMs: 11050, text: 'on' }],
  });
});

test('parseLrc: quita las marcas de voz ("v1:", "v2:") del inicio de cada línea', () => {
  const lines = parseLrc('[00:01.00]v1:I didn\'t want\n[00:02.00]v2: Segunda voz\n[00:03.00]v1:<00:03.00>So <00:03.40>hold\n[00:04.00]Ver v1: dentro');
  assert.deepEqual(lines.map((l) => l.text), ['I didn\'t want', 'Segunda voz', 'So hold', 'Ver v1: dentro']);
  assert.deepEqual(lines[2].words, [{ timeMs: 3000, text: 'So' }, { timeMs: 3400, text: 'hold' }]);
});

test('letras: las marcas de voz se quitan de las del archivo y de las cachés antiguas', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-lyrics-'));
  // Caché escrita por una versión anterior, con la marca todavía en el texto.
  await fs.writeFile(path.join(cacheDir, 'vieja.json'), JSON.stringify({
    source: 'file', synced: true, fetchedAt: Date.now(),
    lines: [{ timeMs: 1000, text: 'v1:Hola' }, { timeMs: 2000, text: 'v1:So hold', words: [{ timeMs: 2000, text: 'v1:So' }, { timeMs: 2400, text: 'hold' }] }],
  }));
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } });
    if (u.pathname.endsWith('/getSong')) return ok({ song: { id: 'nueva', title: 'X', artist: 'Y', duration: 100 } });
    if (u.pathname.endsWith('/getLyricsBySongId')) return ok({ lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 500, value: 'v1:Del archivo' }] }] } });
    throw new Error(`inesperado: ${url}`);
  };
  const lyrics = createLyrics({ navidromeUrl: 'http://nd', cacheDir, fetchImpl });
  assert.deepEqual(await lyrics.get('vieja', creds), {
    source: 'file', synced: true,
    lines: [{ timeMs: 1000, text: 'Hola' }, { timeMs: 2000, text: 'So hold', words: [{ timeMs: 2000, text: 'So' }, { timeMs: 2400, text: 'hold' }] }],
  });
  assert.deepEqual((await lyrics.get('nueva', creds)).lines, [{ timeMs: 500, text: 'Del archivo' }]);
});

test('letras: primero las del archivo; si no hay, LRCLIB por duración; y se guardan en caché', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-lyrics-'));
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } });
    if (u.pathname.endsWith('/getSong')) {
      const id = u.searchParams.get('id');
      return ok({ song: { id, title: id === 'conletra' ? 'Con letra' : 'Let It Happen', artist: 'Tame Impala', album: 'Currents', duration: 467 } });
    }
    if (u.pathname.endsWith('/getLyricsBySongId')) {
      if (u.searchParams.get('id') !== 'conletra') return ok({ lyricsList: { structuredLyrics: [] } });
      return ok({ lyricsList: { structuredLyrics: [{ synced: true, offset: 0, line: [{ start: 1000, value: 'Del archivo' }] }] } });
    }
    if (u.hostname === 'lrclib.net' && u.pathname === '/api/get') return new Response('', { status: 404 });
    if (u.hostname === 'lrclib.net' && u.pathname === '/api/search') {
      return Response.json([
        { artistName: 'Tame Impala', duration: 300, syncedLyrics: '[00:01.00]Otra versión' },
        { artistName: 'Tame Impala', duration: 468, syncedLyrics: '[00:05.00]It\'s always around me' },
      ]);
    }
    throw new Error(`inesperado: ${url}`);
  };
  const lyrics = createLyrics({ navidromeUrl: 'http://nd', cacheDir, fetchImpl });

  assert.deepEqual(await lyrics.get('conletra', creds), { source: 'file', synced: true, lines: [{ timeMs: 1000, text: 'Del archivo' }] });
  assert.ok(!calls.some((p) => p.startsWith('/api/')), 'con letra en el archivo no se consulta LRCLIB');

  const lrc = await lyrics.get('sinletra', creds);
  assert.deepEqual(lrc, { source: 'lrclib', synced: true, lines: [{ timeMs: 5000, text: 'It\'s always around me' }] });

  // Un proceso nuevo lee la caché del disco sin volver a preguntar.
  calls.length = 0;
  const again = createLyrics({ navidromeUrl: 'http://nd', cacheDir, fetchImpl });
  assert.deepEqual(await again.get('sinletra', creds), lrc);
  assert.deepEqual(calls, []);
  await assert.rejects(lyrics.get('../etc/passwd', creds), { status: 400 });
});

test('LRCLIB: si `get` responde 503 se sigue buscando con `search`', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-lyrics-'));
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } });
    if (u.pathname.endsWith('/getSong')) return ok({ song: { id: 'x', title: 'Let It Happen', artist: 'Tame Impala', album: 'Currents', duration: 467 } });
    if (u.pathname.endsWith('/getLyricsBySongId')) return ok({ lyricsList: { structuredLyrics: [] } });
    if (u.pathname === '/api/get') return new Response('', { status: 503 });
    if (u.pathname === '/api/search') return Response.json([{ duration: 467, syncedLyrics: '[00:02.00]Hola' }]);
    throw new Error(`inesperado: ${url}`);
  };
  const lyrics = createLyrics({ navidromeUrl: 'http://nd', cacheDir, fetchImpl });
  assert.deepEqual(await lyrics.get('x', creds), { source: 'lrclib', synced: true, lines: [{ timeMs: 2000, text: 'Hola' }] });
});
