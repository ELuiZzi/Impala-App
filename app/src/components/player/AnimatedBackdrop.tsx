import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import ImpalaPlayer from '../../../modules/impala-player';

/** Mancha blanca con degradado radial hasta transparente; se tiñe del color de cada capa. */
const BLOB = require('../../../assets/blob.png');

/** Colores de reserva (sin carátula o mientras se analizan): el tono de Impala sobre negro. */
const FALLBACK = ['#3a0d14', '#1c1c1e', '#5b1220', '#121212'];

/**
 * Fondo del reproductor a pantalla completa, al estilo de Apple Music: manchas de los colores de la
 * carátula que giran y se desplazan muy despacio, mezclándose entre sí. Al cambiar de canción, el
 * fondo nuevo aparece fundiéndose sobre el anterior.
 */
export function AnimatedBackdrop({ artworkUrl, playing }: { artworkUrl?: string; playing: boolean }) {
  const colors = useQuery({
    queryKey: ['artworkColors', artworkUrl],
    queryFn: () => ImpalaPlayer.getArtworkColors(artworkUrl!),
    enabled: !!artworkUrl,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
  const palette = prepare(colors.data?.length ? colors.data : FALLBACK);

  // Un reloj común: en pausa se mueve más despacio, como "respirando".
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.value = withRepeat(withTiming(clock.value + 1, { duration: playing ? 60_000 : 160_000, easing: Easing.linear }), -1, false);
  }, [playing, clock]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* key: cada paleta es una capa nueva que entra fundiéndose sobre la anterior. */}
      <Animated.View key={palette.join()} entering={FadeIn.duration(900)} exiting={FadeOut.duration(900)} style={StyleSheet.absoluteFill}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: palette[3] }]} />
        <Blob clock={clock} color={palette[0]} origin={{ x: -0.35, y: -0.25 }} spin={1} orbit={[1, 2]} drift={0.18} />
        <Blob clock={clock} color={palette[1]} origin={{ x: 0.45, y: 0.35 }} spin={-2} orbit={[2, 1]} drift={0.22} />
        <Blob clock={clock} color={palette[2]} origin={{ x: -0.2, y: 0.75 }} spin={1} orbit={[3, 2]} drift={0.15} />
      </Animated.View>
      {/* Oscurece lo justo para que el texto blanco se lea siempre. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.32)' }]} />
    </View>
  );
}

/**
 * Una mancha de color: una elipse enorme de bordes difuminados (degradado radial teñido) que gira
 * sobre sí misma y se desplaza en curvas. Varias superpuestas dan el efecto de colores que fluyen.
 * spin y orbit son vueltas enteras por ciclo del reloj: así el ciclo empalma sin saltos.
 */
function Blob({ clock, color, origin, spin, orbit, drift }: {
  clock: SharedValue<number>;
  color: string;
  origin: { x: number; y: number };
  spin: number;
  orbit: [number, number];
  drift: number;
}) {
  const { width, height } = useWindowDimensions();
  const size = Math.max(width, height) * 1.1;
  const style = useAnimatedStyle(() => {
    const t = clock.value * Math.PI * 2;
    return {
      transform: [
        { translateX: origin.x * width + Math.sin(t * orbit[0]) * drift * width },
        { translateY: origin.y * height + Math.cos(t * orbit[1]) * drift * height },
        { rotate: `${clock.value * 360 * spin}deg` },
      ],
    };
  });
  return (
    // Elipse (más ancha que alta) para que el giro se note.
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, width: size * 1.3, height: size * 0.85, opacity: 0.95 }, style]}>
      <Image source={BLOB} tintColor={color} contentFit="fill" style={{ flex: 1 }} />
    </Animated.View>
  );
}

/**
 * Ordena y ajusta la paleta: 4 colores, ninguno demasiado claro (el texto es blanco); el último,
 * el más oscuro, hace de fondo base.
 */
function prepare(input: string[]): string[] {
  const colors = [...input];
  while (colors.length < 4) colors.push(colors[colors.length % input.length] ?? FALLBACK[colors.length]);
  const adjusted = colors.slice(0, 4).map((c) => limitLightness(c, 0.55));
  const darkest = [...adjusted].sort((a, b) => luminance(a) - luminance(b))[0];
  const rest = adjusted.filter((c) => c !== darkest);
  return [...rest.slice(0, 3), mix(darkest, '#000000', 0.45)];
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = ([r, g, b]: number[]) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

const mix = (a: string, b: string, amount: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * amount));
};

/** Oscurece un color hasta que su luminosidad no pase de `max`. */
function limitLightness(hex: string, max: number): string {
  const l = luminance(hex);
  return l <= max ? hex : mix(hex, '#000000', 1 - max / l);
}
