// Pruebas del lector de feeds de las suscripciones: `npm test` (Node 23.6+ ejecuta el .ts directamente).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyInput,
  decodeEntities,
  FeedError,
  mergeEpisodes,
  parseDate,
  parseDuration,
  parseFeed,
  parsePodcastFeed,
  parseYoutubeFeed,
  plainText,
} from '../src/subscriptions/feeds.ts';

const YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCh8IMjulShVsxgZTS2ETDCg"/>
 <yt:channelId>h8IMjulShVsxgZTS2ETDCg</yt:channelId>
 <title>Oraciones &amp; Evangelio</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCh8IMjulShVsxgZTS2ETDCg"/>
 <author><name>Padre Ejemplo</name><uri>https://www.youtube.com/channel/UCh8IMjulShVsxgZTS2ETDCg</uri></author>
 <entry>
  <id>yt:video:AAAAAAAAAAA</id>
  <yt:videoId>AAAAAAAAAAA</yt:videoId>
  <title>Rosario   de hoy    &#8220;Misterios&#8221;</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=AAAAAAAAAAA"/>
  <published>2026-05-17T10:54:51+00:00</published>
  <media:group>
   <media:thumbnail url="https://i3.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg" width="480" height="360"/>
   <media:description>Primera línea
Segunda &lt;b&gt;línea&lt;/b&gt;</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:BBBBBBBBBBB</id>
  <yt:videoId>BBBBBBBBBBB</yt:videoId>
  <title>Oración corta</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/BBBBBBBBBBB"/>
  <published>2026-05-27T02:10:06-05:00</published>
  <media:group><media:thumbnail url="https://i3.ytimg.com/vi/BBBBBBBBBBB/hqdefault.jpg"/><media:description></media:description></media:group>
 </entry>
</feed>`;

const PODCAST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
 <title><![CDATA[Evangelio del día]]></title>
 <link>https://ejemplo.org/podcast</link>
 <itunes:author>Parroquia San José</itunes:author>
 <itunes:image href="https://ejemplo.org/portada.jpg?a=1&amp;b=2"/>
 <item>
  <title>Domingo 15</title>
  <itunes:title>Domingo   15 de noviembre</itunes:title>
  <guid isPermaLink="false">ep-15</guid>
  <pubDate>Sun, 15 Nov 2026 06:00:00 +0000</pubDate>
  <itunes:duration>12:34</itunes:duration>
  <enclosure url="https://cdn.ejemplo.org/15.mp3?x=1&amp;y=2" length="123" type="audio/mpeg"/>
  <description><![CDATA[<p>Reflexi&oacute;n del <b>día</b>.</p><p>Segunda parte &hearts;</p>]]></description>
 </item>
 <item>
  <title>Lunes 16</title>
  <pubDate>Mon, 16 Nov 2026 01:00:00 EST</pubDate>
  <itunes:duration>3723</itunes:duration>
  <enclosure url="https://cdn.ejemplo.org/16.m4a" type="audio/x-m4a"/>
  <itunes:image href="https://ejemplo.org/16.jpg"/>
 </item>
 <item>
  <title>Solo texto (sin audio)</title>
  <pubDate>Tue, 17 Nov 2026 06:00:00 +0000</pubDate>
 </item>
 <item>
  <title>Video</title>
  <pubDate>Tue, 17 Nov 2026 06:00:00 +0000</pubDate>
  <enclosure url="https://cdn.ejemplo.org/v.mp4" type="video/mp4"/>
 </item>
</channel>
</rss>`;

test('canal de YouTube: episodios, Shorts, orden y textos', () => {
  const feed = parseYoutubeFeed(YOUTUBE);
  assert.equal(feed.kind, 'youtube');
  assert.equal(feed.title, 'Oraciones & Evangelio');
  assert.equal(feed.author, 'Padre Ejemplo');
  assert.equal(feed.link, 'https://www.youtube.com/channel/UCh8IMjulShVsxgZTS2ETDCg');
  assert.deepEqual(feed.episodes.map((e) => e.id), ['BBBBBBBBBBB', 'AAAAAAAAAAA']); // más nuevo primero
  const [short, rosario] = feed.episodes;
  assert.equal(short.short, true);
  assert.equal(short.published, '2026-05-27T07:10:06.000Z'); // -05:00 → UTC
  assert.equal(rosario.title, 'Rosario de hoy “Misterios”');
  assert.equal(rosario.videoId, 'AAAAAAAAAAA');
  assert.equal(rosario.audioUrl, null);
  assert.equal(rosario.image, 'https://i3.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg');
  assert.equal(rosario.description, 'Primera línea\nSegunda línea');
});

