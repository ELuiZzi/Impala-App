import busboy from 'busboy';
import express from 'express';
import { parseFile } from 'music-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createAuth, httpError } from './auth.js';
import { sanitizeFilename } from './filename.js';
import { createAnonCookies } from './anoncookies.js';
import { createImporter } from './importer.js';
import { createLibrary } from './library.js';
import { createLyrics } from './lyrics.js';
import { createSubsonic, findSongByFile } from './navidrome.js';
import { storeUnique } from './store.js';
import { createYoutube } from './youtube.js';

export const TMP_DIRNAME = '.impala-tmp';
/** Un álbum o una tanda de canciones; YouTube las descarga de una en una. */
const MAX_BATCH_DOWNLOADS = 100;

/**
 * config: { musicDir, uploadSubdir, token, navidromeUrl?, maxFileSize, fetchImpl?, ytDlp?, python?, ytCookiesFile?, ytExtractorArgs?,
 *          appleMusicToken?, spawnImpl?, importerOptions? }
 * Sin `ytDlp` (ruta al ejecutable) las rutas de YouTube (y la importación de Apple Music) responden 503.
 * El directorio temporal vive dentro de musicDir para que el paso final sea un link()
 * dentro del mismo montaje (atómico); un .ndignore evita que Navidrome lo indexe.
 */
