import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { createYoutube, tagsFor } from '../src/youtube.js';

let root;
let botFailures = 0;
let resolutions = 0;
let destDir;
let tmpDir;
const calls = [];
/** info.json que yt-dlp recibió en la última descarga (de ahí salen los tags). */
let lastInfo = null;

/** Peticiones recibidas por el proceso persistente de ytmusic.py. */
const workerRequests = [];
let workerVideosFail = false;

/** Lo que responde el ytmusic.py simulado a cada comando. */
const ytmusic = {
  search: {
    songs: [
      { id: 'mmmmmmmmmmm', title: 'Let It Happen', artist: 'Tame Impala', album: 'Currents', durationSec: 468, explicit: false, thumbnail: 'https://yt3/x=w226-h226' },
      { id: 'aaaaaaaaaaa', title: 'Repetida en videos', artist: 'X' },
    ],
    albums: [
      { id: 'MPREb_currents', title: 'Currents', artist: 'Tame Impala', year: '2015', type: 'Album', explicit: true, thumbnail: 'https://yt3/c=w226-h226' },
      { id: '--exec', title: 'id inválido' },
    ],
    artists: [
      { id: 'UCGz-eguN8tcic5kUG4s1ZgA', name: 'Tame Impala', thumbnail: 'https://yt3/a=w300-h300' },
      { id: 'no-es-canal', name: 'inválido' },
    ],
  },
  album: {
    title: 'Currents', artist: 'Tame Impala', year: '2015', type: 'Album', thumbnail: 'https://yt3/c=w226-h226', cover: 'https://yt3/c=w544-h544',
    tracks: [
      { id: 'mmmmmmmmmmm', title: 'Let It Happen', artist: 'Tame Impala', album: 'Currents', durationSec: 468, trackNumber: 1 },
      { id: null, title: 'No disponible' },
    ],
  },
  artist: {
    id: 'UCGz-eguN8tcic5kUG4s1ZgA', name: 'Tame Impala', image: 'https://lh3/banner=w2880-h1200',
    songs: [{ id: 'mmmmmmmmmmm', title: 'Let It Happen', artist: 'Tame Impala', album: 'Currents' }, { id: 'x', title: 'id inválido' }],
    albums: [{ id: 'MPREb_currents', title: 'Currents', year: '2015', type: 'Album' }],
    singles: [{ id: 'MPREb_single', title: 'Loser', year: '2025', type: 'Single' }],
  },
  videos: [
    { id: 'aaaaaaaaaaa', title: 'Tame Impala - Let It Happen (Official Audio)', channel: 'Tame Impala', duration: 467.2, view_count: 38464770 },
    { id: 'bbbbbbbbbbb', title: 'Directo', channel: 'Canal', live_status: 'is_live' },
  ],
};

