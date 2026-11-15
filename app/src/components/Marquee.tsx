import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View, type LayoutChangeEvent, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useNearTouch } from './touchFocus';

/** Hueco entre el final del texto y el principio de la copia que lo sigue. */
const GAP = 48;
/** Pausa inicial en filas de listas: más larga que en el reproductor, para no mover toda la pantalla de golpe. */
export const LIST_DELAY = 2500;
/** Velocidad del desplazamiento (px/s): constante, así un título largo tarda más que uno corto. */
const SPEED = 34;

type Props = {
  children: ReactNode;
  /** Clases del texto (color, tamaño, peso…), las mismas que tendría el `Text`. */
  className?: string;
  style?: StyleProp<TextStyle>;
  /** Clases de maquetación (márgenes, flex…) del contenedor, que hace las veces del `Text`. */
  containerClassName?: string;
  containerStyle?: StyleProp<ViewStyle>;
  /** Pausa antes de cada vuelta (ms). En listas conviene algo más larga que en el reproductor. */
  delay?: number;
  /** `false` lo deja quieto (con puntos suspensivos) aunque no quepa. */
  active?: boolean;
  /**
   * En filas de listas: solo se mueve si el dedo toca esta fila o la de arriba o abajo (ver touchFocus.ts), o con
   * `always` (la canción que suena). Así una lista llena de títulos largos no se mueve entera.
   */
  list?: boolean;
  /** Alto aproximado de la fila (o tarjeta) en listas, para saber cuáles son las vecinas. */
  rowHeight?: number;
  always?: boolean;
};

/**
 * Texto de una línea que, si no cabe, se desplaza en bucle de derecha a izquierda como un
 * letrero (como el reproductor de Apple Music/Spotify). Si cabe, o si el sistema pide reducir el
 * movimiento, se ve igual que un `Text` con `numberOfLines={1}`. La animación corre en el hilo de UI.
 */
export function Marquee({
  children,
  className,
  style,
  containerClassName,
  containerStyle,
  delay = 1500,
  active = true,
  list = false,
  rowHeight = 64,
  always = false,
}: Props) {
  const ref = useRef<View>(null);
  const reduceMotion = useReducedMotion();
  const label = typeof children === 'string' || typeof children === 'number' ? String(children) : undefined;
  // Medida del ancho natural del texto: se guarda junto al texto medido para volver a medir cuando cambia.
  const [measured, setMeasured] = useState<{ key: string | undefined; width: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const textWidth = measured && measured.key === label ? measured.width : 0;
  const needsMeasure = !measured || measured.key !== label;
  // Con medio píxel de margen: un texto que justo cabe no debe ponerse a moverse por redondeos.
  const overflowing = containerWidth > 0 && textWidth > containerWidth + 0.5;
  const near = useNearTouch(ref, list && !always && active && !reduceMotion && overflowing, rowHeight);
  const scrolling = active && !reduceMotion && overflowing && (!list || always || near);
  // Caja de cada copia redondeada hacia arriba (+1) para que Android no la recorte con puntos suspensivos.
  const boxWidth = Math.ceil(textWidth) + 1;
  const distance = boxWidth + GAP;

  const offset = useSharedValue(0);
  useEffect(() => {
    offset.set(0);
    if (!scrolling) return;
    offset.set(
      withRepeat(
        withSequence(
          withDelay(delay, withTiming(-distance, { duration: (distance / SPEED) * 1000, easing: Easing.linear })),
          withTiming(0, { duration: 0 }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(offset);
  }, [scrolling, distance, delay, offset]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));

  const onContainerLayout = (e: LayoutChangeEvent) => setContainerWidth(e.nativeEvent.layout.width);
  const onMeasure = (e: LayoutChangeEvent) => setMeasured({ key: label, width: e.nativeEvent.layout.width });

  return (
    <View
      ref={ref}
      onLayout={onContainerLayout}
      className={`overflow-hidden ${containerClassName ?? ''}`}
      style={containerStyle}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      {/* El texto "de siempre": da el alto y el ancho al contenedor; se oculta mientras se desplaza. */}
      <Text className={className} style={[style, scrolling && { opacity: 0 }]} numberOfLines={1}>
        {children}
      </Text>
      {needsMeasure && (
        // Fuera de la maquetación y sin límite de ancho, para saber cuánto ocupa el texto entero.
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: 10000, opacity: 0, alignItems: 'flex-start' }}>
          <Text className={className} style={style} numberOfLines={1} onLayout={onMeasure}>
            {children}
          </Text>
        </View>
      )}
      {scrolling && (
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, flexDirection: 'row' }, animatedStyle]}>
          <Text className={className} style={[style, { width: boxWidth, textAlign: 'left' }]} numberOfLines={1}>
            {children}
          </Text>
          <View style={{ width: GAP }} />
          <Text className={className} style={[style, { width: boxWidth, textAlign: 'left' }]} numberOfLines={1}>
            {children}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

/** Marquee para filas de listas: pausa más larga y solo cerca del dedo (o `always`, la canción que suena). */
export function ListMarquee(props: Omit<Props, 'list'>) {
  return <Marquee delay={LIST_DELAY} {...props} list />;
}