export async function createApp(config) {
  const tmpDir = path.join(config.musicDir, TMP_DIRNAME);
  const destDir = path.join(config.musicDir, config.uploadSubdir);
  await prepareTmpDir(tmpDir);
  await fs.mkdir(destDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');

  const router = express.Router();
  router.get('/health', (_req, res) => res.json({ ok: true }));
  const auth = createAuth({ token: config.token, navidromeUrl: config.navidromeUrl, fetchImpl: config.fetchImpl });
  router.post('/', auth, async (req, res) => {
    const received = await receiveFile(req, { tmpDir, maxFileSize: config.maxFileSize });
    const metadata = await readMetadata(received.tmpFile);
    const stored = await storeUnique(received.tmpFile, destDir, received.name, received);

    res.status(stored.duplicate ? 200 : 201).json({
      file: path.posix.join(config.uploadSubdir, stored.fileName),
      originalName: received.originalName,
      size: received.size,
      md5: received.md5,
      duplicate: stored.duplicate,
      metadata,
    });
    console.log(`${stored.duplicate ? 'duplicado' : 'guardado'}: ${stored.fileName} (${received.size} B)`);
  });

  // Letras sincronizadas de una canción (del archivo o de LRCLIB).
  const lyrics = createLyrics({ navidromeUrl: config.navidromeUrl, cacheDir: config.lyricsCacheDir, fetchImpl: config.fetchImpl });
  router.get('/lyrics/:songId', auth, async (req, res) => {
    res.json({ lyrics: await lyrics.get(req.params.songId, req.query) });
  });

  // Borrar y recortar canciones: solo con las credenciales Subsonic de un administrador.
  const library = createLibrary({
    musicDir: config.musicDir,
    tmpDir,
    navidromeUrl: config.navidromeUrl,
    backupDir: config.trimBackupDir ?? null,
    lyrics,
    trimmer: config.trimmer,
    fetchImpl: config.fetchImpl,
  });
  router.delete('/songs/:id', auth, async (req, res) => {
    res.json(await library.deleteSong(req.params.id, req.query));
  });
  router.get('/songs/:id/trim', auth, async (req, res) => {
    res.json(await library.trimInfo(req.params.id, req.query));
  });
  router.get('/songs/:id/waveform', auth, async (req, res) => {
    res.json(await library.waveform(req.params.id, req.query));
  });
  // { keep: [[inicio, fin], …] } en segundos: los tramos que se conservan.
  router.post('/songs/:id/trim', auth, express.json({ limit: '16kb' }), async (req, res) => {
    res.json(await library.trimSong(req.params.id, req.query, req.body));
  });
  router.post('/songs/:id/restore', auth, async (req, res) => {
    res.json(await library.restoreSong(req.params.id, req.query));
  });

  const youtube = config.ytDlp
    ? createYoutube({
        ytDlp: config.ytDlp,
        python: config.python,
        destDir,
        tmpDir,
        uploadSubdir: config.uploadSubdir,
        cookiesFile: config.ytCookiesFile,
        extractorArgs: config.ytExtractorArgs,
        historyFile: config.ytHistoryFile,
        anonCookies: config.ytAnonCookiesFile ? createAnonCookies({ file: config.ytAnonCookiesFile, fetchImpl: config.fetchImpl }) : null,
        spawnImpl: config.spawnImpl,
        fetchImpl: config.fetchImpl,
      })
    : null;
  const requireYoutube = (_req, _res, next) => (youtube ? next() : next(httpError(503, 'yt-dlp no está instalado en el servidor')));
  router.get('/youtube/search', auth, requireYoutube, async (req, res) => {
    res.json(await youtube.search(req.query.q, req.query.scope ?? 'all'));
  });
  router.get('/youtube/albums/:id', auth, requireYoutube, async (req, res) => {
    res.json({ album: await youtube.album(req.params.id) });
  });
  // Por id de canal (resultados de búsqueda) o ?name= (página de un artista de la biblioteca).
  router.get('/youtube/artists', auth, requireYoutube, async (req, res) => {
    res.json({ artist: await youtube.artist({ name: req.query.name }) });
  });
  router.get('/youtube/artists/:id', auth, requireYoutube, async (req, res) => {
    res.json({ artist: await youtube.artist({ id: req.params.id }) });
  });
  // Cliente de YouTube con el que la app pide desde el teléfono el audio de las vistas previas.
  router.get('/youtube/client', auth, requireYoutube, async (_req, res) => {
    res.json({ client: await youtube.audioClient() });
  });
  // El reproductor de la app pide el audio con las credenciales en la query, como el stream de Subsonic.
  router.get('/youtube/preview/:id', auth, requireYoutube, async (req, res) => {
    await youtube.streamPreview(req.params.id, req, res);
  });
  router.get('/youtube/downloads', auth, requireYoutube, (_req, res) => {
    res.json({ jobs: youtube.list() });
  });
  // { id, title?, artist? } o, para un álbum entero, { items: [{ id, title, artist, album, albumArtist, trackNumber, year }] }.
  router.post('/youtube/downloads', auth, requireYoutube, express.json({ limit: '128kb' }), (req, res) => {
    const items = req.body?.items;
    if (Array.isArray(items)) {
      if (items.length === 0 || items.length > MAX_BATCH_DOWNLOADS) throw httpError(400, `Entre 1 y ${MAX_BATCH_DOWNLOADS} descargas a la vez`);
      // Se validan todas antes de encolar ninguna.
      for (const item of items) if (typeof item?.id !== 'string') throw httpError(400, 'Identificador de video inválido');
      return res.status(202).json({ jobs: items.map((item) => youtube.enqueue(item.id, item)) });
    }
    // Una sola canción la pide alguien esperando el resultado: va delante de las tandas.
    res.status(202).json({ job: youtube.enqueue(req.body?.id, { ...req.body, priority: true }) });
  });

  // La canción en la biblioteca una vez descargada (para reproducirla, añadirla a la cola, etc.).
  // 202 mientras se descarga o Navidrome aún no la indexa.
  const navidrome = createSubsonic({ navidromeUrl: config.navidromeUrl, client: 'impala-library', fetchImpl: config.fetchImpl });
  router.get('/youtube/downloads/:id/song', auth, requireYoutube, async (req, res) => {
    const job = youtube.get(req.params.id);
    if (!job) throw httpError(404, 'No existe esa descarga');
    if (job.status === 'error' || job.status === 'cancelled') throw httpError(422, job.error ?? 'La descarga se canceló');
    if (job.status !== 'done') return res.status(202).json({ job });
    const song = await findSongByFile(navidrome, req.query, { title: job.title, artist: job.artist, file: job.file });
    if (!song) return res.status(202).json({ job });
    res.json({ song });
  });
  router.delete('/youtube/downloads/:id', auth, requireYoutube, (req, res) => {
    res.json({ job: youtube.cancel(req.params.id) });
  });

  // Importar playlists de Apple Music (las canciones que faltan se descargan de YouTube).
  const importer = youtube
    ? createImporter({ youtube, navidromeUrl: config.navidromeUrl, fetchImpl: config.fetchImpl, appleToken: config.appleMusicToken, stateFile: config.importsStateFile, ...config.importerOptions })
    : null;
  router.get('/applemusic/imports', auth, requireYoutube, (req, res) => {
    res.json({ imports: importer.list(req.query) });
  });
  router.post('/applemusic/imports', auth, requireYoutube, express.json({ limit: '4kb' }), (req, res) => {
    res.status(202).json({ import: importer.create(req.body?.url, req.query) });
  });
  router.get('/applemusic/imports/:id', auth, requireYoutube, (req, res) => {
    res.json({ import: importer.get(req.params.id, req.query) });
  });
  router.post('/applemusic/imports/:id/start', auth, requireYoutube, express.json({ limit: '16kb' }), (req, res) => {
    res.json({ import: importer.start(req.params.id, req.query, req.body ?? {}) });
  });
  router.post('/applemusic/imports/:id/retry', auth, requireYoutube, (req, res) => {
    res.json({ import: importer.retry(req.params.id, req.query) });
  });
  router.post('/applemusic/imports/:id/cancel', auth, requireYoutube, (req, res) => {
    res.json({ import: importer.cancel(req.params.id, req.query) });
  });
  router.delete('/applemusic/imports/:id', auth, requireYoutube, (req, res) => {
    importer.remove(req.params.id, req.query);
    res.status(204).end();
  });

  // tailscale serve publica el servicio en /upload; según la versión puede o no recortar
  // ese prefijo, así que aceptamos ambas formas.
  app.use('/upload', router);
  app.use('/', router);

  app.use((_req, res) => res.status(404).json({ error: 'No encontrado' }));
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Error interno' : err.message });
  });

  return app;
}

