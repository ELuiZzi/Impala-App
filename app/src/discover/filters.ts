/**
 * Filtros de Descubrir: «solo en español», «sin explícitas» y un género elegido. Sin dependencias de la app: lo
 * prueba app/test/discover.test.mjs.
 *
 * El idioma se adivina por palabras muy frecuentes (y tildes, ñ, ¿¡): primero con el título y el artista; si no
 * dicen nada (p. ej. «Despacito»), con la letra, que Descubrir ya pide para encontrar el coro.
 */
import type { DiscoverTrack } from './engine';

export type Genre = { name: string; params: string };

export type Filters = {
  spanishOnly: boolean;
  noExplicit: boolean;
  /** null: lo de siempre (según lo que escuchas). */
  genre: Genre | null;
};

export const defaultFilters = (): Filters => ({ spanishOnly: false, noExplicit: false, genre: null });

// Solo palabras que casi no existen en el otro idioma («me», «no», «a» están en los dos).
const ES = new Set(
  'de la el que y en mi tu te los las se es por con una un lo para como mas más sin ya yo eres soy ti amor corazon corazón quiero vida nada todo cuando porque pero hoy noche tus mis esta está este sus nos le quien dios vamos'.split(
    ' ',
  ),
);
const EN = new Set(
  "the you i my your to of and in it on is be all baby don't dont can't cant i'm im we're you're it's love heart night for with what this that just like know never feel want got gonna wanna when we they she he our are was".split(
    ' ',
  ),
);

/** «es», «en» o null si no está claro. `margin`: cuánta ventaja hace falta. */
export function guessLanguage(text: string, margin = 1): 'es' | 'en' | null {
  const lower = text.toLowerCase();
  let es = /[ñ¿¡áéíóú]/.test(lower) ? 2 : 0;
  let en = 0;
  for (const w of lower.split(/[^\p{L}']+/u)) {
    if (!w) continue;
    if (ES.has(w)) es++;
    if (EN.has(w)) en++;
  }
  if (es - en >= margin) return 'es';
  if (en - es >= margin) return 'en';
  return null;
}

/** El idioma de una letra: hace falta una ventaja clara (las letras en español también llevan «baby», «yeah»…). */
export function lyricsLanguage(lines: { text: string }[]): 'es' | 'en' | null {
  const text = lines.map((l) => l.text).join(' ');
  return guessLanguage(text, Math.max(3, Math.round(text.length / 200)));
}

/** Letras de otros alfabetos (japonés, coreano, árabe, cirílico…): seguro que no es en español. */
// Rangos explícitos (griego, cirílico, hebreo, árabe, devanagari, tailandés, hangul, kana, CJK): Hermes no entiende \p{Script=…}.
const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/;

/** ¿Puede salir con estos filtros? Con «solo en español», lo dudoso pasa aquí y lo decide la letra (needsLyricsCheck). */
export function allowedByFilters(t: DiscoverTrack, f: Filters): boolean {
  if (f.noExplicit && t.explicit) return false;
  if (f.spanishOnly && (guessLanguage(t.title) === 'en' || NON_LATIN.test(`${t.title} ${t.artist}`))) return false;
  return true;
}

/** «Solo en español» y el título no lo deja claro: hace falta que la letra esté en español (sin letra, no sale). */
export const needsLyricsCheck = (t: DiscoverTrack, f: Filters) => f.spanishOnly && guessLanguage(t.title) !== 'es';

/** Con «solo en español», se explora solo en géneros en español (los estados de ánimo mezclan idiomas). */
export const SPANISH_GENRES = /bachata|cumbia|español|mexicana|latino|tropical|vallenato|salsa|reggaet|banda|regional/i;

/** Estados de ánimo que no son para descubrir música (ruido para dormir, juegos): no se exploran al azar. */
export const NOT_FOR_EXPLORING = /dormir|sleep|gaming|videojuego|juego/i;
