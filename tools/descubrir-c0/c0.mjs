// Fase C0 de la 1.7: prueba de datos para Descubrir (radios, «lo más repetido», géneros).
// Uso: node c0.mjs > resultados.json   (solo lee de YouTube y LRCLIB; no toca la app)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const CLIENTS = {
  music: { name: 'WEB_REMIX', id: 67, version: `1.${today}.01.00` },
  www: { name: 'WEB', id: 1, version: `2.${today}.00.00` },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(host, endpoint, body) {
  const c = CLIENTS[host];
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://${host}.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'X-YouTube-Client-Name': String(c.id), 'X-YouTube-Client-Version': c.version, Origin: `https://${host}.youtube.com` },
      body: JSON.stringify({ context: { client: { clientName: c.name, clientVersion: c.version, hl: 'es', gl: 'MX' } }, ...body }),
    });
    if (res.ok) return res.json();
    await sleep(1500);
  }
  throw new Error(`${host}/${endpoint} falló`);
}

const text = (t) => (t?.runs ?? []).map((r) => r.text).join('') || t?.simpleText || '';

/** Busca canciones (filtro «Canciones» de YouTube Music) y devuelve la primera. */
async function searchSong(q) {
  const r = await call('music', 'search', { query: q, params: 'EgWKAQIIAWoMEA4QChADEAQQCRAF' });
  const shelves = r.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  for (const s of shelves) {
    for (const it of s.musicShelfRenderer?.contents ?? []) {
      const m = it.musicResponsiveListItemRenderer;
      const id = m?.playlistItemData?.videoId ?? m?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!id) continue;
      const cols = m.flexColumns.map((c) => text(c.musicResponsiveListItemFlexColumnRenderer?.text));
      return { videoId: id, title: cols[0], artist: (cols[1] ?? '').split(' • ')[0] };
    }
  }
  return null;
}

function panelItems(panel) {
  return (panel?.contents ?? [])
    .map((c) => c.playlistPanelVideoRenderer ?? c.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer)
    .filter(Boolean)
    .map((v) => ({
      videoId: v.videoId,
      title: text(v.title),
      byline: text(v.longBylineText),
      length: text(v.lengthText),
      type: v.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType ?? null,
    }));
}

/** La radio de una canción: primera página + `pages` continuaciones. */
async function radio(videoId, pages = 2) {
  let r = await call('music', 'next', { videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true });
  let panel = r.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer;
  const items = panelItems(panel);
  const firstPage = items.length;
  for (let p = 0; p < pages; p++) {
    const cont = panel?.continuations?.[0]?.nextRadioContinuationData?.continuation ?? panel?.continuations?.[0]?.nextContinuationData?.continuation;
    if (!cont) break;
    r = await call('music', 'next', { continuation: cont, isAudioOnly: true });
    panel = r.continuationContents?.playlistPanelContinuation;
    items.push(...panelItems(panel));
  }
  return { firstPage, items };
}

/** «Lo más repetido» de un video: marcadores de la gráfica (inicio, duración, intensidad 0-1). */
async function heatmap(videoId) {
  const r = await call('www', 'next', { videoId });
  for (const m of r.frameworkUpdates?.entityBatchUpdate?.mutations ?? []) {
    const list = m.payload?.macroMarkersListEntity?.markersList;
    if (list?.markerType === 'MARKER_TYPE_HEATMAP') {
      return list.markers.map((k) => ({ start: Number(k.startMillis), dur: Number(k.durationMillis), v: k.intensityScoreNormalized }));
    }
  }
  return null;
}

/** Letra sincronizada de LRCLIB → apariciones (s) de la línea que más se repite (el coro, aproximado). */
async function chorus(artist, title, durationSec) {
  const u = new URL('https://lrclib.net/api/get');
  u.search = new URLSearchParams({ artist_name: artist, track_name: title, ...(durationSec ? { duration: String(durationSec) } : {}) }).toString();
  const res = await fetch(u, { headers: { 'User-Agent': 'Impala C0 test' } }).catch(() => null);
  if (!res?.ok) return null;
  const j = await res.json();
  if (!j.syncedLyrics) return null;
  const lines = [];
  for (const l of j.syncedLyrics.split('\n')) {
    const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (m && m[3].trim()) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), s: m[3].trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '') });
  }
  const counts = new Map();
  for (const l of lines) counts.set(l.s, (counts.get(l.s) ?? 0) + 1);
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!best || n < 2) return null;
  return { line: best, times: lines.filter((l) => l.s === best).map((l) => l.t) };
}

/** Video oficial (OMV) de una canción: la gráfica suele estar en el video, no en la pista de audio. */
async function officialVideo(artist, title) {
  const r = await call('music', 'search', { query: `${artist} ${title}`, params: 'EgWKAQIQAWoMEA4QChADEAQQCRAF' });
  const shelves = r.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  for (const s of shelves) for (const it of s.musicShelfRenderer?.contents ?? []) {
    const id = it.musicResponsiveListItemRenderer?.playlistItemData?.videoId;
    if (id) return id;
  }
  return null;
}

const durSec = (len) => len?.split(':').reduce((a, b) => a * 60 + Number(b), 0) || null;

