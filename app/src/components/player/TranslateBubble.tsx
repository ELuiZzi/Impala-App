import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { setBubblePosition, type BubblePosition } from '@/api/translate';

const SIZE = 44;
/** Margen con los bordes de la letra. */
const INSET = 4;
/** Posición de origen: abajo a la izquierda. */
const DEFAULT: BubblePosition = { x: 0, y: 1 };

/**
 * Burbuja para traducir la letra. Se arrastra a cualquier punto del área de la letra (la posición se
 * guarda como fracción del espacio libre, así vale igual en pantalla completa) y tocarla activa o
 * desactiva la traducción. Arrastrarla no cierra el reproductor: su gesto se activa antes que el de
 * deslizar hacia abajo y lo cancela.
 */
export function TranslateBubble({ area, position, active, loading, onPress }: {
  area: { width: number; height: number };
  position: BubblePosition | null;
  active: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const maxX = Math.max(0, area.width - SIZE - INSET * 2);
  const maxY = Math.max(0, area.height - SIZE - INSET * 2);
  const { x: fx, y: fy } = position ?? DEFAULT;
  const x = useSharedValue(fx * maxX);
  const y = useSharedValue(fy * maxY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  // Si cambia la posición guardada o el tamaño del área, la burbuja se recoloca en su sitio relativo.
  useEffect(() => {
    x.set(fx * maxX);
    y.set(fy * maxY);
  }, [fx, fy, maxX, maxY, x, y]);

  const drag = Gesture.Pan()
    .minDistance(4)
    .onStart(() => {
      startX.set(x.get());
      startY.set(y.get());
    })
    .onUpdate((e) => {
      x.set(Math.min(maxX, Math.max(0, startX.get() + e.translationX)));
      y.set(Math.min(maxY, Math.max(0, startY.get() + e.translationY)));
    })
    .onEnd(() => {
      scheduleOnRN(setBubblePosition, { x: maxX ? x.get() / maxX : 0, y: maxY ? y.get() / maxY : 1 });
    });

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() }] }));

  return (
    <GestureDetector gesture={drag}>
      <Animated.View style={[{ position: 'absolute', left: INSET, top: INSET, elevation: 6 }, style]}>
        <Pressable
          onPress={onPress}
          style={{ width: SIZE, height: SIZE }}
          className={`rounded-full items-center justify-center active:opacity-70 ${active ? 'bg-white' : 'bg-neutral-800/90'}`}
          accessibilityRole="switch"
          accessibilityState={{ checked: active }}
          accessibilityLabel="Traducir la letra al español"
        >
          {loading ? (
            <ActivityIndicator size="small" color={active ? 'black' : 'white'} />
          ) : (
            <Ionicons name="language" size={22} color={active ? 'black' : 'white'} />
          )}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}
