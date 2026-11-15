import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAnonCookies, parseSetCookie, toNetscape } from '../src/anoncookies.js';

const NOW = Date.parse('2026-10-10T12:00:00Z');

test('parseSetCookie y formato Netscape (omitiendo las caducadas)', () => {
  const visitor = parseSetCookie('VISITOR_INFO1_LIVE=abc; Domain=.youtube.com; Expires=Thu, 08-Apr-2027 17:55:22 GMT; Path=/; Secure; HttpOnly');
  assert.deepEqual(visitor, { name: 'VISITOR_INFO1_LIVE', value: 'abc', domain: '.youtube.com', path: '/', secure: true, expires: 1807206922 });
  const old = parseSetCookie('__Secure-YEC=x; Domain=.youtube.com; Expires=Sun, 14-Jan-2024 17:55:22 GMT; Path=/; Secure');
  const session = parseSetCookie('YSC=s; Domain=youtube.com; Path=/; Secure');
  assert.equal(session.domain, '.youtube.com');
  const text = toNetscape([visitor, old, session], NOW);
  assert.ok(text.startsWith('# Netscape HTTP Cookie File\n'));
  assert.ok(text.includes('.youtube.com\tTRUE\t/\tTRUE\t1807206922\tVISITOR_INFO1_LIVE\tabc'));
  assert.ok(text.includes('\tYSC\ts'));
  assert.ok(!text.includes('__Secure-YEC'), 'las caducadas no se escriben');
});

test('visita anónima: se crea una vez, se reutiliza y solo se renueva tras un minuto', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'impala-anon-')), 'anon.txt');
  let now = NOW;
  let visits = 0;
  const fetchImpl = async () => {
    visits++;
    return new Response('', { headers: [['set-cookie', `VISITOR_INFO1_LIVE=v${visits}; Domain=.youtube.com; Path=/; Secure`], ['set-cookie', 'YSC=y; Domain=.youtube.com; Path=/']] });
  };
  const anon = createAnonCookies({ file, fetchImpl, now: () => now });
  assert.equal(await anon.path(), file);
  assert.equal(await anon.path(), file);
  assert.equal(visits, 1);
  assert.match(await fs.readFile(file, 'utf8'), /VISITOR_INFO1_LIVE\tv1/);

  assert.equal(await anon.rotate(), file);
  assert.equal(visits, 1, 'no se rota en bucle');
  now += 61_000;
  await anon.rotate();
  assert.equal(visits, 2);
  assert.match(await fs.readFile(file, 'utf8'), /VISITOR_INFO1_LIVE\tv2/);
});

test('si YouTube no da cookies de visitante, no se pasa ningún archivo', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'impala-anon-')), 'anon.txt');
  const anon = createAnonCookies({ file, fetchImpl: async () => new Response('') });
  assert.equal(await anon.path(), null);
});
