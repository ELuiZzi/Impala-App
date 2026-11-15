import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shiftLines } from '../src/library.js';
import { mapTime, normalizeKeep } from '../src/trimmer.js';

test('normalizeKeep ordena, redondea y recorta al final de la canción', () => {
  assert.deepEqual(normalizeKeep([[100, 300], [5.12345, 50]], 200), [[5.123, 50], [100, 200]]);
});

test('normalizeKeep rechaza tramos solapados, vacíos, casi nada o sin cambios', () => {
  assert.throws(() => normalizeKeep([[0, 50], [40, 80]], 100), { status: 400 });
  assert.throws(() => normalizeKeep([[10, 10]], 100), { status: 400 });
  assert.throws(() => normalizeKeep([[0, 0.5]], 100), { status: 400 });
  assert.throws(() => normalizeKeep([[0, 100]], 100), { status: 400 });
  assert.throws(() => normalizeKeep([], 100), { status: 400 });
  assert.throws(() => normalizeKeep('0-10', 100), { status: 400 });
});

test('mapTime: quita lo eliminado antes y descarta lo que cae en un corte', () => {
  // Se quitan los primeros 10 s y el tramo 60-90 s.
  const keep = [[10, 60], [90, 200]];
  assert.equal(mapTime(5_000, keep), null); // en la intro quitada
  assert.equal(mapTime(10_000, keep), 0);
  assert.equal(mapTime(30_000, keep), 20_000);
  assert.equal(mapTime(70_000, keep), null); // en el corte interno
  assert.equal(mapTime(100_000, keep), 60_000); // 100 - 10 - 30
  assert.equal(mapTime(250_000, keep), null); // en el final quitado
});

test('shiftLines mueve líneas y palabras; las no sincronizadas se quedan igual', () => {
  const keep = [[10, 200]];
  const lines = [
    { timeMs: 2_000, text: 'intro' },
    { timeMs: 12_000, text: 'hola', words: [{ timeMs: 12_000, text: 'hola' }] },
    { timeMs: null, text: 'sin tiempo' },
  ];
  assert.deepEqual(shiftLines(lines, keep), [
    { timeMs: 2_000, text: 'hola', words: [{ timeMs: 2_000, text: 'hola' }] },
    { timeMs: null, text: 'sin tiempo' },
  ]);
});
