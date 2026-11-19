/**
 * La «mejor parte» de una canción para Descubrir: el coro, sacado de la letra sincronizada de LRCLIB (la C0 lo
 * comprobó: «lo más repetido» de YouTube acierta menos que el azar; el coro de la letra, ~80 %). Sin letra
 * (instrumentales, canciones poco conocidas), el 30 % de la canción (53 % de acierto en la C0).
 *
 * Sin dependencias de la app: lo prueba app/test/discover.test.mjs.
 */

export type TimedLine = { timeMs: number; text: string };

/** Lo que dura cada canción en Descubrir antes de pasar a la siguiente (salvo «escuchar entera»). */
export const CLIP_MS = 30_000;
/** Se empieza un poco antes del coro, para no entrar a media palabra. */
const LEAD_MS = 2000;
/** El coro que se usa no puede estar en el primer 10 % (suele ser una frase suelta de la intro). */
const SKIP_INTRO = 0.1;
/** Sin letra: este punto de la canción. */
const FALLBACK_AT = 0.3;
/** Líneas anteriores al coro que se miran para encontrar dónde empieza el bloque repetido. */
const MAX_BLOCK_BACK = 4;
/** Dos apariciones de una línea a más de esto son dos vueltas del coro, no una repetición seguida. */
const SECTION_GAP_MS = 15_000;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** «oh oh oh», «ah-ah, ay», «na na na»: se repiten mucho pero no son el coro (hacen falta 2 palabras de verdad). */
function meaningful(s: string) {
  return new Set(s.split(' ').filter((w) => w.length >= 3)).size >= 2;
}

/** Veces que vuelve una línea en partes distintas de la canción (las repeticiones seguidas de un final cuentan una). */
function sections(times: number[]) {
  let n = 0;
  let last = -Infinity;
  for (const t of times) {
    if (t - last > SECTION_GAP_MS) n++;
    last = t;
  }
  return n;
}

/**
 * Dónde empieza el coro (ms), o null si la letra no lo deja claro. El coro es la línea con sentido que vuelve en
 * más partes distintas de la canción (a igualdad, la que aparece antes tras la intro); de sus apariciones se toma la primera tras la intro y se retrocede mientras
 * las líneas anteriores también se repitan igual antes de cada aparición (el bloque del coro, no solo su gancho).
 */
export function chorusStartMs(lines: TimedLine[], durationMs: number | null): number | null {
  const timed = lines.filter((l) => Number.isFinite(l.timeMs) && l.text.trim()).sort((a, b) => a.timeMs - b.timeMs);
  const keys = timed.map((l) => norm(l.text));
  const times = new Map<string, number[]>();
  keys.forEach((k, i) => meaningful(k) && times.set(k, [...(times.get(k) ?? []), timed[i].timeMs]));
  // Lo que más vuelve en partes distintas; a igualdad, lo que aparece antes tras la intro (el coro suele llegar
  // antes que los ganchos del puente o del final), y luego lo más largo.
  const minMs = (durationMs ?? 0) * SKIP_INTRO;
  const first = (t: number[]) => t.find((x) => x >= minMs) ?? Infinity;
  const best = [...times]
    .map(([k, t]) => ({ k, parts: sections(t), first: first(t) }))
    .filter((c) => c.parts >= 2)
    .sort((a, b) => b.parts - a.parts || a.first - b.first || b.k.length - a.k.length)[0]?.k;
  if (!best) return null;
  const at = keys.flatMap((k, i) => (k === best ? [i] : []));

  // El bloque: las k líneas anteriores son iguales antes de (casi) todas las apariciones.
  let back = 0;
  for (let k = 1; k <= MAX_BLOCK_BACK; k++) {
    const before = at.filter((i) => i - k >= 0).map((i) => keys[i - k]);
    if (before.length < 2 || !meaningful(before[0])) break;
    const same = before.filter((b) => b === before[0]).length;
    // La línea anterior no puede ser también el gancho (coro de una línea repetida dos veces seguidas).
    if (same < Math.max(2, Math.ceil(at.length * 0.6)) || before[0] === best) break;
    back = k;
  }
  const starts = at.map((i) => timed[Math.max(0, i - back)].timeMs);
  // Que quede canción por delante: no se elige una aparición en los últimos segundos.
  const usable = starts.filter((t) => t >= minMs && (!durationMs || t <= durationMs - CLIP_MS / 2));
  const start = usable[0] ?? starts.find((t) => t >= minMs) ?? starts[0];
  return Math.max(0, start - LEAD_MS);
}

/** El punto de partida en Descubrir: el coro o, sin él, el 30 % (0 si no se sabe la duración). */
export function bestPartMs(lines: TimedLine[] | null, durationMs: number | null): number {
  const chorus = lines?.length ? chorusStartMs(lines, durationMs) : null;
  if (chorus != null) return chorus;
  return durationMs ? Math.round(durationMs * FALLBACK_AT) : 0;
}

/** "[01:02.34]texto" → líneas con tiempo (solo lo que necesita Descubrir). */
export function parseSynced(lrc: string): TimedLine[] {
  const out: TimedLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
    for (const [, m, s, frac = '0'] of stamps) out.push({ timeMs: Number(m) * 60_000 + Number(s) * 1000 + Number(frac.padEnd(3, '0').slice(0, 3)), text });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

const LRCLIB = 'https://lrclib.net/api';
const USER_AGENT = 'Impala (https://github.com/ELuiZzi/Impala-App)';
/** Descubrir no espera más que esto por la letra: sin ella, el 30 %. */
const TIMEOUT_MS = 4000;
const cache = new Map<string, Promise<TimedLine[] | null>>();

async function get(path: string, params: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${LRCLIB}/${path}?${new URLSearchParams(params)}`, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

/** La letra sincronizada de LRCLIB (null si no hay); se recuerda mientras la app está abierta. */
export function syncedLyrics(artist: string, title: string, durationSec: number | null): Promise<TimedLine[] | null> {
  const key = `${artist}|${title}|${durationSec ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    const name = artist.split(/\s*(?:&|,)\s*/)[0];
    const core = title.replace(/\s*[([].*?[)\]]/g, '').trim() || title;
    p = (async () => {
      const exact = durationSec ? await get('get', { artist_name: name, track_name: core, duration: String(durationSec) }).catch(() => null) : null;
      if (exact?.syncedLyrics) return parseSynced(exact.syncedLyrics);
      const found = ((await get('search', { artist_name: name, track_name: core }).catch(() => null)) ?? []) as any[];
      const close = found.find((c) => c?.syncedLyrics && (!durationSec || !c.duration || Math.abs(c.duration - durationSec) <= 5));
      return close ? parseSynced(close.syncedLyrics) : null;
    })().catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** Punto de partida de una canción de Descubrir (ms). Nunca falla: sin red ni letra, el 30 %. */
export async function findBestPart(t: { artist: string; title: string; durationSec: number | null }): Promise<number> {
  const durationMs = t.durationSec ? t.durationSec * 1000 : null;
  const lines = await syncedLyrics(t.artist, t.title, t.durationSec).catch(() => null);
  return bestPartMs(lines, durationMs);
}
