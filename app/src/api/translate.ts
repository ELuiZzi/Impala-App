import { useQuery } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import type { LyricLine } from './lyrics';

/**
 * Traducción de la letra al español con el traductor de Google, pedida desde el teléfono (sin clave ni
 * servidor). Cada línea va como un `q` aparte, así la respuesta trae una traducción por línea, sin
 * depender de cómo se partan los saltos de línea.
 */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=es&dj=1';
/** Líneas por petición: una letra larga va en varias, así ninguna se acerca al límite del cuerpo. */
const CHUNK = 80;
/** Si al menos esta fracción de las líneas ya está en español, no hay nada que traducir. */
const SPANISH_FRACTION = 0.8;

export type Translation = {
  /** Una por línea de la letra; null si la línea no tiene texto o ya estaba en español. */
  lines: (string | null)[];
  alreadySpanish: boolean;
};

/** Línea sin letras que traducir ("", "♪", "(x2)"…). */
const hasWords = (text: string) => /\p{L}/u.test(text);
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

async function translateChunk(texts: string[], signal?: AbortSignal): Promise<[string, string][]> {
  const body = new URLSearchParams();
  for (const t of texts) body.append('q', t);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
    signal,
  });
  if (!res.ok) throw new Error(`El traductor respondió HTTP ${res.status}`);
  const json: unknown = await res.json();
  if (!Array.isArray(json)) throw new Error('Respuesta inesperada del traductor');
  // Con un solo texto a veces llega ["traducción", "en"] en lugar de [["traducción", "en"]].
  const items = texts.length === 1 && typeof json[0] === 'string' ? [json] : json;
  return items.map((item: any) => {
    const [text, lang] = Array.isArray(item) ? item : [item, ''];
    // Google intercala espacios de ancho cero en algunas traducciones.
    return [String(text ?? '').replace(/​/g, '').trim(), String(lang ?? '')];
  });
}

export async function translateLyrics(lines: LyricLine[], signal?: AbortSignal): Promise<Translation> {
  // Los estribillos se repiten: cada texto distinto se traduce una sola vez.
  const unique = [...new Set(lines.map((l) => l.text.trim()).filter(hasWords))];
  const results = new Map<string, [string, string]>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const translated = await translateChunk(chunk, signal);
    chunk.forEach((text, j) => translated[j] && results.set(text, translated[j]));
  }
  const spanish = [...results.values()].filter(([, lang]) => lang === 'es').length;
  return {
    alreadySpanish: results.size > 0 && spanish / results.size >= SPANISH_FRACTION,
    lines: lines.map((line) => {
      const result = results.get(line.text.trim());
      if (!result) return null;
      const [text, lang] = result;
      // Las líneas que ya estaban en español (o que no cambian: nombres, "oh, oh") no se repiten.
      return lang === 'es' || !text || normalize(text) === normalize(line.text) ? null : text;
    }),
  };
}

/** Traducción de la letra de `songId`; se pide una vez por canción mientras la app está abierta. */
export function useLyricsTranslation(songId: string, lines: LyricLine[], enabled: boolean) {
  return useQuery({
    queryKey: ['lyrics-translation', 'es', songId, lines.length],
    queryFn: ({ signal }) => translateLyrics(lines, signal),
    enabled: enabled && lines.length > 0,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  });
}

// --- Preferencias de la burbuja ------------------------------------------------------------------
// Se recuerdan entre canciones y entre aperturas de la app: si alguien traduce, suele querer seguir
// traduciendo, y la burbuja se queda donde la dejó.

export type BubblePosition = { x: number; y: number };
type Prefs = { enabled: boolean; position: BubblePosition | null };

const KEY = 'impala.lyricsTranslation';
let prefs: Prefs = { enabled: false, position: null };
let loaded: Promise<void> | null = null;
const listeners = new Set<(p: Prefs) => void>();

function load() {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      const stored = raw ? JSON.parse(raw) : null;
      if (stored && typeof stored === 'object') {
        const p = stored.position;
        prefs = {
          enabled: stored.enabled === true,
          position: p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null,
        };
        listeners.forEach((l) => l(prefs));
      }
    })
    .catch(() => {});
  return loaded;
}

function save(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  listeners.forEach((l) => l(prefs));
  SecureStore.setItemAsync(KEY, JSON.stringify(prefs)).catch(() => {});
}

export const setTranslationEnabled = (enabled: boolean) => save({ enabled });
export const setBubblePosition = (position: BubblePosition) => save({ position });

export function useTranslationPrefs(): Prefs {
  const [value, setValue] = useState(prefs);
  useEffect(() => {
    listeners.add(setValue);
    load().then(() => setValue(prefs));
    return () => void listeners.delete(setValue);
  }, []);
  return value;
}
