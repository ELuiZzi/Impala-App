import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlaylistPage, parsePlaylistUrl, readApplePlaylist } from '../src/applemusic.js';
import { createImporter } from '../src/importer.js';
import { bestMatch, coreTitle, matchScore, normalize } from '../src/match.js';

/** Página mínima con la misma forma que la de music.apple.com (datos en "serialized-server-data"). */
function applePage(tracks, { trackCount = tracks.length } = {}) {
  const data = {
    data: [{
      data: {
        sections: [
          {
            itemKind: 'containerDetailHeaderLockup',
            items: [{ title: 'Mi playlist', trackCount, subtitleLinks: [{ title: 'Luis' }], artwork: { dictionary: { url: 'https://is1.mzstatic.com/a/{w}x{h}bb.{f}' } } }],
          },
          {
            itemKind: 'trackLockup',
            items: tracks.map(([title, artist, album, ms]) => ({
              title,
              artistName: artist,
              tertiaryLinks: [{ title: album }],
              duration: ms,
              showExplicitBadge: false,
              artwork: { dictionary: { url: 'https://is1.mzstatic.com/t/{w}x{h}bb.{f}' } },
            })),
          },
        ],
      },
    }],
  };
  return `<html><script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script></html>`;
}

test('enlaces de Apple Music: con o sin nombre, compartidos; rechaza otros sitios', () => {
  assert.deepEqual(parsePlaylistUrl('https://music.apple.com/mx/playlist/mi-lista/pl.u-AbCdEf123456?l=en'), {
    storefront: 'mx', id: 'pl.u-AbCdEf123456', url: 'https://music.apple.com/mx/playlist/pl.u-AbCdEf123456',
  });
  assert.equal(parsePlaylistUrl(' https://music.apple.com/us/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb ').id, 'pl.f4d106fed2bd41149aaacabb233eb5eb');
  for (const bad of ['https://evil.example/us/playlist/pl.u-AbCdEf123456', 'http://music.apple.com/us/playlist/pl.u-AbCdEf123456', 'https://music.apple.com/us/album/x/123', 'nada']) {
    assert.throws(() => parsePlaylistUrl(bad), { status: 400 }, bad);
  }
  assert.throws(() => parsePlaylistUrl('https://music.apple.com/library/playlist/p.5YUbkLND32'), /biblioteca/);
});

test('lee nombre, carátula y canciones de la página pública', () => {
  const playlist = parsePlaylistPage(applePage([['Let It Happen', 'Tame Impala', 'Currents', 467_500], ['Halo', 'Beyoncé', 'I Am... Sasha Fierce - Single', 261_000]]));
  assert.equal(playlist.name, 'Mi playlist');
  assert.equal(playlist.curator, 'Luis');
  assert.equal(playlist.artwork, 'https://is1.mzstatic.com/a/600x600bb.jpg');
  assert.deepEqual(playlist.tracks[1], { title: 'Halo', artist: 'Beyoncé', album: 'I Am... Sasha Fierce', durationSec: 261, explicit: false, artwork: 'https://is1.mzstatic.com/t/300x300bb.jpg' });
  assert.throws(() => parsePlaylistPage('<html></html>'), { status: 502 });
  assert.throws(() => parsePlaylistPage(applePage([])), { status: 422 });
});

test('playlist privada o inexistente → 404 legible', async () => {
  const fetchImpl = async () => new Response('', { status: 404 });
  await assert.rejects(readApplePlaylist('https://music.apple.com/us/playlist/pl.u-AbCdEf123456', { fetchImpl }), { status: 404 });
});

test('emparejar: acentos, feat., remasterizaciones y versiones distintas', () => {
  assert.equal(normalize('Beyoncé — HALO!'), 'beyonce halo');
  assert.equal(coreTitle('Get Lucky (feat. Pharrell Williams) - Radio Edit'), 'Get Lucky');
  const target = { title: 'Get Lucky (feat. Pharrell Williams)', artist: 'Daft Punk & Pharrell Williams', durationSec: 248 };
  assert.ok(matchScore(target, { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 249 }) >= 0.9);
  assert.equal(matchScore(target, { title: 'Get Lucky', artist: 'Otro Artista' }), 0);
  assert.equal(matchScore(target, { title: 'Lucky', artist: 'Daft Punk' }), 0);
  // Un remix o una versión en vivo no es la canción original.
  assert.ok(matchScore({ title: 'Halo', artist: 'Beyoncé' }, { title: 'Halo (Live)', artist: 'Beyonce' }) < 0.9);
  assert.ok(matchScore({ title: 'Halo', artist: 'Beyoncé', durationSec: 261 }, { title: 'Halo', artist: 'Beyoncé', durationSec: 400 }) < 0.9);
  const best = bestMatch({ title: 'Halo', artist: 'Beyoncé', durationSec: 261 }, [
    { id: 'remix', title: 'Halo (Remix)', artist: 'Beyoncé', durationSec: 261 },
    { id: 'ok', title: 'Halo', artist: 'Beyoncé', durationSec: 262 },
  ]);
  assert.equal(best.id, 'ok');
});

