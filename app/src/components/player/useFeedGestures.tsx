import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, type GestureType } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/** Fracción de la altura (o velocidad) a partir de la que soltar cambia de página. */
const PAGE_FRACTION = 0.15;
const PAGE_VELOCITY = 700;
/** Entre dos toques: lo que tarda en responder un toque simple (debe esperar a descartar el doble). */
const DOUBLE_TAP_MS = 250;
const ENTER = { duration: 280, easing: Easing.out(Easing.cubic) };

export type FeedGestureOptions = {
  enabled: boolean;
  /** Altura de la página: la que sale se va del todo y la nueva entra desde el borde contrario. */
  height: number;
  /** Cambia cuando cambia el elemento mostrado (la canción): ahí entra la nueva página. */
  pageKey: string | undefined;
  canNext: boolean;
  canPrevious: boolean;
  onNext: () => void;
  onPrevious: () => void;
  /** Toque simple. Devuelve el icono que se muestra un momento (p. ej. «pause» o «play»). */
  onTap: () => keyof typeof Ionicons.glyphMap;
  onDoubleTap: () => void;
  /** Otros gestos sobre la misma zona que compiten con estos (p. ej. cerrar con dos dedos). */
  extra?: GestureType[];
};

export type FeedGestures = ReturnType<typeof useFeedGestures>;

/**
 * Gestos de «feed» al estilo TikTok, reutilizables (el reproductor y, más adelante, descubrir música):
 * deslizar con un dedo hacia arriba pasa a la siguiente página y hacia abajo a la anterior, con la
 * página siguiendo al dedo y volviendo a su sitio si el gesto es corto o lento; un toque llama a
 * `onTap` y doble toque a `onDoubleTap`. Solo un dedo: los gestos de dos dedos quedan libres (el
 * reproductor los usa para cerrarse).
 *
 * El detector se pone solo sobre la zona «de contenido» (la carátula), nunca sobre botones: los toques
 * de RNGH y los Pressable de React Native no se excluyen entre sí.
 */
export function useFeedGestures(opts: FeedGestureOptions) {
  const { enabled, height, pageKey } = opts;
  const pageY = useSharedValue(0);
  const canNext = useSharedValue(opts.canNext);
  const canPrevious = useSharedValue(opts.canPrevious);
  const tapPulse = useSharedValue(0);
  const burst = useSharedValue(0);
  const [tapIcon, setTapIcon] = useState<keyof typeof Ionicons.glyphMap>('pause');
  // Página que salió esperando a que cambie `pageKey`: -1 hacia arriba (siguiente), 1 hacia abajo.
  const pending = useSharedValue(0);

  useEffect(() => {
    canNext.set(opts.canNext);
    canPrevious.set(opts.canPrevious);
  }, [opts.canNext, opts.canPrevious, canNext, canPrevious]);

  // Llegó la página nueva: entra desde el borde contrario al que salió la anterior.
  useEffect(() => {
    const dir = pending.get();
    if (!dir) return;
    pending.set(0);
    pageY.set(withSequence(withTiming(-dir * height, { duration: 0 }), withTiming(0, ENTER)));
  }, [pageKey, height, pageY, pending]);

  const turn = (dir: number) => {
    pending.set(dir);
    if (dir < 0) opts.onNext();
    else opts.onPrevious();
    // Si no cambia nada (fin de la cola, error), la misma página vuelve; si cambia, el efecto de arriba
    // sustituye esta animación.
    pageY.set(withDelay(900, withSequence(withTiming(-dir * height, { duration: 0 }), withTiming(0, ENTER))));
  };
  const restart = () => opts.onPrevious();
  const tap = () => setTapIcon(opts.onTap());
  const doubleTap = () => opts.onDoubleTap();

  const pan = Gesture.Pan()
    .enabled(enabled)
    .maxPointers(1)
    .activeOffsetY([-12, 12])
    .failOffsetX([-20, 20])
    .onUpdate((e) => {
      const t = e.translationY;
      const blocked = (t < 0 && !canNext.get()) || (t > 0 && !canPrevious.get());
      // Sin página a ese lado, resistencia elástica.
      pageY.set(blocked ? t * 0.25 : t);
    })
    .onEnd((e) => {
      const t = e.translationY;
      const v = e.velocityY;
      const up = t < -height * PAGE_FRACTION || (v < -PAGE_VELOCITY && t < -30);
      const down = t > height * PAGE_FRACTION || (v > PAGE_VELOCITY && t > 30);
      if ((up && canNext.get()) || (down && canPrevious.get())) {
        const dir = up ? -1 : 1;
        pageY.set(
          withTiming(dir * height, { duration: 180, easing: Easing.in(Easing.quad) }, (finished) => {
            if (finished) scheduleOnRN(turn, dir);
          }),
        );
        return;
      }
      // Hacia abajo en la primera canción: vuelve a empezar, sin cambiar de página.
      if (down) scheduleOnRN(restart);
      pageY.set(withSpring(0, { damping: 20, stiffness: 220 }));
    });

  const single = Gesture.Tap()
    .enabled(enabled)
    .maxDistance(12)
    .onEnd((_e, success) => {
      if (!success) return;
      tapPulse.set(0);
      tapPulse.set(withSequence(withTiming(1, { duration: 110 }), withDelay(380, withTiming(0, { duration: 260 }))));
      scheduleOnRN(tap);
    });
  const double = Gesture.Tap()
    .enabled(enabled)
    .numberOfTaps(2)
    .maxDelay(DOUBLE_TAP_MS)
    .maxDistance(24)
    .onEnd((_e, success) => {
      if (!success) return;
      burst.set(0);
      burst.set(withTiming(1, { duration: 900, easing: Easing.out(Easing.quad) }));
      scheduleOnRN(doubleTap);
    });

  const gesture = Gesture.Race(...(opts.extra ?? []), pan, Gesture.Exclusive(double, single));

  const pageStyle = useAnimatedStyle(() => {
    const y = pageY.get();
    return { transform: [{ translateY: y }], opacity: 1 - Math.min(1, Math.abs(y) / height) * 0.7 };
  });

  return { gesture, pageStyle, pageY, tapPulse, burst, tapIcon };
}

