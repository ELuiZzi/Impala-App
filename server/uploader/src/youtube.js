import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { httpError } from './auth.js';
import { sanitizeFilename } from './filename.js';
import { createInnertube } from './innertube.js';
import { md5File, storeUnique } from './store.js';
import { createCache, createYtWorker } from './ytworker.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** watch?v=, youtu.be/, shorts/, embed/, live/ (también music.youtube.com y m.youtube.com). */
const VIDEO_URL = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/))([A-Za-z0-9_-]{11})/i;
/** browseId de un álbum de YouTube Music ("MPREb_…"). */
const ALBUM_ID = /^MPRE[A-Za-z0-9_-]{4,60}$/;
/** Canal de un artista de YouTube Music ("UC…"). */
const ARTIST_ID = /^UC[A-Za-z0-9_-]{10,40}$/;
const VIDEO_SEARCH_LIMIT = 10;
const MATCH_TIMEOUT_PER_QUERY_MS = 8_000;
const MAX_DURATION_SEC = 2 * 60 * 60;
const SEARCH_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
/** Trabajos terminados que se recuerdan para que la app vea el resultado. */
// Las importaciones consultan sus descargas por id: hay que recordar al menos una playlist grande.
const MAX_FINISHED_JOBS = 400;
/** Esperas antes de reintentar cuando YouTube pide "confirmar que no eres un bot". */
const BOT_CHECK_RETRY_MS = [2_000, 6_000];
/** Si aun así persiste, la cola entera se detiene cada vez más (el último valor se repite). */
const BOT_COOLDOWN_MS = [2, 5, 10, 20, 30, 60].map((min) => min * 60_000);
/** Tiempo máximo que una canción espera a que YouTube levante el bloqueo antes de darla por fallida. */
const MAX_BOT_WAIT_MS = 12 * 60 * 60_000;
/** Espera aleatoria entre descargas seguidas: [mínimo, máximo]. */
// YouTube bloquea la IP tras ~25 descargas en 8 min; a este ritmo una tanda grande pasa sin bloqueos largos.
const PACE_MS = [30_000, 60_000];
/** Con la vía rápida (InnerTube, una petición por canción, como el teléfono) basta una pausa corta. */
const FAST_PACE_MS = [1_500, 4_000];
/** Las URLs de googlevideo caducan a las ~6 h; para las vistas previas se reutilizan una hora. */
const PREVIEW_CACHE_MS = 60 * 60_000;
const MAX_PREVIEW_CACHE = 100;
const YTMUSIC_SCRIPT = fileURLToPath(new URL('./ytmusic.py', import.meta.url));
/** Búsquedas recientes: repetir una (volver atrás, cambiar de pestaña) es instantáneo. */
const SEARCH_CACHE_MS = 30 * 60_000;
/** Álbumes y artistas cambian poco. */
const CATALOG_CACHE_MS = 6 * 60 * 60_000;
/** El cliente de audio cambia solo al actualizarse yt-dlp (y renovarse el proceso, cada 6 h). */
const AUDIO_CLIENT_CACHE_MS = 30 * 60_000;

/**
 * Búsqueda, vista previa y descarga desde YouTube con yt-dlp. Solo audio: el mejor stream
 * disponible sin recodificar (normalmente Opus ~130-160 kbps; YouTube no ofrece audio sin
 * pérdida), con tags y carátula cuadrada incrustados. El resultado entra en la biblioteca igual
 * que una subida.
 *
 * config: { ytDlp, python?, destDir, tmpDir, uploadSubdir, cookiesFile?, extractorArgs?, anonCookies?, spawnImpl?, fetchImpl? }
 * - anonCookies: visita anónima (anoncookies.js) que se usa cuando no hay cookiesFile.
 * - python: intérprete con ytmusicapi (canciones de YouTube Music); sin él solo se buscan videos.
 * - cookiesFile: cookies.txt de una cuenta de YouTube; si el archivo existe se usa (menos controles
 *   anti-bots y, con YouTube Premium, Opus a 256 kbps).
 * - extractorArgs: p. ej. el proveedor de PO tokens (bgutil), que evita la mayoría de esos controles.
 */
