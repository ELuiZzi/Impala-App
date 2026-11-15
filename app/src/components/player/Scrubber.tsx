import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { formatDuration } from '../theme';

const clamp = (n: number) => Math.min(1, Math.max(0, n));

type Props = {
  positionMs: number;
  bufferedMs: number;
  durationMs: number | null;
  onSeek: (positionMs: number) => void;
};

/** Barra de progreso arrastrable: muestra la posición del arrastre y solo busca al soltar. */
export function Scrubber({ positionMs, bufferedMs, durationMs, onSeek }: Props) {
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const width = useRef(1);

  const duration = durationMs ?? 0;
  const ratio = dragRatio ?? (duration ? clamp(positionMs / duration) : 0);
  const buffered = duration ? clamp(bufferedMs / duration) : 0;
  const elapsed = ratio * duration;
  const dragging = dragRatio !== null;

  return (
    <View>
      {/* Los hijos no capturan toques, así locationX siempre es relativo a esta barra. */}
      <View
        onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
        onStartShouldSetResponder={() => duration > 0}
        onMoveShouldSetResponder={() => duration > 0}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => setDragRatio(clamp(e.nativeEvent.locationX / width.current))}
        onResponderMove={(e) => setDragRatio(clamp(e.nativeEvent.locationX / width.current))}
        onResponderRelease={(e) => {
          onSeek(clamp(e.nativeEvent.locationX / width.current) * duration);
          setDragRatio(null);
        }}
        onResponderTerminate={() => setDragRatio(null)}
        hitSlop={{ top: 8, bottom: 8 }}
        className="h-8 justify-center"
      >
        <View pointerEvents="none" className={`${dragging ? 'h-3' : 'h-1.5'} rounded-full bg-white/20 overflow-hidden`}>
          <View style={{ width: `${buffered * 100}%` }} className="absolute h-full bg-white/25" />
          <View style={{ width: `${ratio * 100}%` }} className="h-full bg-white/90" />
        </View>
      </View>
      <View className="flex-row justify-between">
        <Text className="text-white/60 text-xs font-medium">{formatDuration(elapsed / 1000) || '0:00'}</Text>
        <Text className="text-white/60 text-xs font-medium">
          {duration ? `-${formatDuration((duration - elapsed) / 1000) || '0:00'}` : '--:--'}
        </Text>
      </View>
    </View>
  );
}
