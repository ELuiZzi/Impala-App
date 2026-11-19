// C0, segunda pasada: el «pico» como el mayor repunte sobre la caída natural de la gráfica, en la pista de
// audio y en el video oficial, comparado con el coro (letra de LRCLIB) y con alternativas simples.
import { readFileSync } from 'node:fs';
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const data = JSON.parse(readFileSync(new URL('./resultados.json', import.meta.url)));

async function call(host, endpoint, body, client) {
  const res = await fetch(`https://${host}.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: `https://${host}.youtube.com` },
    body: JSON.stringify({ context: { client: { ...client, hl: 'es', gl: 'MX' } }, ...body }),
  });
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`);
  return res.json();
}
const WEB = { clientName: 'WEB', clientVersion: `2.${today}.00.00` };
const REMIX = { clientName: 'WEB_REMIX', clientVersion: `1.${today}.01.00` };

async function heatmap(videoId) {
  const r = await call('www', 'next', { videoId }, WEB);
  for (const m of r.frameworkUpdates?.entityBatchUpdate?.mutations ?? []) {
    const l = m.payload?.macroMarkersListEntity?.markersList;
    if (l?.markerType === 'MARKER_TYPE_HEATMAP') return l.markers.map((k) => ({ t: Number(k.startMillis) / 1000, d: Number(k.durationMillis) / 1000, v: k.intensityScoreNormalized }));
  }
  return null;
}

async function officialVideo(artist, title) {
  const r = await call('music', 'search', { query: `${artist} ${title}`, params: 'EgWKAQIQAWoMEA4QChADEAQQCRAF' }, REMIX);
  const shelves = r.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  for (const s of shelves) for (const it of s.musicShelfRenderer?.contents ?? []) {
    const id = it.musicResponsiveListItemRenderer?.playlistItemData?.videoId;
    if (id) return id;
  }
  return null;
}

/**
 * Repunte: cada marcador menos la mediana de sus vecinos (±8 marcadores, la caída natural); se ignoran el 5 %
 * del principio y del final. El pico es la ventana de ~15 s con más repunte medio. `prominence` dice cuánto
 * destaca (0 = la gráfica solo baja).
 */
function peak(hm) {
  const n = hm.length;
  const res = hm.map((k, i) => {
    const nb = hm.slice(Math.max(0, i - 8), Math.min(n, i + 9)).map((x) => x.v).sort((a, b) => a - b);
    return k.v - nb[Math.floor(nb.length / 2)];
  });
  const total = hm.at(-1).t + hm.at(-1).d;
  const step = hm[1].t - hm[0].t || 1;
  const w = Math.max(1, Math.round(15 / step));
  let best = { i: -1, s: -Infinity };
  for (let i = Math.floor(n * 0.05); i < Math.ceil(n * 0.95) - w; i++) {
    const s = res.slice(i, i + w).reduce((a, b) => a + b, 0) / w;
    if (s > best.s) best = { i, s };
  }
  return { at: hm[best.i].t, total, prominence: +best.s.toFixed(3) };
}

const inChorus = (sec, times) => times.some((t) => sec >= t - 5 && sec <= t + 25);
/** Probabilidad de acertar el coro con un punto al azar (parte de la canción que cubren sus ventanas). */
function chance(times, total) {
  let hits = 0;
  for (let s = 0; s < total; s++) if (inChorus(s, times)) hits++;
  return hits / total;
}

const rows = [];
for (const s of data.seeds) {
  if (!s.chorus) continue;
  const row = { q: s.q, chorus: s.chorus.times };
  try {
    const a = await heatmap(s.seed.videoId);
    if (a) row.track = peak(a);
    const omv = await officialVideo(s.seed.artist, s.seed.title);
    if (omv && omv !== s.seed.videoId) {
      const b = await heatmap(omv);
      if (b) row.video = { ...peak(b), id: omv };
    }
  } catch (e) { row.error = String(e); }
  const total = row.track?.total ?? row.video?.total;
  if (total) {
    row.chance = +chance(row.chorus, total).toFixed(2);
    row.fixed30 = inChorus(total * 0.3, row.chorus);
    if (row.track) row.trackHit = inChorus(row.track.at, row.chorus);
    if (row.video) row.videoHit = inChorus(row.video.at, row.chorus);
  }
  rows.push(row);
  process.stderr.write(`${s.q}: pista ${row.track ? Math.round(row.track.at) + 's ' + (row.trackHit ? '✔' : '✘') : '-'} · video ${row.video ? Math.round(row.video.at) + 's ' + (row.videoHit ? '✔' : '✘') : '-'} · 30% ${row.fixed30 ? '✔' : '✘'} · azar ${row.chance}\n`);
  await sleep(300);
}

const pct = (k) => {
  const xs = rows.filter((r) => r[k] !== undefined);
  return `${xs.filter((r) => r[k]).length}/${xs.length}`;
};
const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
console.log(JSON.stringify({
  canciones: rows.length,
  aciertoPista: pct('trackHit'),
  aciertoVideo: pct('videoHit'),
  acierto30: pct('fixed30'),
  azarMedio: avg(rows.filter((r) => r.chance !== undefined).map((r) => r.chance)),
  prominenciaMediaPista: avg(rows.filter((r) => r.track).map((r) => r.track.prominence)),
  prominenciaMediaVideo: avg(rows.filter((r) => r.video).map((r) => r.video.prominence)),
  rows,
}, null, 1));