test('importar: empareja con la biblioteca, descarga lo que falta y crea la playlist en orden', async () => {
  const creds = { u: 'luis', t: 'tok', s: 'salt' };
  const library = [{ id: 'nd-1', title: 'Let It Happen', artist: 'Tame Impala', duration: 467, path: '/music/Todo/Tame Impala - Let It Happen.opus' }];
  const created = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const endpoint = u.pathname.split('/').pop();
    assert.equal(u.searchParams.get('u'), 'luis');
    if (endpoint === 'search3') {
      const q = u.searchParams.get('query').toLowerCase();
      const song = library.filter((s) => s.title.toLowerCase().includes(q));
      return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: { song } } });
    }
    if (endpoint === 'getPlaylists') {
      // Ya había una playlist con ese nombre (una importación anterior): se actualiza, no se duplica.
      return Response.json({ 'subsonic-response': { status: 'ok', playlists: { playlist: [{ id: 'pl-old', name: 'Importada', owner: 'luis' }, { id: 'pl-ajena', name: 'Importada', owner: 'otro' }] } } });
    }
    if (endpoint === 'createPlaylist') {
      created.push({ playlistId: u.searchParams.get('playlistId'), name: u.searchParams.get('name'), songIds: u.searchParams.getAll('songId') });
      return Response.json({ 'subsonic-response': { status: 'ok', playlist: { id: 'pl-1' } } });
    }
    throw new Error(`inesperado: ${endpoint}`);
  };
  const enqueued = [];
  const youtube = {
    matchSongs: async (queries) => queries.map((q) => (q.includes('Halo') ? [{ id: 'hhhhhhhhhhh', title: 'Halo', artist: 'Beyoncé', durationSec: 262 }] : [])),
    enqueue: (id, hint) => {
      enqueued.push({ id, hint });
      // Navidrome indexa el archivo en cuanto termina la descarga.
      library.push({ id: 'nd-2', title: 'Halo', artist: 'Beyoncé', duration: 262, path: '/music/Todo/Beyoncé - Halo.opus' });
      return { id: 'job-1' };
    },
    get: () => ({ id: 'job-1', status: 'done', file: 'Todo/Beyoncé - Halo.opus' }),
  };
  const importer = createImporter({
    youtube,
    navidromeUrl: 'http://nd',
    fetchImpl,
    pollMs: 1,
    readPlaylist: async () => parsePlaylistPage(applePage([
      ['Halo', 'Beyoncé', 'I Am... Sasha Fierce', 261_000],
      ['Let It Happen', 'Tame Impala', 'Currents', 467_000],
      ['Inexistente', 'Nadie', 'X', 100_000],
    ])),
  });

  const job = importer.create('https://music.apple.com/us/playlist/pl.u-AbCdEf123456', creds);
  const wait = async (status) => {
    for (let i = 0; i < 200; i++) {
      const j = importer.get(job.id, creds);
      if (j.status === status || j.status === 'error') return j;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no llegó a ${status}`);
  };

  const review = await wait('review');
  assert.equal(review.error, null);
  assert.deepEqual(review.tracks.map((t) => t.state), ['youtube', 'library', 'notFound']);
  assert.deepEqual(review.counts, { library: 1, youtube: 1, notFound: 1, skipped: 0, added: 0, failed: 0 });
  assert.throws(() => importer.get(job.id, { ...creds, u: 'otro' }), { status: 404 }, 'cada usuario ve solo las suyas');

  importer.start(job.id, creds, { name: 'Importada' });
  const done = await wait('done');
  assert.equal(done.playlistId, 'pl-old');
  assert.deepEqual(enqueued, [{ id: 'hhhhhhhhhhh', hint: { title: 'Halo', artist: 'Beyoncé', album: 'I Am... Sasha Fierce' } }]);
  assert.deepEqual(created, [{ playlistId: 'pl-old', name: null, songIds: ['nd-2', 'nd-1'] }]);
  assert.throws(() => importer.create('https://music.apple.com/us/playlist/pl.u-x', {}), { status: 400 }, 'requiere credenciales Subsonic');
});

test('importar: reintentar las fallidas y retomar el estado tras un reinicio', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const stateFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'impala-imp-')), 'imports.json');
  const creds = { u: 'luis', t: 'tok', s: 'salt' };
  const library = [];
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const endpoint = u.pathname.split('/').pop();
    if (endpoint === 'search3') {
      const q = u.searchParams.get('query').toLowerCase();
      return Response.json({ 'subsonic-response': { status: 'ok', searchResult3: { song: library.filter((s) => s.title.toLowerCase().includes(q)) } } });
    }
    calls.push({ playlistId: u.searchParams.get('playlistId'), name: u.searchParams.get('name'), songIds: u.searchParams.getAll('songId') });
    return Response.json({ 'subsonic-response': { status: 'ok', playlist: { id: 'pl-1' } } });
  };
  let attempt = 0;
  const youtube = {
    matchSongs: async (queries) => queries.map(() => [{ id: 'hhhhhhhhhhh', title: 'Halo', artist: 'Beyoncé', durationSec: 261 }]),
    enqueue: () => ({ id: `job-${++attempt}` }),
    // La primera vez YouTube bloquea la descarga; al reintentar, funciona.
    get: (id) => {
      if (id === 'job-1') return { id, status: 'error', error: 'YouTube pidió confirmar que no eres un bot.' };
      library.push({ id: 'nd-halo', title: 'Halo', artist: 'Beyoncé', duration: 261, path: '/music/Todo/Beyoncé - Halo.opus' });
      return { id, status: 'done', file: 'Todo/Beyoncé - Halo.opus' };
    },
  };
  const page = parsePlaylistPage(applePage([['Halo', 'Beyoncé', 'I Am... Sasha Fierce', 261_000]]));
  const make = () => createImporter({ youtube, navidromeUrl: 'http://nd', fetchImpl, pollMs: 1, persistDelayMs: 1, stateFile, readPlaylist: async () => page });
  const waitFor = async (importer, id, status) => {
    for (let i = 0; i < 300; i++) {
      const j = importer.get(id, creds);
      if (j.status === status) return j;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no llegó a ${status}`);
  };

  const first = make();
  const { id } = first.create('https://music.apple.com/us/playlist/pl.u-AbCdEf123456', creds);
  await waitFor(first, id, 'review');
  await new Promise((r) => setTimeout(r, 20)); // deja que se escriba el estado

  // "Reinicio": un importador nuevo lee el archivo y retoma la importación donde estaba.
  const second = make();
  assert.equal(second.get(id, creds).status, 'review');
  second.start(id, creds, {});
  // Nada quedó en la biblioteca → error, pero la canción se puede reintentar.
  const failed = await waitFor(second, id, 'error');
  assert.equal(failed.counts.failed, 1);
  second.retry(id, creds);
  const done = await waitFor(second, id, 'done');
  assert.equal(done.counts.added, 1);
  assert.deepEqual(calls.at(-1), { playlistId: null, name: 'Mi playlist', songIds: ['nd-halo'] });

  // Un segundo reintento sin fallidas no tiene sentido.
  assert.throws(() => second.retry(id, creds), { status: 409 });
});