export function createYoutube({
  ytDlp,
  python = null,
  destDir,
  tmpDir,
  uploadSubdir,
  cookiesFile = null,
  extractorArgs = null,
  spawnImpl = spawn,
  fetchImpl = fetch,
  anonCookies = null,
  historyFile = null,
  botRetryMs = BOT_CHECK_RETRY_MS,
  botCooldownMs = BOT_COOLDOWN_MS,
  maxBotWaitMs = MAX_BOT_WAIT_MS,
  paceMs = PACE_MS,
  fastPaceMs = FAST_PACE_MS,
  ytWorker = python ? createYtWorker({ python, script: YTMUSIC_SCRIPT, spawnImpl }) : null,
  innertube = undefined,
}) {
  const jobs = new Map();
  // Vía rápida para descargas y vistas previas; null la desactiva (solo yt-dlp).
  const fast = innertube === undefined ? createInnertube({ fetchImpl, clientFor: () => audioClient() }) : innertube;
  const searchCache = createCache({ ttlMs: SEARCH_CACHE_MS });
  const catalogCache = createCache({ ttlMs: CATALOG_CACHE_MS });
  const audioClientCache = createCache({ ttlMs: AUDIO_CLIENT_CACHE_MS, max: 1 });
  ytWorker?.warm();
  const queue = [];
  let working = false;
  /** Pausas anti-bots seguidas sin una descarga correcta entre medias. */
  let botStreak = 0;
  const previews = new Map();
  // Videos ya descargados → archivo en la biblioteca. El MD5 no sirve para reconocer duplicados: al
  // reempaquetar el Opus, yt-dlp le pone números de serie aleatorios y cada descarga difiere.
  const history = new Map();
  const historyLoaded = historyFile
    ? fs.readFile(historyFile, 'utf8').then((t) => Object.entries(JSON.parse(t)).forEach(([k, v]) => history.set(k, v)), () => {})
    : Promise.resolve();
  let historyWrite = Promise.resolve();
  function rememberDownload(videoId, file) {
    history.set(videoId, file);
    if (!historyFile) return;
    historyWrite = historyWrite.then(() => fs.writeFile(historyFile, JSON.stringify(Object.fromEntries(history)))).catch((err) => console.error('youtube: no se pudo guardar el historial:', err.message));
  }

  /**
   * Primero las canciones de YouTube Music (el audio oficial del álbum, sin edits ni videoclips) y
   * después videos de la búsqueda general, para versiones que solo existen ahí. Si se pega un
   * enlace de YouTube, el resultado es ese video.
   *
   * scope: 'music' (canciones, álbumes y artistas de YouTube Music: lo más rápido), 'videos' o
   * 'all'. La app pide las dos partes por separado y muestra la música en cuanto llega.
   */
  async function search(query, scope = 'all') {
    const q = String(query ?? '').trim();
    if (!q) throw httpError(400, 'Falta el parámetro "q"');
    if (q.length > 500) throw httpError(400, 'Búsqueda demasiado larga');
    if (!['all', 'music', 'videos'].includes(scope)) throw httpError(400, 'scope debe ser all, music o videos');

    const linked = VIDEO_URL.exec(q)?.[1];
    if (linked) return { results: scope === 'music' ? [] : [await videoResult(linked)], albums: [], artists: [] };

    const empty = { songs: [], albums: [], artists: [] };
    const [music, videos] = await Promise.all([
      scope === 'videos'
        ? empty
        : searchMusic(q).catch((err) => {
            console.error('ytmusic:', err.message);
            return empty;
          }),
      scope === 'music' ? [] : searchVideos(q),
    ]);
    const seen = new Set(music.songs.map((s) => s.id));
    return { results: [...music.songs, ...videos.filter((v) => !seen.has(v.id))], albums: music.albums, artists: music.artists };
  }

  /** Canciones, álbumes y artistas de YouTube Music (en paralelo, en el proceso persistente). */
  function searchMusic(q) {
    if (!ytWorker) return Promise.resolve({ songs: [], albums: [], artists: [] });
    return searchCache(`music:${q.toLowerCase()}`, async () => {
      const { songs = [], albums = [], artists = [] } = await ytWorker.call('search', { q }, SEARCH_TIMEOUT_MS);
      return {
        songs: songs.filter((r) => VIDEO_ID.test(r.id ?? '')).map(songResult),
        albums: albums.filter((a) => ALBUM_ID.test(a.id ?? '')).map(albumResult),
        artists: artists.filter((a) => ARTIST_ID.test(a.id ?? '')).map(artistResult),
      };
    });
  }

  /** Un álbum de YouTube Music con sus pistas (las que se pueden reproducir). */
  async function album(id) {
    if (!ALBUM_ID.test(String(id ?? ''))) throw httpError(400, 'Identificador de álbum inválido');
    if (!ytWorker) throw httpError(503, 'ytmusicapi no está instalado en el servidor');
    return catalogCache(`album:${id}`, async () => {
      const a = await ytWorker.call('album', { id }, SEARCH_TIMEOUT_MS);
      return {
        ...albumResult(a),
        cover: a.cover ?? a.thumbnail ?? null,
        tracks: (a.tracks ?? [])
          .filter((t) => VIDEO_ID.test(t.id ?? ''))
          .map((t) => ({ ...songResult(t), trackNumber: Number.isInteger(t.trackNumber) ? t.trackNumber : null })),
      };
    });
  }

  /**
   * Un artista de YouTube Music: sus canciones más escuchadas ahora (en el orden de YouTube Music),
   * álbumes y sencillos. Por id de canal o, para la página de un artista de la biblioteca, por nombre.
   */
  async function artist({ id, name } = {}) {
    if (!ytWorker) throw httpError(503, 'ytmusicapi no está instalado en el servidor');
    let key;
    let load;
    if (id !== undefined) {
      if (!ARTIST_ID.test(String(id))) throw httpError(400, 'Identificador de artista inválido');
      key = `artist:${id}`;
      load = () => ytWorker.call('artist', { id }, SEARCH_TIMEOUT_MS);
    } else {
      const n = String(name ?? '').trim();
      if (!n || n.length > 200) throw httpError(400, 'Falta el nombre del artista');
      key = `artistName:${n.toLowerCase()}`;
      load = () => ytWorker.call('artistByName', { name: n }, SEARCH_TIMEOUT_MS);
    }
    return catalogCache(key, async () => {
      const a = await load();
      if (!a) throw httpError(404, 'Ese artista no está en YouTube Music');
      const releases = (list) => (list ?? []).filter((r) => ALBUM_ID.test(r.id ?? '')).map(albumResult);
      return {
        id: a.id,
        name: a.name ?? null,
        image: typeof a.image === 'string' ? a.image : null,
        songs: (a.songs ?? []).filter((r) => VIDEO_ID.test(r.id ?? '')).map(songResult),
        albums: releases(a.albums),
        singles: releases(a.singles),
      };
    });
  }

  /**
   * El cliente de InnerTube con el que el yt-dlp instalado pide audio sin JavaScript ni PO token
   * ({ name, id, version, userAgent, context }), o null. La app lo usa para pedir las vistas previas
   * desde el teléfono: cuando YouTube bloquea un cliente, basta con que yt-dlp se actualice.
   */
  async function audioClient() {
    if (!ytWorker) return null;
    try {
      return await audioClientCache('client', () => ytWorker.call('audioClient', {}, SEARCH_TIMEOUT_MS));
    } catch (err) {
      console.error('ytmusic audioClient:', err.message);
      return null;
    }
  }

  /**
   * Varias búsquedas de canciones de una vez (importar playlists). Devuelve, por cada búsqueda, las
   * mejores canciones de YouTube Music en el orden en que las da.
   */
  async function matchSongs(queries) {
    if (!ytWorker || queries.length === 0) return queries.map(() => []);
    const timeout = SEARCH_TIMEOUT_MS + queries.length * MATCH_TIMEOUT_PER_QUERY_MS;
    const results = await ytWorker.call('match', { queries: queries.map((query) => ({ query: String(query).slice(0, 300) })) }, timeout);
    return results.map((songs) => (songs ?? []).filter((r) => VIDEO_ID.test(r.id ?? '')).map(songResult));
  }

  /**
   * Búsqueda general (rápida, sin abrir cada video); artista y título salen del nombre del video.
   * Va por el proceso persistente (yt-dlp como librería); si falla, por la línea de comandos.
   */
  function searchVideos(q) {
    return searchCache(`videos:${q.toLowerCase()}`, async () => {
      let entries = null;
      if (ytWorker) {
        try {
          entries = await ytWorker.call('videos', { q, limit: VIDEO_SEARCH_LIMIT, cookies: await cookiesPath() }, SEARCH_TIMEOUT_MS);
        } catch (err) {
          console.error('ytmusic videos:', err.message);
        }
      }
      if (!entries) {
        const { stdout } = await runRetry(['--flat-playlist', '--dump-single-json', `ytsearch${VIDEO_SEARCH_LIMIT}:${q}`], SEARCH_TIMEOUT_MS);
        entries = JSON.parse(stdout).entries ?? [];
      }
      return entries
        .filter((e) => VIDEO_ID.test(e.id ?? '') && e.live_status !== 'is_live' && e.live_status !== 'is_upcoming')
        .map(videoEntry);
    });
  }

  async function videoResult(id) {
    const { stdout } = await runRetry(['--no-playlist', '--dump-single-json', `https://www.youtube.com/watch?v=${id}`], SEARCH_TIMEOUT_MS);
    const info = JSON.parse(stdout);
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw httpError(422, 'Es una transmisión en vivo');
    return videoEntry(info);
  }

  /**
   * Vista previa: reenvía el audio de YouTube a la app sin guardarlo en la biblioteca. Las URLs de
   * googlevideo están ligadas a la IP del servidor, así que el teléfono no puede pedirlas directo.
   * Se respetan los rangos (Range) para que el reproductor pueda adelantar.
   */
  async function streamPreview(id, req, res) {
    if (!VIDEO_ID.test(String(id ?? ''))) throw httpError(400, 'Identificador de video inválido');
    for (let attempt = 0; ; attempt++) {
      const source = await previewSource(id, attempt > 0);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      try {
        let upstream;
        try {
          upstream = await fetchImpl(source.url, {
            headers: { ...source.headers, ...(req.headers.range ? { range: req.headers.range } : {}) },
            signal: controller.signal,
          });
        } catch {
          throw httpError(502, 'No se pudo obtener el audio de YouTube');
        }
        // URL caducada o revocada: se resuelve otra, una sola vez.
        if ((upstream.status === 403 || upstream.status === 410) && attempt === 0) {
          await upstream.body?.cancel().catch(() => {});
          continue;
        }
        if (!upstream.ok) throw httpError(502, `YouTube respondió HTTP ${upstream.status}`);

        res.status(upstream.status);
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        res.setHeader('cache-control', 'no-store');
        await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {
          // El cliente cerró la conexión (dejó de escuchar o adelantó): nada que hacer.
        });
        return;
      } finally {
        res.off('close', abort);
      }
    }
  }

  async function previewSource(id, refresh) {
    const cached = previews.get(id);
    if (cached && !refresh && cached.expires > Date.now()) return cached;
    // m4a primero: el reproductor empieza a sonar antes que con el contenedor WebM.
    // Primero por InnerTube (~1 s); yt-dlp (~30 s) solo si falla o si la URL ya dio 403.
    if (fast && !refresh) {
      try {
        const stream = await fast.audioStream(id);
        return rememberPreview(id, { url: stream.url, headers: stream.headers });
      } catch (err) {
        console.warn(`youtube ${id}: vista previa por InnerTube falló (${err.message}); se usa yt-dlp`);
      }
    }
    const { stdout } = await runRetry(
      ['--no-playlist', '--format', 'bestaudio[ext=m4a]/bestaudio', '--print', '%(.{url,http_headers})j', `https://www.youtube.com/watch?v=${id}`],
      SEARCH_TIMEOUT_MS,
    );
    const info = JSON.parse(stdout);
    if (!info.url) throw httpError(502, 'YouTube no ofreció audio para este video');
    return rememberPreview(id, { url: info.url, headers: info.http_headers ?? {} });
  }

  function rememberPreview(id, entry) {
    const source = { ...entry, expires: Date.now() + PREVIEW_CACHE_MS };
    previews.delete(id);
    if (previews.size >= MAX_PREVIEW_CACHE) previews.delete(previews.keys().next().value);
    previews.set(id, source);
    return source;
  }

  /**
   * hint: { title?, artist?, album?, albumArtist?, trackNumber?, year?, priority? }. Con `album` (descarga de un
   * álbum o de una playlist importada) esos datos sustituyen a los de YouTube en los tags, para que
   * Navidrome agrupe todas las pistas en el mismo álbum.
   */
  function enqueue(id, hint = {}) {
    if (!VIDEO_ID.test(String(id ?? ''))) throw httpError(400, 'Identificador de video inválido');
    const active = [...jobs.values()].find((j) => j.videoId === id && isActive(j));
    if (active) return publicJob(active);

    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
    const int = (value, max) => (Number.isInteger(value) && value > 0 && value <= max ? value : null);
    const album = text(hint.album);
    const job = {
      id: randomUUID(),
      videoId: id,
      title: text(hint.title),
      artist: text(hint.artist),
      tags: album
        ? { title: text(hint.title), artist: text(hint.artist), album, albumArtist: text(hint.albumArtist), trackNumber: int(hint.trackNumber, 999), year: int(Number(hint.year), 9999) }
        : null,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    // Una canción pedida a mano pasa delante de las tandas (álbumes, playlists importadas).
    if (hint.priority === true) queue.unshift(job);
    else queue.push(job);
    pruneFinished();
    drain();
    return publicJob(job);
  }

  function list() {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
  }

  /**
   * Cancela una descarga: si está en cola se quita; si está descargando se mata yt-dlp. Ya guardándose
   * en la biblioteca (processing) no se puede cancelar.
   */
  function cancel(jobId) {
    const job = jobs.get(String(jobId));
    if (!job) throw httpError(404, 'No existe esa descarga');
    if (!isActive(job)) return publicJob(job);
    if (job.status === 'processing') throw httpError(409, 'Ya se está guardando en la biblioteca');
    job.cancelled = true;
    const queued = queue.indexOf(job);
    if (queued >= 0) {
      queue.splice(queued, 1);
      Object.assign(job, { status: 'cancelled', waitingUntil: null, finishedAt: Date.now() });
    } else {
      job.child?.kill('SIGKILL');
    }
    return publicJob(job);
  }

  /** Estado de un trabajo concreto (o null si ya se olvidó). */
  const get = (jobId) => (jobs.has(jobId) ? publicJob(jobs.get(jobId)) : null);

  async function drain() {
    if (working) return;
    working = true;
    while (queue.length > 0) {
      const job = queue.shift();
      job.waitingUntil = null;
      try {
        if (job.cancelled) throw httpError(499, 'Descarga cancelada');
        Object.assign(job, await download(job));
        job.status = 'done';
        job.progress = 1;
        botStreak = 0;
        console.log(`youtube ${job.duplicate ? 'duplicado' : 'guardado'}: ${job.file}`);
      } catch (err) {
        // El control anti-bots (HTTP 429) limita la IP del servidor durante horas cuando se descargan
        // muchas seguidas: es de toda la cola, no de la canción. La cola espera cada vez más (hasta
        // 60 min entre intentos) y sigue sola cuando YouTube vuelve a responder; la pausa se reinicia
        // tras una descarga correcta. Una canción solo se da por perdida tras maxBotWaitMs esperando.
        if (job.cancelled) {
          Object.assign(job, { status: 'cancelled', error: null, finishedAt: Date.now() });
          delete job.child;
          console.log(`youtube ${job.videoId}: cancelada`);
          continue;
        }
        const delay = botCooldownMs[Math.min(botStreak, botCooldownMs.length - 1)];
        if (err.botCheck && (job.botWaitedMs ?? 0) + delay <= maxBotWaitMs) {
          botStreak++;
          job.botWaitedMs = (job.botWaitedMs ?? 0) + delay;
          Object.assign(job, { status: 'queued', progress: 0, waitingUntil: Date.now() + delay });
          queue.unshift(job);
          console.warn(`youtube: control anti-bots persistente, pausa de ${Math.round(delay / 60_000)} min`);
          await sleep(delay);
          await anonCookies?.rotate();
          continue;
        }
        job.status = 'error';
        job.error = err.status ? err.message : 'No se pudo descargar';
        console.error(`youtube ${job.videoId}:`, err.message);
      }
      job.finishedAt = Date.now();
      // Un ritmo humano entre descargas de una tanda (álbum, playlist) evita la mayoría de esos controles.
      const pace = job.fast ? fastPaceMs : paceMs;
      if (queue.length > 0) await sleep(pace[0] + Math.random() * (pace[1] - pace[0]));
    }
    working = false;
  }

  async function download(job) {
    // Ya se descargó este video y el archivo sigue en la biblioteca: no se vuelve a bajar.
    await historyLoaded;
    const known = history.get(job.videoId);
    if (known) {
      const stat = await fs.stat(path.join(destDir, path.posix.basename(known))).catch(() => null);
      if (stat?.isFile()) return { file: known, duplicate: true, size: stat.size };
      history.delete(job.videoId); // lo borraron: se descarga de nuevo
    }
    const workDir = path.join(tmpDir, `yt-${job.id}`);
    await fs.mkdir(workDir, { recursive: true });
    try {
      job.status = 'downloading';
      // Vía rápida: los datos y las URLs del audio por InnerTube (~1 s, como el teléfono) y yt-dlp solo
      // descarga por tramos y post-procesa. Si algo falla, la extracción completa de yt-dlp (~30 s).
      let file = null;
      let tags = null;
      if (fast) {
        try {
          const info = await fast.info(job.videoId);
          ({ file, tags } = await fetchAudio(job, info, workDir));
          job.fast = true;
        } catch (err) {
          if (job.cancelled) throw httpError(499, 'Descarga cancelada');
          if (err.status === 422) throw err;
          console.warn(`youtube ${job.videoId}: vía rápida falló (${err.message}); se usa yt-dlp`);
          job.progress = 0;
        }
      }
      if (!file) {
        job.fast = false;
        const url = `https://www.youtube.com/watch?v=${job.videoId}`;
        const { stdout } = await runRetry(['--no-playlist', '--dump-single-json', url], SEARCH_TIMEOUT_MS, null, job);
        ({ file, tags } = await fetchAudio(job, JSON.parse(stdout), workDir));
      }

      // 3. A la biblioteca, sin pisar nada y reconociendo duplicados (como una subida).
      job.status = 'processing';
      const name = sanitizeFilename(`${tags.artist} - ${tags.title}${path.extname(file)}`);
      if (!name) throw httpError(415, `Formato inesperado: ${path.extname(file)}`);
      const { size } = await fs.stat(file);
      const md5 = await md5File(file);
      const stored = await storeUnique(file, destDir, name, { size, md5 });
      const relative = path.posix.join(uploadSubdir, stored.fileName);
      rememberDownload(job.videoId, relative);
      return { file: relative, duplicate: stored.duplicate, size };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  /** Tags del trabajo + descarga del mejor audio (sin recodificar) con tags y carátula cuadrada. */
  async function fetchAudio(job, info, workDir) {
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw httpError(422, 'No se pueden descargar transmisiones en vivo');
    if (info.duration > MAX_DURATION_SEC) throw httpError(422, 'El video dura más de 2 horas');
    await fs.rm(path.join(workDir, 'out'), { recursive: true, force: true });
    const outDir = path.join(workDir, 'out');
    await fs.mkdir(outDir, { recursive: true });
    const infoFile = path.join(workDir, 'info.json');

    // --embed-metadata toma title/artist/album de estos campos; la descripción no va a los tags.
    const tags = tagsFor(info);
    const override = job.tags;
    if (override) {
      tags.title = override.title ?? tags.title;
      tags.artist = override.artist ?? tags.artist;
      tags.album = override.album;
    }
    job.title = tags.title;
    job.artist = tags.artist;
    Object.assign(info, { track: tags.title, artist: tags.artist, artists: [tags.artist], album: tags.album, description: null });
    // Sin fecha de subida (pistas de YouTube Music por InnerTube): el año del ℗. Va en meta_date (el tag
    // tal cual): yt-dlp exige que upload_date sea AAAAMMDD y con "1987" termina con error.
    if (!info.upload_date && info.release_year) info.meta_date = String(info.release_year);
    if (override) {
      const albumArtist = override.albumArtist ?? tags.artist;
      Object.assign(info, { album_artist: albumArtist, album_artists: [albumArtist], track_number: override.trackNumber });
      // La fecha del tag sale de upload_date: el año del álbum, no el día en que se subió el video.
      if (override.year) Object.assign(info, { meta_date: String(override.year), release_year: override.year });
    }
    await fs.writeFile(infoFile, JSON.stringify(info));

    //    Con cookies de YouTube Premium aparece Opus a 256 kbps (formato 774) y se elige solo.
    const args = [
      '--load-info-json', infoFile,
      '--format', 'bestaudio[acodec=opus]/bestaudio',
      '--extract-audio', '--audio-format', 'best',
      '--embed-metadata', '--embed-thumbnail', '--convert-thumbnails', 'jpg',
      '--postprocessor-args', `ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -qmin 1 -qscale:v 1 -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'"`,
      '--paths', outDir, '--output', 'audio.%(ext)s',
      '--progress', '--newline', '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
      '--print', 'after_move:FILE %(filepath)s',
    ];
    const { stdout: out } = await runRetry(args, DOWNLOAD_TIMEOUT_MS, (line) => {
      const m = /^PROGRESS\s+([\d.]+)%/.exec(line.trim());
      if (m) job.progress = Math.min(0.99, Number(m[1]) / 100);
    }, job);
    if (job.cancelled) throw httpError(499, 'Descarga cancelada');
    const file = /^FILE (.+)$/m.exec(out)?.[1]?.trim();
    if (!file) throw new Error('yt-dlp no indicó el archivo final');
    return { file, tags };
  }

  /**
   * YouTube a veces responde "Sign in to confirm you're not a bot" según la IP y la frecuencia de
   * las peticiones, no según el video: el mismo video suele funcionar segundos después. Se reintenta.
   */
  /** owner: el trabajo de descarga dueño del proceso (para poder cancelarlo). */
  async function runRetry(args, timeoutMs, onLine, owner = null) {
    for (let attempt = 0; ; attempt++) {
      if (owner?.cancelled) throw httpError(499, 'Descarga cancelada');
      try {
        return await run(args, timeoutMs, onLine, owner);
      } catch (err) {
        if (!err.botCheck || attempt >= botRetryMs.length) throw err;
        console.warn(`youtube: control anti-bots, reintento ${attempt + 1}`);
        await anonCookies?.rotate();
        await sleep(botRetryMs[attempt]);
      }
    }
  }

  async function run(args, timeoutMs, onLine, owner = null) {
    const extra = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node'];
    if (extractorArgs) extra.push('--extractor-args', extractorArgs);
    const cookies = await cookiesPath();
    if (cookies) extra.push('--cookies', cookies);
    return exec(ytDlp, [...extra, ...args], timeoutMs, onLine, null, owner);
  }

  /**
   * cookies.txt de la cuenta si existe; si no, una visita anónima coherente en vez de parecer un
   * visitante nuevo en cada petición.
   */
  async function cookiesPath() {
    if (cookiesFile && (await fs.access(cookiesFile).then(() => true, () => false))) return cookiesFile;
    return (await anonCookies?.path()) ?? null;
  }

  /** Ejecuta un proceso sin shell; rechaza con la última línea "ERROR:" si falla. */
  function exec(cmd, args, timeoutMs, onLine, input = null, owner = null) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (owner) owner.child = child;
      if (input !== null) child.stdin.end(input);
      let stdout = '';
      let stderr = '';
      let pending = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (!onLine) return;
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop();
        lines.forEach(onLine);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve({ stdout });
        if (signal) return reject(httpError(504, 'YouTube tardó demasiado en responder'));
        const message = stderr.split('\n').filter((l) => l.startsWith('ERROR:')).pop()?.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, '');
        if (message && /confirm you.re not a bot/i.test(message)) {
          return reject(Object.assign(httpError(502, 'YouTube pidió confirmar que no eres un bot. Inténtalo de nuevo en un momento.'), { botCheck: true }));
        }
        if (!message) console.error(`${path.basename(cmd)}:`, stderr.trim().split('\n').slice(-3).join(' | '));
        reject(httpError(502, message ? `YouTube: ${message}` : `${path.basename(cmd)} terminó con código ${code}`));
      });
    });
  }

  function pruneFinished() {
    const finished = [...jobs.values()].filter((j) => !isActive(j)).sort((a, b) => a.createdAt - b.createdAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) jobs.delete(job.id);
  }

  return { search, album, artist, audioClient, matchSongs, enqueue, cancel, list, get, streamPreview, close: () => ytWorker?.stop() };
}

