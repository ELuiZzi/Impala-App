// Fase C1: el motor de Descubrir con YouTube Music real (100 canciones). Uso, desde la raíz del repo:
//   node --import ./tools/node-alias/register.mjs tools/descubrir/real.mjs
import { DiscoverEngine, artistKey } from '../../app/src/discover/engine.ts';
import { radio, moods, moodTracks, songVideoId } from '../../app/src/discover/youtube.ts';
const t0 = performance.now();
const seedSongs = [['Vicente Fernández', 'Volver Volver'], ['Daft Punk', 'Get Lucky'], ['Jesús Adrián Romero', 'Mi Universo']];
const seeds = [];
for (const [a, t] of seedSongs) seeds.push(await songVideoId(a, t));
console.log('semillas', seeds, Math.round(performance.now() - t0), 'ms');
let moodList = null;
const exploreLog = [];
const e = new DiscoverEngine({
  radio,
  explore: async () => {
    moodList ??= await moods();
    const m = moodList[Math.floor(Math.random() * moodList.length)];
    exploreLog.push(m.name);
    return moodTracks(m);
  },
  librarySeeds: async () => seeds.filter(Boolean),
  owned: () => false,
});
const shown = [];
let slowest = 0;
for (let i = 0; i < 100; i++) {
  const s = performance.now();
  const t = await e.next();
  slowest = Math.max(slowest, performance.now() - s);
  if (!t) { console.log('se acabó en', i); break; }
  shown.push(t);
}
const ids = shown.map((t) => t.videoId);
const artists = shown.map((t) => artistKey(t.artist));
let gapViolations = 0;
for (let i = 1; i < artists.length; i++) if (artists.slice(Math.max(0, i - 3), i).includes(artists[i])) gapViolations++;
console.log(`canciones ${shown.length} · distintas ${new Set(ids).size} · artistas distintos ${new Set(artists).size} · mismo artista seguido ${gapViolations}`);
console.log(`de radio ${shown.filter((t) => t.source === 'radio').length} · de explorar ${shown.filter((t) => t.source === 'explore').length} (${[...new Set(exploreLog)].join(', ')})`);
console.log(`next() más lento ${Math.round(slowest)} ms · total ${Math.round(performance.now() - t0)} ms`);
shown.slice(0, 30).forEach((t, i) => console.log(String(i + 1).padStart(3), t.source === 'explore' ? '★' : ' ', `${t.title} — ${t.artist}`));
