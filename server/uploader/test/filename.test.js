import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateName, sanitizeFilename } from '../src/filename.js';

test('limpia guiones y espacios sueltos en los extremos (nombres de Stacher)', () => {
  assert.deepEqual(sanitizeFilename('- Tame Impala - Let it happen • sped up -.opus'), {
    base: 'Tame Impala - Let it happen • sped up',
    ext: '.opus',
  });
});

test('conserva nombres normales y normaliza la extensión', () => {
  assert.deepEqual(sanitizeFilename('Tame Impala - Stranger In Moscow (Remastered).FLAC'), {
    base: 'Tame Impala - Stranger In Moscow (Remastered)',
    ext: '.flac',
  });
});

test('descarta rutas enviadas por el cliente (sin path traversal)', () => {
  assert.equal(sanitizeFilename('../../etc/cancion.mp3').base, 'cancion');
  assert.equal(sanitizeFilename('C:\\Users\\x\\Música\\cancion.mp3').base, 'cancion');
});

test('reemplaza caracteres reservados y de control', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h\u0007.mp3').base, 'a b c d e f g h');
});

test('rechaza extensiones que no son audio', () => {
  assert.equal(sanitizeFilename('script.sh'), null);
  assert.equal(sanitizeFilename('cancion'), null);
  assert.equal(sanitizeFilename('.flac'), null);
});

test('usa un nombre por defecto si no queda nada', () => {
  assert.equal(sanitizeFilename('---.mp3').base, 'Sin título');
});

test('recorta nombres larguísimos sin partir caracteres multibyte', () => {
  const { base } = sanitizeFilename(`${'ñ'.repeat(300)}.flac`);
  assert.ok(Buffer.byteLength(base) <= 200);
  assert.equal(base, 'ñ'.repeat(100));
});

test('genera sufijos para nombres repetidos', () => {
  const name = { base: 'Canción', ext: '.flac' };
  assert.equal(candidateName(name, 1), 'Canción.flac');
  assert.equal(candidateName(name, 2), 'Canción (2).flac');
});