const isActive = (j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'processing';

function songResult(r) {
  return {
    kind: 'song',
    id: r.id,
    title: r.title ?? 'Sin título',
    artist: r.artist ?? null,
    album: r.album ?? null,
    channel: null,
    durationSec: r.durationSec ?? null,
    views: null,
    explicit: !!r.explicit,
    thumbnail: r.thumbnail ?? `https://i.ytimg.com/vi/${r.id}/hqdefault.jpg`,
  };
}

function artistResult(a) {
  return { id: a.id, name: a.name ?? 'Sin nombre', thumbnail: a.thumbnail ?? null };
}

function albumResult(a) {
  const year = Number.parseInt(a.year, 10);
  return {
    id: a.id,
    title: a.title ?? 'Sin título',
    artist: a.artist ?? null,
    year: Number.isFinite(year) ? year : null,
    // "Album", "EP", "Single"…
    type: a.type ?? null,
    explicit: !!a.explicit,
    thumbnail: a.thumbnail ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function publicJob(job) {
  const { id, videoId, title, artist, status, progress, error, file, duplicate } = job;
  // waitingUntil: la cola está en pausa por el control anti-bots de YouTube hasta esa hora.
  return { id, videoId, title, artist, status, progress, error, file, duplicate, waitingUntil: job.waitingUntil ?? null };
}

/** Resultado de búsqueda a partir de una entrada de yt-dlp (búsqueda plana o video completo). */
function videoEntry(e) {
  const tags = tagsFor(e);
  return {
    // Una pista de YouTube Music trae track/artist (p. ej. al pegar su enlace).
    kind: e.track && firstArtist(e) ? 'song' : 'video',
    id: e.id,
    title: tags.title,
    artist: tags.artist,
    album: tags.album,
    channel: e.channel ?? e.uploader ?? null,
    durationSec: e.duration ? Math.round(e.duration) : null,
    views: e.view_count ?? null,
    explicit: false,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
  };
}

const NOISE = /\s*[([][^)\]]*\b(official|oficial|video|vídeo|audio|lyrics?|letra|visuali[sz]er|hd|4k|mv|videoclip)\b[^)\]]*[)\]]/gi;

