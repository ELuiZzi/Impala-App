/**
 * Colores de una carátula para el fondo animado del reproductor (en Android, Palette). Se dibuja reducida en
 * un canvas, se agrupan los colores parecidos y se devuelven hasta 5 en #rrggbb: primero los vivos y
 * oscuros, que lucen de fondo con texto blanco encima. Navidrome sirve las carátulas con CORS.
 */
const SAMPLE_PX = 64;
const cache = new Map<string, string[]>();

export async function getArtworkColors(url: string): Promise<string[]> {
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_PX;
    canvas.height = SAMPLE_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(image, 0, 0, SAMPLE_PX, SAMPLE_PX);
    const colors = palette(ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data);
    if (cache.size > 80) cache.delete(cache.keys().next().value!);
    cache.set(url, colors);
    return colors;
  } catch {
    return [];
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

type Bucket = { r: number; g: number; b: number; count: number };

function palette(data: Uint8ClampedArray): string[] {
  // Cubos de 4 bits por canal: colores parecidos cuentan juntos.
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(key) ?? { r: 0, g: 0, b: 0, count: 0 };
    b.r += data[i];
    b.g += data[i + 1];
    b.b += data[i + 2];
    b.count++;
    buckets.set(key, b);
  }
  const total = data.length / 4;
  const candidates = [...buckets.values()]
    .filter((b) => b.count / total > 0.004)
    .map((b) => {
      const rgb: [number, number, number] = [b.r / b.count, b.g / b.count, b.b / b.count];
      const [, s, l] = hsl(rgb);
      // Vivos y algo oscuros primero (como darkVibrant/vibrant de Palette); luego por presencia.
      const vivid = s * (1 - Math.abs(l - 0.4) * 1.6);
      return { rgb, score: vivid * 2 + Math.sqrt(b.count / total) };
    })
    .sort((a, b) => b.score - a.score);

  const chosen: [number, number, number][] = [];
  for (const c of candidates) {
    if (chosen.every((o) => distance(o, c.rgb) > 48)) chosen.push(c.rgb);
    if (chosen.length === 5) break;
  }
  return chosen.map(([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase());
}

function distance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  return [0, s, l];
}
