import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { readApplePlaylist } from './applemusic.js';
import { httpError } from './auth.js';
import { bestMatch, coreTitle } from './match.js';
import { createSubsonic, findSongByFile } from './navidrome.js';

const MAX_FINISHED = 10;
const MATCH_BATCH = 10;
const POLL_MS = 3_000;
/** Tras descargarse, Navidrome tarda ~2 s en ver el archivo; se espera hasta esto antes de rendirse. */
const INDEX_TIMEOUT_MS = 2 * 60_000;
const MAX_NAME = 120;

/**
 * Importa playlists de Apple Music. Cada importación es un trabajo en memoria del servidor, para
 * que siga aunque se cierre la app:
 *
 *  1. reading/matching: lee la playlist y busca cada canción en la biblioteca (Navidrome) y, las que
 *     faltan, en YouTube Music.
 *  2. review: la app muestra el resultado; el usuario elige qué descargar y el nombre.
 *  3. downloading: descarga las que faltan (cola de YouTube) y espera a que Navidrome las indexe.
 *  4. saving → done: crea la playlist en Navidrome con las canciones en el orden de Apple Music.
 *
 * Se usan las credenciales Subsonic del usuario que la pidió (la playlist será suya).
 * config: { youtube, navidromeUrl, fetchImpl?, appleToken?, readPlaylist?, pollMs?, indexTimeoutMs?, stateFile? }
 * stateFile: JSON donde se guardan las importaciones para retomarlas tras un reinicio.
 */
