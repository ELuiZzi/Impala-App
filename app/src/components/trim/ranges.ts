import type { Range } from '@/api/trim';

/** Separación mínima (s) entre dos marcas: ningún tramo, conservado o quitado, puede quedar más corto. */
export const MIN_GAP = 0.5;

/**
 * Estado del editor: el inicio y el final que se conservan, y los cortes intermedios (tramos que se
 * quitan), ordenados y sin solaparse.
 */
export type TrimState = { start: number; end: number; cuts: Range[] };

/** Una marca que se puede mover: inicio, final o un borde de un corte intermedio. */
export type Marker = { kind: 'start' } | { kind: 'end' } | { kind: 'cut'; index: number; edge: 0 | 1 };

export const sameMarker = (a: Marker | null, b: Marker | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind !== 'cut' || (b.kind === 'cut' && a.index === b.index && a.edge === b.edge));

export function markerTime(s: TrimState, m: Marker): number {
  return m.kind === 'start' ? s.start : m.kind === 'end' ? s.end : s.cuts[m.index][m.edge];
}

/** Las marcas en orden: inicio, bordes de los cortes, final. */
function points(s: TrimState): number[] {
  return [s.start, ...s.cuts.flat(), s.end];
}

function markerIndex(s: TrimState, m: Marker): number {
  return m.kind === 'start' ? 0 : m.kind === 'end' ? s.cuts.length * 2 + 1 : 1 + m.index * 2 + m.edge;
}

/** Mueve una marca a `t`, sin pasar a sus vecinas (con MIN_GAP de margen) ni salirse de la canción. */
export function moveMarker(s: TrimState, m: Marker, t: number, duration: number): TrimState {
  const p = points(s);
  const i = markerIndex(s, m);
  const lo = i === 0 ? 0 : p[i - 1] + MIN_GAP;
  const hi = i === p.length - 1 ? duration : p[i + 1] - MIN_GAP;
  const value = Math.round(Math.min(hi, Math.max(lo, t)) * 100) / 100;
  if (m.kind === 'start') return { ...s, start: value };
  if (m.kind === 'end') return { ...s, end: value };
  const cuts = s.cuts.map((c, k) => (k === m.index ? (m.edge === 0 ? [value, c[1]] : [c[0], value]) : c) as Range);
  return { ...s, cuts };
}

/** Los tramos que se conservan, en segundos: [inicio, final] menos los cortes. */
export function keptRanges(s: TrimState): Range[] {
  const kept: Range[] = [];
  let from = s.start;
  for (const [a, b] of s.cuts) {
    kept.push([from, a]);
    from = b;
  }
  kept.push([from, s.end]);
  return kept;
}

export const keptDuration = (s: TrimState) => keptRanges(s).reduce((t, [a, b]) => t + b - a, 0);

/**
 * Añade un corte de ~5 s centrado en `at` dentro del tramo conservado que lo contiene (o en el
 * centro del tramo más largo). null si no cabe: el tramo es demasiado corto.
 */
export function addCut(s: TrimState, at: number | null): { state: TrimState; index: number } | null {
  const kept = keptRanges(s);
  let k = at === null ? -1 : kept.findIndex(([a, b]) => at > a && at < b);
  if (k < 0) k = kept.reduce((best, r, i) => (r[1] - r[0] > kept[best][1] - kept[best][0] ? i : best), 0);
  const [a, b] = kept[k];
  const room = b - a - 2 * MIN_GAP;
  if (room < 1) return null;
  const width = Math.min(5, room);
  const center = Math.min(b - MIN_GAP - width / 2, Math.max(a + MIN_GAP + width / 2, at ?? (a + b) / 2));
  const cut: Range = [Math.round((center - width / 2) * 100) / 100, Math.round((center + width / 2) * 100) / 100];
  const cuts = [...s.cuts.slice(0, k), cut, ...s.cuts.slice(k)];
  return { state: { ...s, cuts }, index: k };
}

export const removeCut = (s: TrimState, index: number): TrimState => ({ ...s, cuts: s.cuts.filter((_, i) => i !== index) });

/** Dónde empezar a escuchar para oír una marca: el tramo y la posición (ms) dentro de él, ~3 s antes. */
export function previewStart(s: TrimState, at: number | null): { index: number; positionMs: number } {
  const kept = keptRanges(s);
  if (at === null) return { index: 0, positionMs: 0 };
  const target = Math.max(s.start, at - 3);
  const inside = kept.findIndex(([a, b]) => target >= a && target < b);
  if (inside >= 0) return { index: inside, positionMs: Math.round((target - kept[inside][0]) * 1000) };
  // Cae en un trozo quitado: se empieza 3 s antes del final del tramo anterior, para oír la unión.
  const before = kept.findLastIndex(([, b]) => b <= target);
  if (before < 0) return { index: 0, positionMs: 0 };
  const [a, b] = kept[before];
  return { index: before, positionMs: Math.round(Math.max(0, b - 3 - a) * 1000) };
}

/** Del instante de la vista previa (tramo + ms dentro de él) al de la canción original (s). */
export function previewToOriginal(s: TrimState, index: number, positionMs: number): number {
  const kept = keptRanges(s);
  const r = kept[Math.min(index, kept.length - 1)];
  return r ? Math.min(r[1], r[0] + positionMs / 1000) : 0;
}

/** "1:05.3" */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