test('podcast: solo episodios con audio, duraciones, fechas, entidades e imágenes', () => {
  const feed = parsePodcastFeed(PODCAST);
  assert.equal(feed.kind, 'podcast');
  assert.equal(feed.title, 'Evangelio del día');
  assert.equal(feed.author, 'Parroquia San José');
  assert.equal(feed.image, 'https://ejemplo.org/portada.jpg?a=1&b=2');
  assert.equal(feed.link, 'https://ejemplo.org/podcast');
  assert.equal(feed.episodes.length, 2);
  const [lunes, domingo] = feed.episodes;
  assert.equal(lunes.title, 'Lunes 16');
  assert.equal(lunes.published, '2026-11-16T06:00:00.000Z'); // EST = -5
  assert.equal(lunes.durationSec, 3723);
  assert.equal(lunes.id, 'https://cdn.ejemplo.org/16.m4a'); // sin guid: el enlace del audio
  assert.equal(lunes.image, 'https://ejemplo.org/16.jpg');
  assert.equal(domingo.title, 'Domingo 15 de noviembre'); // itunes:title manda
  assert.equal(domingo.id, 'ep-15');
  assert.equal(domingo.durationSec, 754);
  assert.equal(domingo.audioUrl, 'https://cdn.ejemplo.org/15.mp3?x=1&y=2');
  assert.equal(domingo.image, 'https://ejemplo.org/portada.jpg?a=1&b=2'); // la del podcast
  assert.equal(domingo.description, 'Reflexión del día.\nSegunda parte ♥');
});

test('parseFeed distingue YouTube de RSS', () => {
  assert.equal(parseFeed(YOUTUBE).kind, 'youtube');
  assert.equal(parseFeed(PODCAST).kind, 'podcast');
});

test('feed enorme: se queda con los más nuevos sin leerlo entero', () => {
  const items = Array.from({ length: 3000 }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    return `<item><title>E${i}</title><guid>g${i}</guid><pubDate>${day} Oct 2026 10:00:00 GMT</pubDate><enclosure url="https://x.org/${i}.mp3" type="audio/mpeg"/></item>`;
  });
  const xml = `<rss><channel><title>Grande</title>${items.join('')}</channel></rss>`;
  const t0 = performance.now();
  const feed = parsePodcastFeed(xml, 50);
  assert.ok(performance.now() - t0 < 500);
  assert.equal(feed.episodes.length, 50);
  for (let i = 1; i < feed.episodes.length; i++) assert.ok(feed.episodes[i - 1].published >= feed.episodes[i].published);
});

test('feeds rotos', () => {
  assert.throws(() => parseFeed('<html><body>Página de error</body></html>'), FeedError);
  assert.throws(() => parseFeed(''), FeedError);
  // Cortado a la mitad: se leen los episodios completos.
  const cut = PODCAST.slice(0, PODCAST.indexOf('<title>Lunes 16</title>'));
  assert.deepEqual(parsePodcastFeed(cut).episodes.map((e) => e.id), ['ep-15']);
  // Un <entry> sin videoId se salta.
  assert.equal(parseYoutubeFeed(YOUTUBE.replace('<yt:videoId>BBBBBBBBBBB</yt:videoId>', '')).episodes.length, 1);
});

test('fechas', () => {
  assert.equal(parseDate('Tue, 17 Nov 2026 08:00:00 +0000'), '2026-11-17T08:00:00.000Z');
  assert.equal(parseDate('17 Nov 2026 08:00:00 +0130'), '2026-11-17T06:30:00.000Z');
  assert.equal(parseDate('Tue, 17 Nov 26 08:00 GMT'), '2026-11-17T08:00:00.000Z');
  assert.equal(parseDate('Wed, 18 November 2026 10:48:59 PDT'), '2026-11-18T17:48:59.000Z');
  assert.equal(parseDate('2026-11-17T08:00:00Z'), '2026-11-17T08:00:00.000Z');
  assert.equal(parseDate('2026-11-17'), '2026-11-17T00:00:00.000Z');
  assert.equal(parseDate('ayer'), null);
  assert.equal(parseDate(''), null);
});