/**
 * Artista y título para los tags. Las canciones de YouTube Music traen `track`/`artist`; en un
 * video normal se usa "Artista - Título" del nombre o, si no, el canal.
 */
export function tagsFor(info) {
  const artist = firstArtist(info);
  if (info.track && artist) return { title: info.track, artist, album: info.album ?? null };

  const title = String(info.title ?? 'Sin título').replace(NOISE, '').trim();
  const split = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (split) return { artist: split[1].trim(), title: split[2].trim(), album: null };
  return { artist: artist ?? cleanChannel(info.channel ?? info.uploader) ?? 'Artista desconocido', title, album: null };
}

/** YouTube Music a veces lista el grupo y luego sus miembros: ["Cook & Ki$$", "Cook", "Ki$$"] → "Cook & Ki$$". */
function firstArtist(info) {
  if (Array.isArray(info.artists) && info.artists.length > 0) {
    const [first, ...rest] = info.artists.map(String);
    return rest.every((a) => first.includes(a)) ? first : [first, ...rest].join(', ');
  }
  return info.artist ? String(info.artist) : null;
}

/** "Tame Impala - Topic" → "Tame Impala", "TameImpalaVEVO" → "TameImpala" */
function cleanChannel(name) {
  if (!name) return null;
  return String(name).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').trim() || null;
}