export function createImporter({
  youtube,
  navidromeUrl,
  fetchImpl = fetch,
  appleToken = null,
  readPlaylist = (url) => readApplePlaylist(url, { fetchImpl, token: appleToken }),
  pollMs = POLL_MS,
  indexTimeoutMs = INDEX_TIMEOUT_MS,
  stateFile = null,
  persistDelayMs = 1_000,
}) {
  // impala-library: el cliente que Navidrome ya tiene configurado para reportar la ruta real.
  const subsonic = createSubsonic({ navidromeUrl, client: 'impala-library', fetchImpl });
  const jobs = new Map();

  function credsOf(query) {
    const { u, t, s } = query ?? {};
    if (typeof u !== 'string' || typeof t !== 'string' || typeof s !== 'string') {
      throw httpError(400, 'Importar requiere las credenciales Subsonic de la app');
    }
    return { u, t, s };
  }

  function owned(id, query) {
    const job = jobs.get(String(id));
    if (!job || job.creds.u !== credsOf(query).u) throw httpError(404, 'No existe esa importación');
    return job;
  }

  function create(url, query) {
    const creds = credsOf(query);
    if (typeof url !== 'string' || url.length > 500) throw httpError(400, 'Falta el enlace de la playlist');
    const job = {
      id: randomUUID(),
      url: url.trim(),
      creds,
      status: 'reading',
      progress: 0,
      name: null,
      curator: null,
      artwork: null,
      trackCount: 0,
      tracks: [],
      warning: null,
      error: null,
      playlistId: null,
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    prune();
    persist();
    analyze(job).catch((err) => fail(job, err));
    return publicJob(job);
  }

  async function analyze(job) {
    const playlist = await readPlaylist(job.url);
    Object.assign(job, { name: playlist.name, curator: playlist.curator, artwork: playlist.artwork, trackCount: playlist.trackCount, status: 'matching' });
    if (playlist.trackCount > playlist.tracks.length) {
      job.warning = `Apple Music solo mostró ${playlist.tracks.length} de ${playlist.trackCount} canciones.`;
    }
    job.tracks = playlist.tracks.map((t, index) => ({ index, ...t, state: 'pending', match: null, error: null }));
    const total = job.tracks.length * 2;

    // 1. En la biblioteca: búsqueda por el título "limpio" y emparejado por título, artista y duración.
    for (const track of job.tracks) {
      const found = await searchLibrary(job.creds, track);
      if (found) {
        track.state = 'library';
        track.match = { source: 'library', songId: found.id, title: found.title, artist: found.artist ?? null };
      }
      job.progress = (track.index + 1) / total;
    }

    // 2. Las que faltan, en YouTube Music (en tandas, para ir mostrando el progreso).
    const missing = job.tracks.filter((t) => t.state === 'pending');
    let done = job.tracks.length;
    for (let i = 0; i < missing.length; i += MATCH_BATCH) {
      const batch = missing.slice(i, i + MATCH_BATCH);
      const results = await youtube.matchSongs(batch.map((t) => `${t.artist} ${coreTitle(t.title) || t.title}`)).catch((err) => {
        console.error('importar: búsqueda en YouTube Music:', err.message);
        return batch.map(() => []);
      });
      batch.forEach((track, j) => {
        const song = bestMatch(track, results[j] ?? []);
        track.state = song ? 'youtube' : 'notFound';
        if (song) {
          track.match = { source: 'youtube', videoId: song.id, title: song.title, artist: song.artist, album: song.album, durationSec: song.durationSec, thumbnail: song.thumbnail };
        }
      });
      done += batch.length;
      job.progress = done / total;
    }
    job.progress = 1;
    job.status = 'review';
    persist();
  }

  async function searchLibrary(creds, track) {
    const query = coreTitle(track.title) || track.title;
    const { searchResult3 } = await subsonic(creds, 'search3', { query, songCount: 30, albumCount: 0, artistCount: 0 });
    const songs = (searchResult3?.song ?? []).map((s) => ({ ...s, durationSec: s.duration }));
    return bestMatch(track, songs);
  }

  /** Descarga las elegidas y crea la playlist. options: { name?, skip?: number[], appendTo?: id de una playlist existente } */
  function start(id, query, options = {}) {
    const job = owned(id, query);
    if (job.status !== 'review') throw httpError(409, 'La importación no está lista para empezar');
    const name = typeof options.name === 'string' && options.name.trim() ? options.name.trim().slice(0, MAX_NAME) : job.name;
    const skip = new Set(Array.isArray(options.skip) ? options.skip.filter(Number.isInteger) : []);
    job.name = name;
    job.creds = credsOf(query); // las más recientes, por si la sesión de la app cambió
    // Destino opcional: añadir a una playlist que ya existe en vez de crear (o actualizar) la del nombre.
    job.appendTo = typeof options.appendTo === 'string' && options.appendTo ? options.appendTo.slice(0, 100) : null;
    for (const track of job.tracks) if (track.state === 'youtube' && skip.has(track.index)) track.state = 'skipped';
    job.status = 'downloading';
    job.progress = 0;
    persist();
    download(job).catch((err) => fail(job, err));
    return publicJob(job);
  }

  async function download(job) {
    const wanted = job.tracks.filter((t) => t.state === 'youtube');
    for (const track of wanted) {
      try {
        // Los tags salen de Apple Music: título, artista y álbum como en la playlist original.
        const yt = youtube.enqueue(track.match.videoId, { title: track.title, artist: track.artist, album: track.album ?? track.match.album ?? track.title });
        Object.assign(track, { state: 'downloading', jobId: yt.id, progress: 0 });
      } catch (err) {
        Object.assign(track, { state: 'failed', error: err.message });
      }
    }

    // Espera a que cada descarga termine y Navidrome la indexe.
    while (job.tracks.some((t) => t.state === 'downloading' || t.state === 'indexing')) {
      await sleep(pollMs);
      for (const track of job.tracks) {
        if (track.state === 'downloading') {
          const yt = youtube.get(track.jobId);
          if (!yt) Object.assign(track, { state: 'failed', error: 'Se perdió la descarga' });
          else if (yt.status === 'error') Object.assign(track, { state: 'failed', error: yt.error ?? 'No se pudo descargar' });
          else if (yt.status === 'cancelled') Object.assign(track, { state: 'skipped', waitingUntil: null });
          else if (yt.status === 'done') Object.assign(track, { state: 'indexing', file: yt.file, indexingSince: Date.now(), progress: 1, waitingUntil: null });
          else Object.assign(track, { progress: yt.progress ?? 0, waitingUntil: yt.waitingUntil ?? null });
        }
        if (track.state === 'indexing') {
          const song = await findIndexed(job.creds, track).catch(() => null);
          if (song) Object.assign(track, { state: 'added', match: { source: 'library', songId: song.id, title: song.title, artist: song.artist ?? null } });
          else if (Date.now() - track.indexingSince > indexTimeoutMs) {
            Object.assign(track, { state: 'failed', error: 'Se descargó, pero Navidrome aún no la muestra' });
          }
        }
      }
      const finished = wanted.filter((t) => t.state === 'added' || t.state === 'failed' || t.state === 'skipped').length;
      job.progress = wanted.length ? finished / wanted.length : 1;
      persist();
    }

    job.status = 'saving';
    const songIds = job.tracks.filter((t) => t.match?.source === 'library').map((t) => t.match.songId);
    if (songIds.length === 0) throw httpError(422, 'Ninguna canción quedó en la biblioteca');
    // Añadir a una playlist existente: solo las que aún no tiene, al final y en el orden de Apple Music.
    if (job.appendTo) {
      const { playlist } = await subsonic(job.creds, 'getPlaylist', { id: job.appendTo });
      if (playlist?.owner && playlist.owner !== job.creds.u) throw httpError(403, 'Esa playlist es de otro usuario');
      const present = new Set((playlist?.entry ?? []).map((e) => e.id));
      const missing = [...new Set(songIds)].filter((id) => !present.has(id));
      if (missing.length > 0) await subsonic(job.creds, 'updatePlaylist', { playlistId: job.appendTo, songIdToAdd: missing });
      Object.assign(job, { playlistId: job.appendTo, name: playlist?.name ?? job.name, status: 'done', progress: 1 });
      persist();
      console.log(`importar: ${missing.length} canciones añadidas a "${job.name}"`);
      return;
    }
    // Volver a importar la misma playlist (p. ej. para completar las que fallaron) actualiza la que ya
    // existe con ese nombre en vez de duplicarla.
    if (!job.playlistId) {
      const { playlists } = await subsonic(job.creds, 'getPlaylists', {});
      const same = (playlists?.playlist ?? []).find((p) => p.name === job.name && (!p.owner || p.owner === job.creds.u));
      if (same) job.playlistId = same.id;
    }
    // Al reintentar, o si ya existía, se sustituye su contenido (mismo orden de Apple).
    const replaced = job.playlistId
      ? await subsonic(job.creds, 'createPlaylist', { playlistId: job.playlistId, songId: songIds }).then(() => true, () => false)
      : false;
    if (!replaced) {
      const { playlist } = await subsonic(job.creds, 'createPlaylist', { name: job.name, songId: songIds });
      job.playlistId = playlist?.id ?? null;
    }
    job.status = 'done';
    job.progress = 1;
    persist();
    console.log(`importar: playlist "${job.name}" con ${songIds.length} canciones`);
  }

  /**
   * Cancela lo que falta por descargar: las canciones ya en la biblioteca se guardan igual en la
   * playlist; las canceladas quedan como omitidas.
   */
  function cancel(id, query) {
    const job = owned(id, query);
    if (job.status !== 'downloading') throw httpError(409, 'No hay descargas en curso');
    for (const track of job.tracks) {
      if (track.state === 'downloading' && track.jobId) {
        try {
          youtube.cancel(track.jobId);
        } catch {
          // Ya guardándose o ya terminada: se deja seguir.
        }
      }
    }
    persist();
    return publicJob(job);
  }

  /** Vuelve a descargar las canciones que fallaron y actualiza la playlist ya creada. */
  function retry(id, query) {
    const job = owned(id, query);
    if (job.status !== 'done' && job.status !== 'error') throw httpError(409, 'La importación sigue en curso');
    const failed = job.tracks.filter((t) => t.state === 'failed' && t.match?.source === 'youtube');
    if (failed.length === 0) throw httpError(409, 'No hay canciones que reintentar');
    for (const track of failed) Object.assign(track, { state: 'youtube', error: null, progress: 0 });
    Object.assign(job, { creds: credsOf(query), status: 'downloading', progress: 0, error: null });
    persist();
    download(job).catch((err) => fail(job, err));
    return publicJob(job);
  }

  /** La canción descargada, ya en Navidrome: por la ruta del archivo o, si no la reporta, por los tags. */
  // Los tags del archivo son los de Apple Music; antes de descargarla no había ninguna así.
  const findIndexed = (creds, track) => findSongByFile(subsonic, creds, track);

  function fail(job, err) {
    job.status = 'error';
    job.error = err.status ? err.message : 'No se pudo completar la importación';
    if (!err.status) console.error('importar:', err);
    persist();
  }

  // --- Persistencia: un reinicio del uploader no pierde las importaciones ----------------------
  // El archivo guarda también el token Subsonic de cada usuario (necesario para terminar el trabajo),
  // así que se escribe solo legible por el usuario del contenedor.

  let persistTimer = null;
  function persist() {
    if (!stateFile || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const data = JSON.stringify([...jobs.values()]);
      fs.writeFile(`${stateFile}.tmp`, data, { mode: 0o600 })
        .then(() => fs.rename(`${stateFile}.tmp`, stateFile))
        .catch((err) => console.error('importar: no se pudo guardar el estado:', err.message));
    }, persistDelayMs);
  }

  function restore() {
    if (!stateFile) return;
    let saved;
    try {
      saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('importar: estado ilegible, se descarta:', err.message);
      return;
    }
    for (const job of Array.isArray(saved) ? saved : []) {
      if (!job?.id || !job.creds) continue;
      jobs.set(job.id, job);
      if (job.status === 'reading' || job.status === 'matching') {
        Object.assign(job, { status: 'error', error: 'Se interrumpió por un reinicio del servidor; vuelve a pegar el enlace' });
      } else if (job.status === 'downloading' || job.status === 'saving') {
        // La cola de YouTube no sobrevive al reinicio: lo que se estaba descargando se vuelve a pedir
        // (si ya estaba guardado, se reconoce como duplicado).
        for (const track of job.tracks) if (track.state === 'downloading') Object.assign(track, { state: 'youtube', progress: 0 });
        job.status = 'downloading';
        download(job).catch((err) => fail(job, err));
      }
    }
    if (jobs.size > 0) console.log(`importar: ${jobs.size} importaciones restauradas`);
  }
  restore();

  function list(query) {
    const { u } = credsOf(query);
    return [...jobs.values()].filter((j) => j.creds.u === u).sort((a, b) => b.createdAt - a.createdAt).map((j) => publicJob(j, false));
  }

  const get = (id, query) => publicJob(owned(id, query));

  /** Descarta una importación que no ha empezado a descargar, o una ya terminada. */
  function remove(id, query) {
    const job = owned(id, query);
    if (job.status === 'downloading' || job.status === 'saving') throw httpError(409, 'La importación está en curso');
    jobs.delete(job.id);
    persist();
  }

  function prune() {
    const finished = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'error').sort((a, b) => a.createdAt - b.createdAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) jobs.delete(job.id);
  }

  return { create, start, retry, cancel, get, list, remove };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function publicJob(job, withTracks = true) {
  const { id, url, status, progress, name, curator, artwork, trackCount, warning, error, playlistId, createdAt } = job;
  const counts = { library: 0, youtube: 0, notFound: 0, skipped: 0, added: 0, failed: 0 };
  for (const t of job.tracks) if (t.state in counts) counts[t.state]++;
  return {
    id, url, status, progress, name, curator, artwork, trackCount, warning, error, playlistId, createdAt, counts,
    ...(withTracks && {
      tracks: job.tracks.map(({ index, title, artist, album, durationSec, explicit, artwork: art, state, match, error: e, progress: p, waitingUntil }) => ({
        index, title, artist, album, durationSec, explicit, artwork: art, state, match, error: e, progress: p ?? null, waitingUntil: waitingUntil ?? null,
      })),
    }),
  };
}
