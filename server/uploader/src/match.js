/**
 * Emparejar canciones entre catálogos (Apple Music ↔ biblioteca de Navidrome ↔ YouTube Music),
 * que escriben distinto lo mismo: "Song (feat. X)" / "Song", "A & B" / "A, B", acentos, " - Remastered"…
 */

/** Minúsculas, sin acentos ni signos: "Beyoncé — HALO!" → "beyonce halo". */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Título sin paréntesis, sufijos " - Remastered 2011" ni "feat.": lo que identifica la canción. */
export function coreTitle(title) {
  return String(title ?? '')
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+[-–—]\s+.*$/, '')
    .replace(/\s+(feat|ft|featuring|with|con)\.?\s.*$/i, '')
    .trim();
}

const ARTIST_SEPARATOR = /\s*(?:,|&|\/|;|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bx\b|\by\b|\band\b|\bcon\b|\bwith\b|\bvs\.?)\s*/i;

function artistNames(artist) {
  return String(artist ?? '').split(ARTIST_SEPARATOR).map(normalize).filter(Boolean);
}

/** Palabras que distinguen versiones: si solo una de las dos las tiene, no es la misma grabación. */
const VERSION_WORDS = ['live', 'en vivo', 'directo', 'remix', 'acoustic', 'acustico', 'acustica', 'instrumental', 'karaoke', 'cover', 'sped up', 'slowed', 'reverb', 'nightcore', '8d', 'demo'];

function versionWords(text) {
  const n = ` ${normalize(text)} `;
  return new Set(VERSION_WORDS.filter((w) => n.includes(` ${w} `)));
}

function sameTitle(a, b) {
  const x = normalize(coreTitle(a)) || normalize(a);
  const y = normalize(coreTitle(b)) || normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "Song" ⊂ "Song Pt 2" no basta: se exige que el más corto sea casi todo el largo.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.7;
}

function sameArtist(a, b) {
  const x = artistNames(a);
  const y = artistNames(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x.some((n) => y.includes(n))) return true;
  // "Tyler, The Creator" partido por la coma, "TameImpala" del canal…
  const nx = normalize(a).replace(/\s/g, '');
  const ny = normalize(b).replace(/\s/g, '');
  return nx.length >= 3 && ny.length >= 3 && (nx.includes(ny) || ny.includes(nx));
}

/**
 * Puntuación de `candidate` como la canción `target` ({ title, artist, durationSec? }); 0 si no lo es.
 * ≥ MATCH_THRESHOLD se considera la misma canción.
 */
export function matchScore(target, candidate) {
  if (!sameTitle(target.title, candidate.title) || !sameArtist(target.artist, candidate.artist)) return 0;
  let score = 1;
  if (normalize(target.title) === normalize(candidate.title)) score += 0.3;

  const want = versionWords(target.title);
  const got = versionWords(`${candidate.title} ${candidate.album ?? ''}`);
  const mismatch = [...want].some((w) => !got.has(w)) || [...got].some((w) => !want.has(w));
  if (mismatch) score -= 0.6;

  const a = target.durationSec;
  const b = candidate.durationSec;
  if (a && b) {
    const diff = Math.abs(a - b);
    if (diff <= 3) score += 0.4;
    else if (diff <= 10) score += 0.2;
    else if (diff > 30) score -= 0.5;
  }
  return Math.max(0, score);
}

export const MATCH_THRESHOLD = 0.9;

/** El mejor candidato que supera el umbral, o null. */
export function bestMatch(target, candidates) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = matchScore(target, candidate);
    if (score >= MATCH_THRESHOLD && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