test('importar a una playlist existente: añade solo las que faltan, sin tocar las que ya tenía', async () => {
  const creds = { u: 'luis', t: 'tok', s: 'salt' };
  const updates = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const endpoint = u.pathname.split('/').pop();
    const ok = (body) => Response.json({ 'subsonic-response': { status: 'ok', ...body } });
    if (endpoint === 'search3') {
      const q = u.searchParams.get('query').toLowerCase();
      const library = [
        { id: 'nd-1', title: 'Let It Happen', artist: 'Tame Impala', duration: 467 },
        { id: 'nd-2', title: 'Halo', artist: 'Beyoncé', duration: 261 },
      ];
      return ok({ searchResult3: { song: library.filter((s) => s.title.toLowerCase().includes(q)) } });
    }
    if (endpoint === 'getPlaylist') return ok({ playlist: { id: 'pl-gym', name: 'Gym', owner: 'luis', entry: [{ id: 'nd-1' }] } });
    if (endpoint === 'updatePlaylist') {
      updates.push({ id: u.searchParams.get('playlistId'), add: u.searchParams.getAll('songIdToAdd') });
      return ok({});
    }
    throw new Error(`inesperado: ${endpoint}`);
  };
  const importer = createImporter({
    youtube: { matchSongs: async (q) => q.map(() => []), enqueue: () => ({ id: 'x' }), get: () => null },
    navidromeUrl: 'http://nd',
    fetchImpl,
    pollMs: 1,
    readPlaylist: async () => parsePlaylistPage(applePage([['Let It Happen', 'Tame Impala', 'Currents', 467_000], ['Halo', 'Beyoncé', 'X', 261_000]])),
  });
  const { id } = importer.create('https://music.apple.com/us/playlist/pl.u-AbCdEf123456', creds);
  const wait = async (status) => {
    for (let i = 0; i < 300; i++) {
      const j = importer.get(id, creds);
      if (j.status === status || j.status === 'error') return j;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no llegó a ${status}`);
  };
  await wait('review');
  importer.start(id, creds, { appendTo: 'pl-gym' });
  const done = await wait('done');
  assert.equal(done.error, null);
  assert.equal(done.playlistId, 'pl-gym');
  assert.equal(done.name, 'Gym');
  assert.deepEqual(updates, [{ id: 'pl-gym', add: ['nd-2'] }]);
});