/** Cliente sin JS ni PO token que daría el yt-dlp instalado. */
const audioClient = {
  name: 'VISIONOS', id: 101, version: '1.02', userAgent: 'Mozilla/5.0 (Macintosh…)',
  context: { deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5' },
};

/** yt-dlp simulado: responde según los argumentos, como lo haría el real. */
function fakeSpawn(_cmd, args) {
  calls.push(args);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const finish = (code, out = '', err = '') => setImmediate(() => {
    child.stdout.end(out);
    child.stderr.end(err);
    child.emit('close', code, null);
  });

  const url = args.at(-1);
  if (args[0] === '-I' && args[2] === 'serve') {
    // ytmusic.py serve: proceso persistente, una petición JSON por línea.
    let pendingInput = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => {
      pendingInput += chunk;
      const lines = pendingInput.split('\n');
      pendingInput = lines.pop();
      for (const line of lines) {
        const { id, cmd, args: a } = JSON.parse(line);
        workerRequests.push({ cmd, args: a });
        const reply = (result) => setImmediate(() => child.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`));
        const fail = (error) => setImmediate(() => child.stdout.write(`${JSON.stringify({ id, ok: false, error })}\n`));
        if (cmd === 'search') reply(ytmusic.search);
        else if (cmd === 'album') reply({ ...ytmusic.album, id: a.id });
        else if (cmd === 'artist' || cmd === 'artistByName') (a.name === 'Nadie' ? reply(null) : reply(ytmusic.artist));
        else if (cmd === 'videos') (workerVideosFail ? fail('DownloadError: boom') : reply(ytmusic.videos));
        else if (cmd === 'audioClient') reply(audioClient);
        // match: una lista de canciones por cada búsqueda.
        else reply(a.queries.map(({ query }) => (query.includes('nada') ? [] : [{ id: 'mmmmmmmmmmm', title: query, artist: 'Tame Impala' }])));
      }
    });
  } else if (url.includes('botbotbotbo') && botFailures-- > 0) {
    finish(1, '', 'ERROR: [youtube] botbotbotbo: Sign in to confirm you’re not a bot. Use --cookies\n');
  } else if (args.includes('--print') && args.includes('%(.{url,http_headers})j')) {
    finish(0, JSON.stringify({ url: `https://googlevideo.example/audio?n=${++resolutions}`, http_headers: { 'User-Agent': 'yt' } }));
  } else if (args.includes('--flat-playlist')) {
    const entries = [
      { id: 'aaaaaaaaaaa', title: 'Tame Impala - Let It Happen (Official Audio)', channel: 'Tame Impala', duration: 467.2, view_count: 38464770 },
      { id: 'bbbbbbbbbbb', title: 'Directo', channel: 'Canal', live_status: 'is_live' },
      { id: 'corto', title: 'id inválido' },
    ];
    finish(0, JSON.stringify({ entries }));
  } else if (args.includes('--load-info-json')) {
    const dir = args[args.indexOf('--paths') + 1];
    const file = path.join(dir, 'audio.opus');
    fs.readFile(args[args.indexOf('--load-info-json') + 1], 'utf8').then((info) => {
      lastInfo = JSON.parse(info);
      return fs.writeFile(file, 'OggS-falso');
    }).then(() => {
      child.stdout.write('PROGRESS  50.0%\n');
      finish(0, `PROGRESS 100.0%\nFILE ${file}\n`);
    });
  } else if (url.includes('watch?v=fallaaaaaaa')) {
    finish(1, '', 'ERROR: [youtube] fallaaaaaaa: Video unavailable\n');
  } else {
    finish(0, JSON.stringify({ id: 'ccccccccccc', title: 'Tame Impala - The Less I Know The Better (Official Video)', channel: 'TameImpalaVEVO', duration: 216 }));
  }
  return child;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'impala-yt-'));
  destDir = path.join(root, 'Todo');
  tmpDir = path.join(root, '.impala-tmp');
  await fs.mkdir(destDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });
});

after(() => fs.rm(root, { recursive: true, force: true }));

const youtube = (extra = {}) => createYoutube({ ytDlp: 'yt-dlp', python: 'python', destDir, tmpDir, uploadSubdir: 'Todo', spawnImpl: fakeSpawn, paceMs: [0, 0], innertube: null, ...extra });