const SEEDS = [
  // pop / urbano en español
  'Bad Bunny Titi Me Pregunto', 'Karol G Provenza', 'Shakira Hips Dont Lie', 'Rosalia Despecha', 'Luis Fonsi Despacito',
  'Peso Pluma Ella Baila Sola', 'Grupo Frontera un x100to', 'Natanael Cano Amor Tumbado', 'Fuerza Regida Bebe Dame',
  // regional / clásicos en español
  'Vicente Fernandez Volver Volver', 'Juan Gabriel Querida', 'Los Tigres del Norte La Puerta Negra', 'Selena Como la Flor',
  'Luis Miguel La Bikina', 'Mana Rayando el Sol', 'Soda Stereo De Musica Ligera', 'Cafe Tacvba Eres',
  // pop / rock en inglés
  'Dua Lipa Levitating', 'The Weeknd Blinding Lights', 'Taylor Swift Shake It Off', 'Ed Sheeran Shape of You',
  'Queen Bohemian Rhapsody', 'Michael Jackson Billie Jean', 'Coldplay Viva la Vida', 'Arctic Monkeys Do I Wanna Know',
  'Nirvana Smells Like Teen Spirit', 'Tame Impala The Less I Know the Better', 'Daft Punk Get Lucky',
  // otros géneros
  'Bob Marley Three Little Birds', 'Eminem Lose Yourself', 'Kendrick Lamar HUMBLE', 'Avicii Wake Me Up',
  'Metallica Enter Sandman', 'Norah Jones Dont Know Why', 'Hans Zimmer Time', 'Marc Anthony Vivir Mi Vida',
  'Romeo Santos Propuesta Indecente', 'Celia Cruz La Vida Es Un Carnaval',
  // religiosa / alabanza (para el público del modo sencillo)
  'Jesus Adrian Romero Mi Universo', 'Marcos Witt Renuevame',
];

const out = { seeds: [], genres: null };
for (const q of SEEDS) {
  const seed = await searchSong(q).catch((e) => ({ error: String(e) }));
  if (!seed?.videoId) { out.seeds.push({ q, error: 'sin resultado' }); continue; }
  const row = { q, seed };
  try {
    const r = await radio(seed.videoId, 2);
    const ids = r.items.map((i) => i.videoId);
    row.radio = {
      firstPage: r.firstPage,
      total: ids.length,
      unique: new Set(ids).size,
      types: r.items.reduce((m, i) => ((m[i.type ?? 'null'] = (m[i.type ?? 'null'] ?? 0) + 1), m), {}),
      sample: r.items.slice(1, 9).map((i) => `${i.title} — ${i.byline.split(' • ')[0]}`),
      ids,
    };
  } catch (e) { row.radio = { error: String(e) }; }
  try {
    const len = row.radio?.ids ? null : null;
    let hm = await heatmap(seed.videoId);
    let from = 'pista';
    if (!hm) {
      const omv = await officialVideo(seed.artist, seed.title);
      if (omv && omv !== seed.videoId) { hm = await heatmap(omv); from = 'video oficial'; }
    }
    if (hm?.length) {
      const total = hm.at(-1).start + hm.at(-1).dur;
      // Pico: la ventana de 15 s con más intensidad media (más estable que el marcador máximo suelto).
      let best = { at: 0, score: -1 };
      for (let i = 0; i < hm.length; i++) {
        const win = hm.filter((k) => k.start >= hm[i].start && k.start < hm[i].start + 15000);
        const score = win.reduce((a, k) => a + k.v, 0) / win.length;
        if (score > best.score) best = { at: hm[i].start / 1000, score };
      }
      row.heatmap = { from, markers: hm.length, totalSec: Math.round(total / 1000), peakSec: Math.round(best.at), peakPct: Math.round((best.at * 1000 / total) * 100) };
      const ch = await chorus(seed.artist, seed.title, row.heatmap.totalSec).catch(() => null);
      if (ch) {
        // ¿El pico cae dentro de una aparición del coro (de 5 s antes a 25 s después de que empieza la línea)?
        const hit = ch.times.some((t) => best.at >= t - 5 && best.at <= t + 25);
        row.chorus = { line: ch.line.slice(0, 60), times: ch.times.map(Math.round), peakInChorus: hit };
      }
    } else row.heatmap = null;
  } catch (e) { row.heatmapError = String(e); }
  out.seeds.push(row);
  process.stderr.write(`${q}: radio ${row.radio?.unique ?? '-'} · heatmap ${row.heatmap ? row.heatmap.peakPct + '%' : 'no'}${row.chorus ? (row.chorus.peakInChorus ? ' · coro ✔' : ' · coro ✘') : ''}\n`);
  await sleep(400);
}

// Ánimo y géneros
try {
  const g = await call('music', 'browse', { browseId: 'FEmusic_moods_and_genres' });
  const sections = g.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const groups = sections.map((s) => {
    const grid = s.gridRenderer;
    return {
      title: text(grid?.header?.gridHeaderRenderer?.title),
      items: (grid?.items ?? []).map((i) => ({ name: text(i.musicNavigationButtonRenderer?.buttonText), params: i.musicNavigationButtonRenderer?.clickCommand?.browseEndpoint?.params })),
    };
  });
  out.genres = groups.map((g2) => ({ title: g2.title, names: g2.items.map((i) => i.name) }));
  // Abrir 3 géneros: cuántas listas trae cada uno.
  const pick = groups.flatMap((x) => x.items).filter((i) => i.params).slice(0, 40);
  const sample = [pick[0], pick[Math.floor(pick.length / 2)], pick.at(-1)].filter(Boolean);
  out.genreSamples = [];
  for (const i of sample) {
    const b = await call('music', 'browse', { browseId: 'FEmusic_moods_and_genres_category', params: i.params });
    const secs = b.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
    const lists = secs.flatMap((s) => (s.gridRenderer?.items ?? s.musicCarouselShelfRenderer?.contents ?? []).map((it) => text(it.musicTwoRowItemRenderer?.title)));
    out.genreSamples.push({ name: i.name, sections: secs.length, playlists: lists.length, examples: lists.slice(0, 6) });
  }
} catch (e) { out.genresError = String(e); }

console.log(JSON.stringify(out, null, 1));
