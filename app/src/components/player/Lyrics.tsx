import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View, type LayoutChangeEvent, type TextStyle } from 'react-native';
import { GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { currentLine, useLyrics, type LyricLine } from '@/api/lyrics';
import type { Song } from '@/sources';
import { setTranslationEnabled, useLyricsTranslation, useTranslationPrefs } from '@/api/translate';
import { showToast } from '@/components/Toast';
import { usePlayer } from '@/player/store';
import { TranslateBubble } from './TranslateBubble';

/** La línea se activa un poco antes de cantarse, como en Apple Music. */
const LEAD_MS = 250;
/** Ancho (en ms) del borde suave de la "ola": varias letras van iluminándose a la vez. */
const WAVE_MS = 220;
/** Velocidad estimada al cantar cuando la letra no trae tiempos por palabra. */
const MS_PER_CHAR = 80;
const FONT_SIZE = 28;
const LINE_HEIGHT = 36;
/** Montserrat (licencia OFL), incrustada en la app con el plugin de expo-font. */
const LYRIC_FONT: TextStyle = { fontFamily: 'Montserrat', fontWeight: '700' };
/** La traducción, más pequeña y ligera, bajo cada línea. */
const TRANSLATION_FONT: TextStyle = { fontFamily: 'Montserrat', fontWeight: '500', fontSize: 17, lineHeight: 23, color: 'white', marginTop: 4 };

/**
 * Posición de reproducción a 60 fps en el hilo de UI: el reproductor la informa cada 500 ms y entre
 * informes se avanza con el reloj. Así la ola de la letra se mueve sin saltos.
 */
function useSmoothPosition(): SharedValue<number> {
  const reported = usePlayer((s) => s.positionMs);
  const playing = usePlayer((s) => s.isPlaying);
  // Con sped up / slowed la posición del audio avanza más rápido o más lento que el reloj.
  const speed = usePlayer((s) => s.speed);
  const rate = useSharedValue(speed);
  const base = useSharedValue(reported);
  const baseAt = useSharedValue(0);
  const running = useSharedValue(playing);
  const position = useSharedValue(reported);

  useEffect(() => {
    base.value = reported;
    baseAt.value = Date.now();
    running.value = playing;
    rate.value = speed;
  }, [reported, playing, speed, base, baseAt, running, rate]);

  useFrameCallback(() => {
    // Si el informe se retrasa no se adelanta más de 1 s: evita que la letra se escape tras un corte.
    const elapsed = running.value ? Math.min(Date.now() - baseAt.value, 1000) : 0;
    position.value = base.value + elapsed * rate.value;
  });
  return position;
}

type TimedWord = { text: string; start: number; end: number };

/**
 * Tiempos de cada palabra de una línea: los del archivo si existen; si no, se reparten por número de
 * letras entre el inicio de la línea y el de la siguiente, a un ritmo de canto razonable (una línea
 * seguida de un silencio largo no se estira durante todo el silencio).
 */
function timeWords(line: LyricLine, next: number | null): TimedWord[] {
  const start = line.timeMs ?? 0;
  const gap = next !== null && next > start ? next - start : 4000;
  if (line.words?.length) {
    return line.words.map((w, i) => {
      const following = line.words![i + 1]?.timeMs ?? Math.min(start + gap, w.timeMs + w.text.length * MS_PER_CHAR * 2);
      return { text: w.text, start: w.timeMs, end: Math.max(w.timeMs + 80, following) };
    });
  }
  const words = line.text.split(/\s+/).filter(Boolean);
  const chars = words.reduce((n, w) => n + w.length + 1, 0);
  const sung = Math.min(gap * 0.92, Math.max(chars * MS_PER_CHAR, Math.min(gap * 0.6, 1200)));
  let t = start;
  return words.map((text) => {
    const duration = ((text.length + 1) / chars) * sung;
    const word = { text, start: t, end: t + duration };
    t += duration;
    return word;
  });
}

/**
 * Letra en el reproductor, al estilo de Apple Music: líneas grandes y la actual resaltada y centrada
 * con desplazamiento automático. En la línea que suena, las palabras se iluminan en blanco a la
 * velocidad de la canción, con un borde suave que avanza letra a letra como una ola. Tocar una línea
 * salta a ese momento; si el usuario desplaza la letra, el seguimiento automático se pausa unos segundos.
 * La burbuja de traducción añade bajo cada línea su versión en español.
 *
 * `scrollGesture` envuelve el desplazamiento para que conviva con el gesto de cerrar del reproductor;
 * `scrollY` le dice a ese gesto si la letra está arriba del todo (solo entonces deslizar sobre la letra
 * baja el reproductor).
 */
export function LyricsView({ song, onSeek, scrollGesture, scrollY }: {
  song: Song;
  onSeek: (positionMs: number) => void;
  scrollGesture: NativeGesture;
  scrollY: SharedValue<number>;
}) {
  const lyrics = useLyrics(song.id, true);
  const position = useSmoothPosition();
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<number[]>([]);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const height = area.height;
  const userScrolledAt = useRef(0);
  const [active, setActive] = useState(-1);

  const lines = useMemo(() => lyrics.data?.lines ?? [], [lyrics.data]);
  const synced = !!lyrics.data?.synced;

  const prefs = useTranslationPrefs();
  const translation = useLyricsTranslation(song.id, lines, prefs.enabled);
  const translated = prefs.enabled ? translation.data?.lines : undefined;
  // Los avisos solo tras tocar la burbuja: con la traducción ya activa, una canción en español no avisa.
  const asked = useRef(false);

  useEffect(() => {
    if (!asked.current || translation.isFetching) return;
    asked.current = false;
    if (!prefs.enabled) return;
    if (translation.isError) showToast('No se pudo traducir la letra', 'alert-circle');
    else if (translation.data?.alreadySpanish) showToast('La letra ya está en español', 'language');
  }, [prefs.enabled, translation.isFetching, translation.isError, translation.data]);

  const toggleTranslation = () => {
    // Si falló, volver a tocar la burbuja lo reintenta en lugar de apagarla.
    if (prefs.enabled && translation.isError) {
      asked.current = true;
      void translation.refetch();
      return;
    }
    asked.current = !prefs.enabled;
    setTranslationEnabled(!prefs.enabled);
  };

  // La línea activa se calcula en el hilo de UI y solo avisa a React cuando cambia.
  useAnimatedReaction(
    () => (synced ? currentLine(lines, position.value + LEAD_MS) : -1),
    (index, previous) => {
      if (index !== previous) scheduleOnRN(setActive, index);
    },
    [lines, synced],
  );

  useEffect(() => {
    if (!synced || active < 0 || Date.now() - userScrolledAt.current < 4000) return;
    const y = offsets.current[active];
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - height * 0.3), animated: true });
  }, [active, synced, height]);

  if (lyrics.isPending) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator color="white" />
      </View>
    );
  }
  if (lyrics.isError || lines.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-white/60 text-base text-center">
          {lyrics.isError ? 'No se pudo cargar la letra' : 'No hay letra disponible para esta canción'}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1" onLayout={(e: LayoutChangeEvent) => setArea(e.nativeEvent.layout)}>
      <GestureDetector gesture={scrollGesture}>
        <ScrollView
          ref={scroll}
          className="flex-1"
          onScrollBeginDrag={() => (userScrolledAt.current = Date.now())}
          onScroll={(e) => scrollY.set(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          // Sin el estiramiento de Android al tirar desde arriba: ese tirón baja el reproductor.
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingTop: height * 0.25, paddingBottom: height * 0.6 }}
        >
          {lines.map((line, i) => (
            <Pressable
              key={i}
              disabled={!synced || line.timeMs === null}
              onPress={() => line.timeMs !== null && onSeek(line.timeMs)}
              onLayout={(e) => (offsets.current[i] = e.nativeEvent.layout.y)}
              className="py-2.5 active:opacity-60"
            >
              {!synced ? (
                <Text style={[LYRIC_FONT, { fontSize: 22, lineHeight: 30 }]} className="text-white/85">{line.text || '♪'}</Text>
              ) : i === active && line.text.trim() ? (
                <KaraokeLine line={line} next={lines[i + 1]?.timeMs ?? null} position={position} />
              ) : (
                <Text style={[LYRIC_FONT, { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT }]} className={i < active ? 'text-white/30' : 'text-white/40'}>
                  {line.text || '♪'}
                </Text>
              )}
              {translated?.[i] ? (
                <Text style={[TRANSLATION_FONT, { opacity: !synced ? 0.6 : i === active ? 0.85 : i < active ? 0.25 : 0.35 }]}>{translated[i]}</Text>
              ) : null}
            </Pressable>
          ))}
          <Text className="text-white/35 text-xs mt-6">
            {lyrics.data?.source === 'lrclib' ? 'Letra: LRCLIB' : 'Letra incluida en el archivo'}
            {translated ? ' · Traducción: Google' : ''}
          </Text>
        </ScrollView>
      </GestureDetector>
      {area.height > 0 && (
        <TranslateBubble
          area={area}
          position={prefs.position}
          active={prefs.enabled}
          loading={prefs.enabled && translation.isFetching}
          onPress={toggleTranslation}
        />
      )}
    </View>
  );
}