async function waitFor(yt, jobId) {
  for (let i = 0; i < 200; i++) {
    const job = yt.list().find((j) => j.id === jobId);
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('el trabajo no terminó');
}

test('búsqueda: canciones de YouTube Music primero, luego videos sin repetir, directos ni ids inválidos', async () => {
  const { results, albums, artists } = await youtube().search('tame impala');
  assert.ok(workerRequests.some((r) => r.cmd === 'videos' && r.args.q === 'tame impala' && r.args.limit === 10));
  assert.ok(workerRequests.some((r) => r.cmd === 'search' && r.args.q === 'tame impala'));
  assert.deepEqual(artists, [{ id: 'UCGz-eguN8tcic5kUG4s1ZgA', name: 'Tame Impala', thumbnail: 'https://yt3/a=w300-h300' }]);
  assert.deepEqual(results.map((r) => [r.kind, r.id]), [['song', 'mmmmmmmmmmm'], ['song', 'aaaaaaaaaaa']]);
  assert.deepEqual(results[0], {
    kind: 'song', id: 'mmmmmmmmmmm', title: 'Let It Happen', artist: 'Tame Impala', album: 'Currents', channel: null,
    durationSec: 468, views: null, explicit: false, thumbnail: 'https://yt3/x=w226-h226',
  });
  assert.deepEqual(albums, [{ id: 'MPREb_currents', title: 'Currents', artist: 'Tame Impala', year: 2015, type: 'Album', explicit: true, thumbnail: 'https://yt3/c=w226-h226' }]);
});

test('álbum: pistas reproducibles con su número; rechaza ids que no son de álbum', async () => {
  const album = await youtube().album('MPREb_currents');
  assert.equal(album.cover, 'https://yt3/c=w544-h544');
  assert.deepEqual(album.tracks.map((t) => [t.id, t.trackNumber, t.album]), [['mmmmmmmmmmm', 1, 'Currents']]);
  await assert.rejects(youtube().album('--exec=rm'), { status: 400 });
});

test('descarga de un álbum: los tags del álbum sustituyen a los de YouTube', async () => {
  const yt = youtube();
  const job = await waitFor(yt, yt.enqueue('ccccccccccc', { title: 'The Less I Know The Better', artist: 'Tame Impala', album: 'Currents', albumArtist: 'Tame Impala', trackNumber: 7, year: 2015 }).id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(lastInfo.album, 'Currents');
  assert.equal(lastInfo.album_artist, 'Tame Impala');
  assert.equal(lastInfo.track_number, 7);
  assert.equal(lastInfo.meta_date, '2015');
});

test('matchSongs: una lista por búsqueda, en una sola petición', async () => {
  const yt = youtube();
  const before = workerRequests.length;
  const results = await yt.matchSongs(['Tame Impala Let It Happen', 'nada']);
  assert.equal(workerRequests.length - before, 1);
  assert.deepEqual(results.map((r) => r.map((s) => s.id)), [['mmmmmmmmmmm'], []]);
});

test('un solo proceso de ytmusic para todas las peticiones; búsquedas y álbumes en caché', async () => {
  const yt = youtube();
  const spawnsBefore = calls.filter((a) => a[2] === 'serve').length;
  const requestsBefore = workerRequests.length;
  await yt.search('Caché');
  await yt.search('caché'); // misma búsqueda: no se repite
  await yt.album('MPREb_currents');
  await yt.album('MPREb_currents');
  assert.equal(calls.filter((a) => a[2] === 'serve').length - spawnsBefore, 0, 'el proceso ya estaba lanzado');
  assert.deepEqual(workerRequests.slice(requestsBefore).map((r) => r.cmd).sort(), ['album', 'search', 'videos']);
});

test('artista: canciones populares, álbumes y sencillos, por id o por nombre', async () => {
  const yt = youtube();
  const artist = await yt.artist({ id: 'UCGz-eguN8tcic5kUG4s1ZgA' });
  assert.equal(artist.name, 'Tame Impala');
  assert.equal(artist.image, 'https://lh3/banner=w2880-h1200');
  assert.deepEqual(artist.songs.map((s) => s.id), ['mmmmmmmmmmm']);
  assert.deepEqual(artist.albums.map((a) => [a.id, a.year]), [['MPREb_currents', 2015]]);
  assert.deepEqual(artist.singles.map((a) => a.type), ['Single']);
  assert.equal((await yt.artist({ name: 'Tame Impala' })).id, 'UCGz-eguN8tcic5kUG4s1ZgA');
  await assert.rejects(yt.artist({ name: 'Nadie' }), { status: 404 });
  await assert.rejects(yt.artist({ id: '--exec' }), { status: 400 });
  await assert.rejects(yt.artist({ name: ' ' }), { status: 400 });
});

test('cliente de audio para el teléfono: el de yt-dlp, en caché; null sin ytmusicapi', async () => {
  const yt = youtube();
  const before = workerRequests.length;
  assert.deepEqual(await yt.audioClient(), audioClient);
  assert.deepEqual(await yt.audioClient(), audioClient);
  assert.equal(workerRequests.slice(before).filter((r) => r.cmd === 'audioClient').length, 1);
  assert.equal(await youtube({ python: null, ytWorker: null }).audioClient(), null);
});

test('si el proceso no puede buscar videos, se usa yt-dlp por línea de comandos', async () => {
  workerVideosFail = true;
  try {
    const { results } = await youtube().search('solo videos', 'videos');
    assert.ok(calls.some((a) => a.at(-1) === 'ytsearch10:solo videos'));
    assert.deepEqual(results.map((r) => r.id), ['aaaaaaaaaaa']);
  } finally {
    workerVideosFail = false;
  }
});

test('scope music no busca videos', async () => {
  const yt = youtube();
  const before = workerRequests.length;
  const { results } = await yt.search('solo musica', 'music');
  assert.deepEqual(workerRequests.slice(before).map((r) => r.cmd), ['search']);
  assert.ok(results.every((r) => r.kind === 'song'));
  await assert.rejects(yt.search('x', 'todo'), { status: 400 });
});

test('búsqueda sin intérprete de ytmusicapi: solo videos', async () => {
  const { results, albums } = await youtube({ python: null }).search('tame impala');
  assert.deepEqual(albums, []);
  assert.deepEqual(results, [{
    kind: 'video', id: 'aaaaaaaaaaa', title: 'Let It Happen', artist: 'Tame Impala', album: null, channel: 'Tame Impala',
    durationSec: 467, views: 38464770, explicit: false, thumbnail: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  }]);
});

test('un enlace de YouTube pegado en la búsqueda devuelve ese video', async () => {
  for (const link of [
    'https://www.youtube.com/watch?v=ccccccccccc&list=RDx',
    'https://youtu.be/ccccccccccc?si=abc',
    'https://music.youtube.com/watch?feature=share&v=ccccccccccc',
    'youtube.com/shorts/ccccccccccc',
  ]) {
    const { results } = await youtube().search(link);
    assert.equal(calls.at(-1).at(-1), 'https://www.youtube.com/watch?v=ccccccccccc', link);
    assert.deepEqual(results.map((r) => [r.id, r.artist, r.title]), [['ccccccccccc', 'Tame Impala', 'The Less I Know The Better']]);
  }
});

test('reintenta cuando YouTube pide confirmar que no eres un bot', async () => {
  botFailures = 1;
  const { results } = await youtube().search('https://youtu.be/botbotbotbo');
  assert.equal(results[0].id, 'ccccccccccc');
  assert.equal(botFailures, -1);
});

test('usa cookies y extractor-args si están configurados', async () => {
  const cookies = path.join(root, 'cookies.txt');
  await youtube({ cookiesFile: cookies, extractorArgs: 'youtubepot-bgutilhttp:base_url=http://b:4416' }).search('https://youtu.be/ccccccccccc');
  assert.ok(calls.at(-1).includes('youtubepot-bgutilhttp:base_url=http://b:4416'));
  assert.ok(!calls.at(-1).includes('--cookies'), 'sin archivo no se pasan cookies');
  await fs.writeFile(cookies, '# Netscape HTTP Cookie File\n');
  await youtube({ cookiesFile: cookies }).search('https://youtu.be/ccccccccccc');
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--cookies') + 1], cookies);
});

test('vista previa: reenvía el audio con Range y renueva la URL si caducó', async () => {
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, range: init.headers.range, ua: init.headers['User-Agent'] });
    if (fetched.length === 2) return new Response(null, { status: 403 });
    return new Response('AUDIO', { status: 206, headers: { 'content-type': 'audio/mp4', 'content-range': 'bytes 0-4/5', 'content-length': '5' } });
  };
  const yt = youtube({ fetchImpl });
  const preview = async () => {
    const res = fakeResponse();
    await yt.streamPreview('ppppppppppp', { headers: { range: 'bytes=0-' } }, res);
    return res;
  };
  const first = await preview();
  assert.equal(first.statusCode, 206);
  assert.equal(first.headers['content-type'], 'audio/mp4');
  assert.equal(first.body, 'AUDIO');
  const second = await preview(); // la URL en caché devuelve 403 → se resuelve otra
  assert.equal(second.body, 'AUDIO');
  assert.deepEqual(fetched.map((f) => f.range), ['bytes=0-', 'bytes=0-', 'bytes=0-']);
  assert.equal(fetched[0].url, fetched[1].url, 'la segunda petición reutiliza la URL en caché');
  assert.notEqual(fetched[1].url, fetched[2].url);
  assert.equal(fetched[0].ua, 'yt');
  await assert.rejects(yt.streamPreview('--exec=rm', { headers: {} }, fakeResponse()), { status: 400 });
});

