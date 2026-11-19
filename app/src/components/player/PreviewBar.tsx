import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { withUniwind } from 'uniwind';
import { Marquee } from '@/components/Marquee';
import { useDesktop } from '@/components/desktop/layout';
import { seekPreview, stopPreview, togglePreviewPause, usePreview } from '@/player/preview';
import { formatDuration, useThemeColor } from '../theme';

const StyledImage = withUniwind(Image);

export const PREVIEW_BAR_HEIGHT = 104;

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** ¿Hay una vista previa en marcha (la barra está a la vista)? */
export function usePreviewBarVisible() {
  return usePreview((s) => !!s.meta && !!s.id && s.status !== 'error' && s.status !== null);
}

/**
 * Mini reproductor de la vista previa de YouTube: flota donde va el mini reproductor (que se esconde mientras
 * tanto). Pausa, adelanta arrastrando, descarga y cierra; la cola no cambia y lo que sonaba vuelve al cerrarla.
 */
export function PreviewBar({ bottom }: { bottom: number }) {
  const visible = usePreviewBarVisible();
  const id = usePreview((s) => s.id);
  const meta = usePreview((s) => s.meta);
  const status = usePreview((s) => s.status);
  const positionMs = usePreview((s) => s.positionMs);
  const durationMs = usePreview((s) => s.durationMs);
  const desktop = useDesktop();
  const foreground = useThemeColor('foreground');
  const accent = useThemeColor('accent');
  // De qué vista previa ya se pidió la descarga (al cambiar de canción vuelve el botón).
  const [sentId, setSentId] = useState<string | null>(null);
  const sent = !!id && sentId === id;

  if (!visible || !meta) return null;

  const download = () => {
    setSentId(id);
    meta.onDownload?.();
  };

  return (
    <View
      style={[
        { position: 'absolute', bottom, height: PREVIEW_BAR_HEIGHT, elevation: 8 },
        desktop ? { right: 16, width: 420 } : { left: 8, right: 8 },
      ]}
      className="rounded-2xl bg-card overflow-hidden border border-separator"
    >
      <View className="flex-row items-center pl-2 pr-1 pt-2">
        <View className="w-12 h-12 rounded-lg bg-separator overflow-hidden">
          {meta.thumbnail && <StyledImage source={{ uri: meta.thumbnail }} contentFit="cover" cachePolicy="disk" className="w-12 h-12" />}
        </View>
        <View className="flex-1 ml-3">
          <Marquee className="text-foreground text-base font-medium">{meta.title}</Marquee>
          <Text className="text-muted text-sm" numberOfLines={1}>
            {['Vista previa', meta.subtitle].filter(Boolean).join(' · ')}
          </Text>
        </View>
        {meta.onDownload && (
          <Pressable onPress={download} disabled={sent} hitSlop={6} className="w-10 h-11 items-center justify-center active:opacity-50" accessibilityLabel="Descargar">
            <Ionicons name={sent ? 'checkmark-circle' : 'arrow-down-circle-outline'} size={26} color={sent ? '#34c759' : accent} />
          </Pressable>
        )}
        <Pressable
          onPress={togglePreviewPause}
          disabled={status === 'loading'}
          hitSlop={6}
          className="w-11 h-11 items-center justify-center active:opacity-50"
          accessibilityLabel={status === 'paused' ? 'Reanudar vista previa' : 'Pausar vista previa'}
        >
          {status === 'loading' ? <ActivityIndicator color={foreground} /> : <Ionicons name={status === 'paused' ? 'play' : 'pause'} size={28} color={foreground} />}
        </Pressable>
        <Pressable onPress={stopPreview} hitSlop={6} className="w-10 h-11 items-center justify-center active:opacity-50" accessibilityLabel="Cerrar vista previa">
          <Ionicons name="close" size={26} color={foreground} />
        </Pressable>
      </View>
      <PreviewScrubber positionMs={positionMs} durationMs={durationMs} />
    </View>
  );
}

/** Barra arrastrable: muestra la posición mientras se arrastra y busca al soltar. */
function PreviewScrubber({ positionMs, durationMs }: { positionMs: number; durationMs: number | null }) {
  const [drag, setDrag] = useState<number | null>(null);
  const width = useRef(1);
  const duration = durationMs ?? 0;
  const ratio = drag ?? (duration ? clamp(positionMs / duration) : 0);
  const elapsed = ratio * duration;
  const at = (x: number) => clamp(x / width.current);

  return (
    <View className="flex-row items-center px-3 mt-1">
      <Text className="text-muted text-xs w-10" style={{ fontVariant: ['tabular-nums'] }}>
        {formatDuration(elapsed / 1000) || '0:00'}
      </Text>
      <View
        onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
        onStartShouldSetResponder={() => duration > 0}
        onMoveShouldSetResponder={() => duration > 0}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => setDrag(at(e.nativeEvent.locationX))}
        onResponderMove={(e) => setDrag(at(e.nativeEvent.locationX))}
        onResponderRelease={(e) => {
          seekPreview(at(e.nativeEvent.locationX) * duration);
          setDrag(null);
        }}
        onResponderTerminate={() => setDrag(null)}
        hitSlop={{ top: 10, bottom: 10 }}
        className="flex-1 h-8 justify-center mx-1"
        accessibilityLabel="Posición de la vista previa"
      >
        <View pointerEvents="none" className={`${drag !== null ? 'h-2' : 'h-1'} rounded-full bg-separator overflow-hidden`}>
          <View style={{ width: `${ratio * 100}%` }} className="h-full bg-accent" />
        </View>
      </View>
      <Text className="text-muted text-xs w-10 text-right" style={{ fontVariant: ['tabular-nums'] }}>
        {duration ? formatDuration(duration / 1000) : '--:--'}
      </Text>
    </View>
  );
}