test('duraciones', () => {
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('62:03'), 3723);
  assert.equal(parseDuration('3723'), 3723);
  assert.equal(parseDuration('3723.6'), 3724);
  assert.equal(parseDuration('0'), null);
  assert.equal(parseDuration('1h 2m'), null);
  assert.equal(parseDuration(null), null);
});

test('entidades y texto plano', () => {
  assert.equal(decodeEntities('a &amp; b &#233; &#xE9; &oacute; &desconocida;'), 'a & b é é ó &desconocida;');
  assert.equal(plainText('<p>Hola</p><p>mundo &nbsp; ya</p>'), 'Hola\nmundo ya');
  assert.equal(plainText('x'.repeat(500), 10).length, 10);
});

test('qué pegó el usuario', () => {
  const id = 'UCh8IMjulShVsxgZTS2ETDCg';
  const c = (s) => classifyInput(s);
  assert.deepEqual(c(id), { kind: 'youtube-channel', channelId: id });
  assert.deepEqual(c(`https://www.youtube.com/channel/${id}/videos`), { kind: 'youtube-channel', channelId: id });
  assert.deepEqual(c(`youtube.com/feeds/videos.xml?channel_id=${id}`), { kind: 'youtube-channel', channelId: id });
  assert.deepEqual(c('@padrebernardomoncada'), { kind: 'youtube-url', url: 'https://www.youtube.com/@padrebernardomoncada' });
  assert.deepEqual(c('https://m.youtube.com/@Canal.Oficial/featured'), { kind: 'youtube-url', url: 'https://www.youtube.com/@Canal.Oficial/featured' });
  assert.deepEqual(c('https://youtu.be/69wwjyip7QY?si=abc'), { kind: 'youtube-video', videoId: '69wwjyip7QY' });
  assert.deepEqual(c('https://www.youtube.com/watch?v=69wwjyip7QY&t=10'), { kind: 'youtube-video', videoId: '69wwjyip7QY' });
  assert.deepEqual(c('https://youtube.com/shorts/69wwjyip7QY'), { kind: 'youtube-video', videoId: '69wwjyip7QY' });
  assert.deepEqual(c(' https://feeds.npr.org/510315/podcast.xml '), { kind: 'podcast', url: 'https://feeds.npr.org/510315/podcast.xml' });
  assert.equal(c('feeds.simplecast.com/54nAGcIl').kind, 'podcast');
  assert.equal(c('https://www.youtube.com/results?search_query=rosario').kind, 'invalid');
  assert.equal(c('hola mundo').kind, 'invalid');
  assert.equal(c('rosario').kind, 'invalid');
  assert.equal(c('ftp://x.org/feed').kind, 'invalid');
});

test('mezclar episodios: los nuevos mandan y los viejos se conservan', () => {
  const ep = (id, published, title = id) => ({ id, title, published, durationSec: null, image: null, videoId: id, audioUrl: null, description: '', short: false });
  const saved = [ep('b', '2026-01-02T00:00:00.000Z'), ep('a', '2026-01-01T00:00:00.000Z')];
  const fresh = [ep('c', '2026-01-03T00:00:00.000Z'), ep('b', '2026-01-02T00:00:00.000Z', 'b corregido')];
  const merged = mergeEpisodes(saved, fresh, 10);
  assert.deepEqual(merged.map((e) => e.id), ['c', 'b', 'a']);
  assert.equal(merged[1].title, 'b corregido');
  assert.deepEqual(mergeEpisodes(saved, fresh, 2).map((e) => e.id), ['c', 'b']);
});

test('feed de videos largos de un canal (UULF…)', async () => {
  const { longVideosFeedUrl } = await import('../src/subscriptions/feeds.ts');
  assert.equal(longVideosFeedUrl('UC83J3suUsNnOacIkqOyKvhw'), 'https://www.youtube.com/feeds/videos.xml?playlist_id=UULF83J3suUsNnOacIkqOyKvhw');
});