async function prepareTmpDir(tmpDir) {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.ndignore'), '');
  // Restos de subidas (y carpetas de descargas de YouTube) interrumpidas por un reinicio.
  for (const entry of await fs.readdir(tmpDir)) {
    if (entry !== '.ndignore') await fs.rm(path.join(tmpDir, entry), { recursive: true, force: true });
  }
}

/** Recibe un único archivo (campo "file") en streaming hacia tmpDir, calculando MD5 y tamaño al vuelo. */
function receiveFile(req, { tmpDir, maxFileSize }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      // defParamCharset: por defecto busboy decodifica el nombre como latin1 ("Canción" → "CanciÃ³n").
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 1, fileSize: maxFileSize } });
    } catch {
      return reject(httpError(415, 'Se esperaba multipart/form-data'));
    }

    let filePromise = null;
    let rejection = null;

    bb.on('file', (field, stream, info) => {
      if (field !== 'file' || filePromise || rejection) return stream.resume();

      const name = sanitizeFilename(info.filename);
      if (!name) {
        rejection = httpError(415, `Formato no soportado: ${info.filename}`);
        return stream.resume();
      }

      const tmpFile = path.join(tmpDir, `${randomUUID()}${name.ext}`);
      const hash = createHash('md5');
      let size = 0;
      let truncated = false;
      stream.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
      stream.on('limit', () => { truncated = true; });

      filePromise = pipeline(stream, createWriteStream(tmpFile, { mode: 0o644 }))
        .then(() => ({ tmpFile, name, size, md5: hash.digest('hex'), truncated, originalName: info.filename }))
        .catch(async (err) => {
          await fs.rm(tmpFile, { force: true });
          throw err;
        });
      filePromise.catch(() => {}); // se maneja al esperar en 'close'; evita unhandledRejection
    });

    bb.on('error', async (err) => {
      await filePromise?.then((f) => fs.rm(f.tmpFile, { force: true })).catch(() => {});
      reject(httpError(400, `Subida incompleta: ${err.message}`));
    });

    bb.on('close', async () => {
      try {
        if (rejection) throw rejection;
        if (!filePromise) throw httpError(400, 'Falta el campo "file"');
        const file = await filePromise;
        if (file.truncated) {
          await fs.rm(file.tmpFile, { force: true });
          throw httpError(413, `El archivo supera el límite de ${Math.round(maxFileSize / 1024 ** 2)} MB`);
        }
        if (file.size === 0) {
          await fs.rm(file.tmpFile, { force: true });
          throw httpError(400, 'El archivo está vacío');
        }
        resolve(file);
      } catch (err) {
        reject(err);
      }
    });

    req.pipe(bb);
  });
}

/** Valida que sea audio legible y extrae lo básico; si no lo es, borra el temporal. */
async function readMetadata(tmpFile) {
  try {
    const { common, format } = await parseFile(tmpFile, { skipCovers: true });
    // Con archivos truncados o muy cortos music-metadata no lanza error: devuelve el formato vacío.
    if (!format.sampleRate && !format.duration) throw new Error('Sin cabecera de audio');
    return {
      title: common.title ?? null,
      artist: common.artist ?? null,
      album: common.album ?? null,
      durationSec: format.duration ? Math.round(format.duration) : null,
      codec: format.codec ?? null,
      sampleRate: format.sampleRate ?? null,
      bitsPerSample: format.bitsPerSample ?? null,
    };
  } catch {
    await fs.rm(tmpFile, { force: true });
    throw httpError(422, 'El archivo no es un audio válido');
  }
}
