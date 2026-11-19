// Pruebas del motor de Descubrir con radios falsas: `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTIST_GAP, BAN_SCORE, DiscoverEngine, EXPLORE_EVERY, artistKey, emptyLearned } from '../src/discover/engine.ts';

/** Generador pseudoaleatorio con semilla, para que las pruebas den siempre lo mismo. */
function rng(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

const track = (videoId, artist, source = 'radio', seed) => ({ videoId, title: `T ${videoId}`, artist, album: null, durationSec: 200, thumbnail: null, explicit: false, source, seed });

/** Radio falsa: 30 canciones por semilla, de 15 artistas compartidos entre semillas (como en la vida real). */
function fakeDeps({ seeds = ['s1', 's2', 's3'], radioSize = 30, exploreSize = 20, owned = () => false } = {}) {
  const calls = { radio: [], explore: 0 };
  return {
    calls,
    deps: {
      radio: async (id) => {
        calls.radio.push(id);
        return Array.from({ length: radioSize }, (_, i) => track(`${id}-${i}`, `Artista ${(i * 7 + id.length) % 15}`, 'radio', id));
      },
      explore: async () => {
        calls.explore++;
        return Array.from({ length: exploreSize }, (_, i) => track(`x${calls.explore}-${i}`, `Explora ${i % 10}`, 'explore', 'Calma'));
      },
      librarySeeds: async () => seeds,
      owned,
      random: rng(),
      now: () => 1_000_000,
    },
  };
}

test('llena la cola sin repetidos, mezclando semillas y con exploración cada EXPLORE_EVERY', async () => {
  const { deps } = fakeDeps();
  const e = new DiscoverEngine(deps);
  await e.fill(20);
  const q = e.upcoming();
  assert.equal(q.length, 20);
  assert.equal(new Set(q.map((t) => t.videoId)).size, 20);
  q.forEach((t, i) => {
    if ((i + 1) % EXPLORE_EVERY === 0) assert.equal(t.source, 'explore', `posición ${i}`);
  });
  const fromRadios = q.filter((t) => t.source === 'radio');
  assert.ok(new Set(fromRadios.map((t) => t.seed)).size >= 2, 'usa más de una semilla');
});

test('nunca el mismo artista en ARTIST_GAP canciones seguidas', async () => {
  const { deps } = fakeDeps();
  const e = new DiscoverEngine(deps);
  const shown = [];
  for (let i = 0; i < 40; i++) shown.push(await e.next());
  for (let i = 0; i < shown.length; i++) {
    const window = shown.slice(Math.max(0, i - ARTIST_GAP + 1), i).map((t) => artistKey(t.artist));
    assert.ok(!window.includes(artistKey(shown[i].artist)), `${shown[i].artist} repetido en ${i}`);
  }
});

test('100 canciones sin repetir, también tras reabrir con lo guardado', async () => {
  const { deps } = fakeDeps({ seeds: ['a', 'b', 'c', 'd', 'e', 'f'] });
  const e = new DiscoverEngine(deps);
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push((await e.next()).videoId);
  // Reabrir: un motor nuevo con lo aprendido no repite lo ya visto.
  const again = new DiscoverEngine(fakeDeps({ seeds: ['a', 'b', 'c', 'd', 'e', 'f'] }).deps, e.state());
  for (let i = 0; i < 40; i++) {
    const t = await again.next();
    assert.ok(t, `quedan canciones en ${i}`);
    ids.push(t.videoId);
  }
  assert.equal(new Set(ids).size, 100);
});

test('no ofrece lo que ya está en la biblioteca', async () => {
  const { deps } = fakeDeps({ owned: (t) => t.videoId.endsWith('-1') || t.videoId.endsWith('-2') });
  const e = new DiscoverEngine(deps);
  await e.fill(15);
  assert.ok(e.upcoming().every((t) => !t.videoId.endsWith('-1') && !t.videoId.endsWith('-2')));
});

test('«me gusta»: la canción pasa a ser semilla y su artista sube', async () => {
  const { deps, calls } = fakeDeps({ seeds: ['s1'] });
  const e = new DiscoverEngine(deps);
  const t = await e.next();
  e.feedback(t, 'like');
  assert.equal(e.state().likes[0].videoId, t.videoId);
  assert.equal(e.state().artists[artistKey(t.artist)], 2);
  // Al agotarse las radios cargadas, la siguiente semilla es el «me gusta».
  for (let i = 0; i < 30; i++) await e.next();
  assert.ok(calls.radio.includes(t.videoId), 'pidió la radio de la canción que gustó');
});

test('pasar rápido baja al artista y a BAN_SCORE no vuelve a salir; pasar tras escucharla, no', async () => {
  const { deps } = fakeDeps();
  const e = new DiscoverEngine(deps);
  const t = await e.next();
  e.feedback(t, 'skip', 20_000); // la escuchó un rato: no cuenta en contra
  assert.equal(e.state().artists[artistKey(t.artist)] ?? 0, 0);
  for (let i = 0; i < -BAN_SCORE; i++) e.feedback(t, 'skip', 1000);
  assert.equal(e.state().artists[artistKey(t.artist)], BAN_SCORE);
  for (let i = 0; i < 40; i++) {
    const n = await e.next();
    if (!n) break;
    assert.notEqual(artistKey(n.artist), artistKey(t.artist));
  }
});

test('escucharla entera sube al artista (con tope)', async () => {
  const { deps } = fakeDeps();
  const e = new DiscoverEngine(deps);
  const t = await e.next();
  for (let i = 0; i < 10; i++) e.feedback(t, 'complete');
  assert.equal(e.state().artists[artistKey(t.artist)], 5);
});

test('sin semillas ni exploración: devuelve null sin quedarse en bucle', async () => {
  const e = new DiscoverEngine({
    radio: async () => [],
    explore: async () => [],
    librarySeeds: async () => [],
    owned: () => false,
    random: rng(),
  });
  assert.equal(await e.next(), null);
});

test('sin red (todo falla): null, sin lanzar', async () => {
  const fail = async () => {
    throw new Error('sin red');
  };
  const e = new DiscoverEngine({ radio: fail, explore: fail, librarySeeds: fail, owned: () => false, random: rng() });
  assert.equal(await e.next(), null);
});

test('reiniciar olvida lo aprendido', async () => {
  const { deps } = fakeDeps();
  const e = new DiscoverEngine(deps, { ...emptyLearned(), artists: { x: 3 } });
  await e.next();
  e.reset();
  assert.deepEqual(e.state(), emptyLearned());
});

test('artistKey: primer artista, sin acentos ni signos', () => {
  assert.equal(artistKey('Daft Punk & Julian Casablancas'), 'daft punk');
  assert.equal(artistKey('Jesús Adrián Romero feat. Marcela Gándara'), 'jesus adrian romero');
  assert.equal(artistKey('Bad Bunny, Jhay Cortez'), 'bad bunny');
  assert.equal(artistKey('Shakira x Bizarrap'), 'shakira');
});

// --- La mejor parte (coro de la letra sincronizada) ---
import { bestPartMs, chorusStartMs, parseSynced } from '../src/discover/bestPart.ts';

const L = (pairs) => pairs.map(([s, text]) => ({ timeMs: s * 1000, text }));

test('el coro: la línea con sentido que más se repite, tras la intro, desde el inicio de su bloque', () => {
  const lines = L([
    [5, 'Oh oh oh'], [10, 'Primera estrofa aquí'], [20, 'Sigue la historia'],
    [40, 'Y cuando vuelvas'], [44, 'te voy a querer'], [48, 'te voy a querer'],
    [60, 'Segunda estrofa'], [80, 'Y cuando vuelvas'], [84, 'te voy a querer'], [88, 'te voy a querer'],
    [120, 'Y cuando vuelvas'], [124, 'te voy a querer'],
  ]);
  // 2 s antes de «Y cuando vuelvas» (el bloque), no de «te voy a querer».
  assert.equal(chorusStartMs(lines, 200_000), 38_000);
});

test('el coro no se toma de la intro (primer 10 %) ni de «oh oh oh»', () => {
  const lines = L([
    [3, 'Dame tu amor'], [8, 'Na na na'], [12, 'Na na na'], [14, 'Na na na'],
    [50, 'Estrofa'], [70, 'Dame tu amor'], [110, 'Dame tu amor'],
  ]);
  assert.equal(chorusStartMs(lines, 200_000), 68_000);
});

test('sin coro claro o sin letra: el 30 %; sin duración, 0', () => {
  assert.equal(chorusStartMs(L([[10, 'Una línea'], [20, 'Otra distinta']]), 100_000), null);
  assert.equal(bestPartMs(L([[10, 'Una línea'], [20, 'Otra distinta']]), 100_000), 30_000);
  assert.equal(bestPartMs(null, 200_000), 60_000);
  assert.equal(bestPartMs(null, null), 0);
});

test('parseSynced: marcas de tiempo, varias por línea y LRC mejorado', () => {
  const lines = parseSynced('[00:01.50]Hola\n[01:02.3][02:00.00]Coro <01:02.50>con palabras\n[ar:Alguien]\nsin tiempo');
  assert.deepEqual(lines, [
    { timeMs: 1500, text: 'Hola' },
    { timeMs: 62_300, text: 'Coro con palabras' },
    { timeMs: 120_000, text: 'Coro con palabras' },
  ]);
});

// --- Filtros ---
import { allowedByFilters, defaultFilters, guessLanguage, lyricsLanguage } from '../src/discover/filters.ts';

test('idioma por el título: claro en español o inglés, y null si no se sabe', () => {
  assert.equal(guessLanguage('Me Dice Que Me Ama'), 'es');
  assert.equal(guessLanguage('Ya Me Voy para Siempre'), 'es');
  assert.equal(guessLanguage('Corazón'), 'es');
  assert.equal(guessLanguage("Don't Stop Me Now"), 'en');
  assert.equal(guessLanguage('Wake Me Up'), null);
  assert.equal(guessLanguage('Despacito'), null);
  assert.equal(guessLanguage('Get Lucky'), null);
  assert.equal(guessLanguage('Shape of You'), 'en');
});

test('idioma por la letra: hace falta ventaja clara', () => {
  const en = L([[1, "I'm in love with the shape of you"], [2, 'We push and pull like a magnet do'], [3, 'Although my heart is falling too'], [4, "I'm in love with your body"]]);
  const es = L([[1, 'Quiero respirar tu cuello despacito'], [2, 'Deja que te diga cosas al oído'], [3, 'Para que te acuerdes si no estás conmigo'], [4, 'Oh yeah baby']]);
  assert.equal(lyricsLanguage(en), 'en');
  assert.equal(lyricsLanguage(es), 'es');
});

test('filtros: explícitas fuera; «solo en español» quita lo claramente en inglés, no lo dudoso', () => {
  const t = (title, explicit = false) => ({ ...track('v', 'A'), title, explicit });
  const f = { ...defaultFilters(), spanishOnly: true, noExplicit: true };
  assert.equal(allowedByFilters(t('Te Amo'), f), true);
  assert.equal(allowedByFilters(t('Despacito'), f), true);
  assert.equal(allowedByFilters(t('Shape of You'), f), false);
  assert.equal(allowedByFilters(t('Te Amo', true), f), false);
  assert.equal(allowedByFilters(t('Shape of You', true), defaultFilters()), true);
  assert.equal(allowedByFilters(t('のバレてます！？'), f), false);
  assert.equal(allowedByFilters(t('Corazón'), f), true);
});

test('motor: «allow» filtra y sin lo personal no usa los «me gusta» como semilla', async () => {
  const { deps, calls } = fakeDeps({ seeds: ['g1', 'g2', 'g3'] });
  const e = new DiscoverEngine({ ...deps, allow: (x) => !x.videoId.endsWith('-0'), personal: () => false }, { ...emptyLearned(), likes: [track('liked', 'X')] });
  await e.fill(10);
  assert.ok(e.upcoming().every((x) => !x.videoId.endsWith('-0')));
  assert.ok(!calls.radio.includes('liked'), 'no pidió la radio del «me gusta»');
});

test('restart: tira la cola preparada y vuelve a pedir semillas', async () => {
  let seeds = ['a1', 'a2', 'a3'];
  const { deps, calls } = fakeDeps();
  const e = new DiscoverEngine({ ...deps, librarySeeds: async () => seeds });
  await e.fill(5);
  seeds = ['b1', 'b2', 'b3'];
  e.restart();
  assert.equal(e.upcoming().length, 0);
  await e.fill(5);
  assert.ok(calls.radio.some((id) => id.startsWith('b')));
});