/** Respuesta de Express mínima que acumula lo escrito. */
function fakeResponse() {
  const res = new PassThrough();
  res.headers = {};
  res.body = '';
  res.status = (code) => { res.statusCode = code; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.on('data', (c) => { res.body += c; });
  return res;
}

test('búsqueda vacía → 400', async () => {
  await assert.rejects(youtube().search('  '), { status: 400 });
});

test('descarga: guarda "Artista - Título" en la biblioteca con los tags corregidos', async () => {
  const yt = youtube();
  const job = await waitFor(yt, yt.enqueue('ccccccccccc').id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.file, 'Todo/Tame Impala - The Less I Know The Better.opus');
  assert.equal(await fs.readFile(path.join(destDir, 'Tame Impala - The Less I Know The Better.opus'), 'utf8'), 'OggS-falso');

  assert.deepEqual(await fs.readdir(tmpDir), [], 'la carpeta temporal se borra al terminar');

  // Repetir la misma descarga reconoce el duplicado en lugar de crear "(2)".
  const again = await waitFor(yt, yt.enqueue('ccccccccccc').id);
  assert.equal(again.duplicate, true);
});

test('control anti-bots persistente: la cola hace una pausa y reintenta en vez de fallar', async () => {
  botFailures = 3; // la primera ronda (1 + 2 reintentos rápidos) falla entera
  const yt = youtube({ botRetryMs: [1, 1], botCooldownMs: [20] });
  const { id } = yt.enqueue('botbotbotbo');
  let paused = false;
  for (let i = 0; i < 400; i++) {
    const job = yt.get(id);
    if (job.waitingUntil) paused = true;
    if (job.status === 'done' || job.status === 'error') break;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(paused, 'mientras espera, el trabajo expone waitingUntil');
  assert.equal(yt.get(id).status, 'done', yt.get(id).error);
  assert.equal(yt.get(id).waitingUntil, null);
});

test('si el bloqueo dura más que el máximo de espera, la canción se da por fallida', async () => {
  botFailures = 1000;
  const yt = youtube({ botRetryMs: [1, 1], botCooldownMs: [5, 10], maxBotWaitMs: 20 });
  const job = await waitFor(yt, yt.enqueue('botbotbotbo').id);
  botFailures = 0;
  assert.equal(job.status, 'error');
  assert.match(job.error, /no eres un bot/);
});

test('cancelar: una en cola se quita sin descargarse; una terminada no cambia', async () => {
  const yt = youtube();
  const first = yt.enqueue('ccccccccccc');
  const second = yt.enqueue('ddddddddddd');
  assert.equal(yt.cancel(second.id).status, 'cancelled');
  const done = await waitFor(yt, first.id);
  assert.equal(done.status, 'done');
  assert.equal(yt.cancel(first.id).status, 'done');
  assert.equal(yt.get(second.id).status, 'cancelled');
  assert.throws(() => yt.cancel('no-existe'), { status: 404 });
});

test('una descarga con prioridad pasa delante de las que esperan en cola', async () => {
  const yt = youtube();
  const from = calls.length;
  yt.enqueue('eeeeeeeeeee'); // empieza a descargarse en seguida
  const batch = yt.enqueue('fffffffffff');
  yt.enqueue('ggggggggggg', { priority: true });
  await waitFor(yt, batch.id);
  const order = calls
    .slice(from)
    .filter((a) => a.includes('--no-playlist') && a.includes('--dump-single-json'))
    .map((a) => a.at(-1).slice(-11));
  assert.deepEqual(order, ['eeeeeeeeeee', 'ggggggggggg', 'fffffffffff']);
});

test('un video ya descargado no se vuelve a bajar, tampoco tras un reinicio (historial en disco)', async () => {
  const historyFile = path.join(root, 'downloaded.json');
  const first = youtube({ historyFile });
  const job = await waitFor(first, first.enqueue('hhhhhhhhhhh').id);
  assert.equal(job.status, 'done', job.error);
  await new Promise((r) => setTimeout(r, 20)); // se escribe el historial

  const downloadsBefore = calls.filter((a) => a.includes('--load-info-json')).length;
  const second = youtube({ historyFile });
  const again = await waitFor(second, second.enqueue('hhhhhhhhhhh').id);
  assert.equal(again.duplicate, true);
  assert.equal(again.file, job.file);
  assert.equal(calls.filter((a) => a.includes('--load-info-json')).length, downloadsBefore, 'no se lanzó otra descarga');
});

test('un error de yt-dlp llega legible al trabajo', async () => {
  const yt = youtube();
  const job = await waitFor(yt, yt.enqueue('fallaaaaaaa').id);
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'YouTube: Video unavailable');
});

test('rechaza identificadores que no son de YouTube (sin inyección de argumentos)', () => {
  assert.throws(() => youtube().enqueue('--exec=rm'), { status: 400 });
  assert.throws(() => youtube().enqueue('https://evil.example/x'), { status: 400 });
});

test('tagsFor: canción de YouTube Music, video "Artista - Título" y canal', () => {
  assert.deepEqual(tagsFor({ track: 'Borderline', artists: ['Tame Impala'], album: 'The Slow Rush', title: 'x' }),
    { title: 'Borderline', artist: 'Tame Impala', album: 'The Slow Rush' });
  assert.deepEqual(tagsFor({ title: 'Daft Punk – Get Lucky [Official Audio] (HD)', channel: 'DaftPunkVEVO' }),
    { title: 'Get Lucky', artist: 'Daft Punk', album: null });
  assert.deepEqual(tagsFor({ track: 'Let It Happen', artists: ['Cook & Ki$$', 'Cook', 'Ki$$'], album: 'Let It Happen' }),
    { title: 'Let It Happen', artist: 'Cook & Ki$$', album: 'Let It Happen' });
  assert.deepEqual(tagsFor({ track: 'Dúo', artists: ['A', 'B'] }), { title: 'Dúo', artist: 'A, B', album: null });
  assert.deepEqual(tagsFor({ title: 'Mi canción', channel: 'Banda X - Topic' }),
    { title: 'Mi canción', artist: 'Banda X', album: null });
});

test('vía rápida: los datos por InnerTube y yt-dlp solo descarga (sin --dump-single-json)', async () => {
  const innertube = {
    info: async (id) => ({ id, title: 'Let It Happen', channel: 'Tame Impala - Topic', duration: 468, live_status: 'not_live', track: 'Let It Happen', artists: ['Tame Impala'], album: 'Currents', release_year: 2015, formats: [] }),
  };
  const yt = youtube({ innertube });
  const before = calls.length;
  const job = await waitFor(yt, yt.enqueue('fffffffffff').id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.file, 'Todo/Tame Impala - Let It Happen.opus');
  const ytdlp = calls.slice(before).filter((a) => a[0] !== '-I');
  assert.equal(ytdlp.length, 1);
  assert.ok(ytdlp[0].includes('--load-info-json'));
  assert.equal(lastInfo.album, 'Currents');
  assert.equal(lastInfo.meta_date, '2015', 'sin fecha de subida se usa el año del ℗');
});

test('vía rápida: si InnerTube falla se usa la extracción completa de yt-dlp', async () => {
  const yt = youtube({ innertube: { info: async () => { throw new Error('HTTP 400'); } } });
  const before = calls.length;
  const job = await waitFor(yt, yt.enqueue('ggggggggggg').id);
  assert.equal(job.status, 'done', job.error);
  assert.ok(calls.slice(before).some((a) => a.includes('--dump-single-json')));
});

test('vista previa: la URL sale de InnerTube sin lanzar yt-dlp', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response('audio', { status: 200, headers: { 'content-type': 'audio/mp4' } });
  };
  const innertube = { audioStream: async () => ({ url: 'https://googlevideo.example/rapido', headers: { 'User-Agent': 'vision' } }) };
  const yt = youtube({ fetchImpl, innertube });
  const before = calls.length;
  const res = fakeResponse();
  await yt.streamPreview('hhhhhhhhhhh', { headers: {} }, res);
  assert.equal(seen[0].url, 'https://googlevideo.example/rapido');
  assert.equal(seen[0].init.headers['User-Agent'], 'vision');
  assert.equal(calls.slice(before).filter((a) => a[0] !== '-I').length, 0);
});
