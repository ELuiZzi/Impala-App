// Prueba real de la «mejor parte»: dónde empezaría Descubrir en canciones conocidas y qué línea suena ahí.
// node --import ./tools/node-alias/register.mjs tools/descubrir/coro.mjs
import { findBestPart, syncedLyrics } from '../../app/src/discover/bestPart.ts';

const SONGS = [
  ['Luis Fonsi', 'Despacito', 229], ['Vicente Fernández', 'Volver Volver', 200], ['Queen', 'Bohemian Rhapsody', 355],
  ['The Weeknd', 'Blinding Lights', 200], ['Shakira', "Hips Don't Lie", 218], ['Maná', 'Rayando el Sol', 252],
  ['Daft Punk', 'Get Lucky', 248], ['Karol G', 'Provenza', 210], ['Coldplay', 'Viva la Vida', 242],
  ['Jesús Adrián Romero', 'Mi Universo', 287], ['Selena', 'Como la Flor', 186], ['Avicii', 'Wake Me Up', 247],
];
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
for (const [artist, title, dur] of SONGS) {
  const t0 = Date.now();
  const at = await findBestPart({ artist, title, durationSec: dur });
  const lines = (await syncedLyrics(artist, title, dur)) ?? [];
  const line = lines.find((l) => l.timeMs >= at + 1500)?.text ?? '(sin letra: 30 %)';
  console.log(`${artist} – ${title}: ${mmss(at)} (${Date.now() - t0} ms) → ${line}`);
}