/** El icono que aparece un momento al tocar (pausa/reproducir) y la explosión de estrellas del doble toque. */
export function FeedFeedback({ tapPulse, burst, tapIcon }: Pick<FeedGestures, 'tapPulse' | 'burst' | 'tapIcon'>) {
  const tapStyle = useAnimatedStyle(() => {
    const p = tapPulse.get();
    return { opacity: p, transform: [{ scale: 0.7 + p * 0.3 }] };
  });
  const starStyle = useAnimatedStyle(() => {
    const b = burst.get();
    // Crece con rebote y se desvanece al final.
    const scale = b < 0.25 ? (b / 0.25) * 1.25 : b < 0.4 ? 1.25 - ((b - 0.25) / 0.15) * 0.25 : 1;
    const opacity = b === 0 ? 0 : b < 0.7 ? 1 : 1 - (b - 0.7) / 0.3;
    return { opacity, transform: [{ scale }] };
  });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} className="items-center justify-center">
      <Animated.View style={tapStyle} className="w-24 h-24 rounded-full bg-black/45 items-center justify-center">
        <Ionicons name={tapIcon} size={52} color="white" />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, starStyle]} className="items-center justify-center">
        <Ionicons name="star" size={110} color="#FFD60A" />
      </Animated.View>
      {SPARKS.map((angle) => (
        <Spark key={angle} angle={angle} burst={burst} />
      ))}
    </View>
  );
}

const SPARKS = [0, 60, 120, 180, 240, 300];

function Spark({ angle, burst }: { angle: number; burst: SharedValue<number> }) {
  const rad = (angle * Math.PI) / 180;
  const style = useAnimatedStyle(() => {
    const b = burst.get();
    const d = 40 + b * 90;
    return {
      opacity: b === 0 ? 0 : b < 0.15 ? 0 : 1 - b,
      transform: [{ translateX: Math.cos(rad) * d }, { translateY: Math.sin(rad) * d }, { scale: 0.6 + b * 0.4 }],
    };
  });
  return (
    <Animated.View style={[{ position: 'absolute' }, style]}>
      <Ionicons name="star" size={22} color="#FFD60A" />
    </Animated.View>
  );
}