/** La línea que suena: cada palabra en su caja (para que el salto de línea respete las palabras). */
const KaraokeLine = memo(function KaraokeLine({ line, next, position }: { line: LyricLine; next: number | null; position: SharedValue<number> }) {
  const words = useMemo(() => timeWords(line, next), [line, next]);
  return (
    <View className="flex-row flex-wrap">
      {words.map((w, i) => (
        <Word key={i} word={w} position={position} last={i === words.length - 1} />
      ))}
    </View>
  );
});

function Word({ word, position, last }: { word: TimedWord; position: SharedValue<number>; last: boolean }) {
  const letters = useMemo(() => Array.from(word.text), [word.text]);
  const step = (word.end - word.start) / Math.max(1, letters.length);
  // La palabra que se canta se eleva un poco, como en Apple Music.
  const lift = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (position.value - word.start) / Math.max(120, word.end - word.start)));
    return { transform: [{ translateY: -2 * p }] };
  });
  return (
    <Animated.View style={[{ flexDirection: 'row', marginRight: last ? 0 : FONT_SIZE * 0.26 }, lift]}>
      {letters.map((letter, i) => (
        <Letter key={i} letter={letter} at={word.start + i * step} position={position} />
      ))}
    </Animated.View>
  );
}

/** Una letra: pasa de tenue a blanco en WAVE_MS a partir de su momento; juntas forman la ola. */
function Letter({ letter, at, position }: { letter: string; at: number; position: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const p = Math.min(1, Math.max(0, (position.value - at + WAVE_MS * 0.3) / WAVE_MS));
    // Suavizado (ease-out) para que el borde de la ola no se vea escalonado.
    const eased = 1 - (1 - p) * (1 - p);
    return { opacity: 0.4 + 0.6 * eased };
  });
  return (
    <Animated.Text style={[LYRIC_FONT, { fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, color: 'white' }, style]}>
      {letter}
    </Animated.Text>
  );
}
