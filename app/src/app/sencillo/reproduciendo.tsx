import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Artwork } from '@/components/Artwork';
import { formatDuration, useThemeColor } from '@/components/theme';
import { currentSong, isEpisodeId, next, playerState, previous, seekTo, togglePlay, usePlayer } from '@/player/store';
import { BigText, RoundButton } from '@/simple/ui';

/**
 * Reproductor del modo sencillo: carátula grande, título y tres botones grandes. Sin gestos escondidos, sin
 * aleatorio ni letra. La barra de tiempo solo informa (para no mover la posición sin querer); en las oraciones
 * se va hacia atrás o adelante con los botones de 15 y 30 s.
 */
export default function SimplePlayer() {
  const song = usePlayer(currentSong);
  const wantsToPlay = usePlayer((s) => s.playWhenReady && s.playbackState !== 'ended');
  const buffering = usePlayer((s) => s.playWhenReady && s.playbackState === 'buffering');
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const error = usePlayer((s) => s.error);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const accent = useThemeColor('accent');
  const foreground = useThemeColor('foreground');

  // Si ya no suena nada (se terminó la cola), de vuelta al inicio.
  useEffect(() => {
    if (!song && router.canGoBack()) router.back();
  }, [song]);

  if (!song) return <View className="flex-1 bg-background" />;

  const episode = isEpisodeId(song.id);
  const art = Math.min(width - 64, height * 0.4, 420);
  const progress = durationMs ? Math.min(1, positionMs / durationMs) : 0;
  const jump = (ms: number) => {
    const s = playerState();
    return seekTo(Math.max(0, Math.min(s.positionMs + ms, (s.durationMs ?? Infinity) - 1000)));
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}>
      <Pressable onPress={() => router.back()} hitSlop={12} className="flex-row items-center self-start px-5 py-2 active:opacity-50" accessibilityLabel="Cerrar">
        <Ionicons name="chevron-down" size={32} color={accent} />
        <BigText className="text-accent text-xl font-semibold ml-1">Cerrar</BigText>
      </Pressable>

      <View className="flex-1 items-center justify-center px-8">
        <View style={{ width: art, height: art }}>
          <Artwork coverArt={song.coverArt} size={art} className="w-full h-full rounded-3xl" />
        </View>
        <BigText className="text-foreground text-[26px] font-bold text-center mt-6" numberOfLines={3}>
          {song.title}
        </BigText>
        {!!song.artist && (
          <BigText className="text-muted text-xl text-center mt-1" numberOfLines={2}>
            {song.artist}
          </BigText>
        )}
        {error && <BigText className="text-accent text-lg text-center mt-2">{error}</BigText>}
      </View>

      <View className="px-8">
        <View className="h-2.5 rounded-full bg-separator overflow-hidden">
          <View style={{ width: `${progress * 100}%` }} className="h-full bg-accent" />
        </View>
        <View className="flex-row justify-between mt-2">
          <BigText className="text-muted text-lg">{formatDuration(positionMs / 1000) || '0:00'}</BigText>
          <BigText className="text-muted text-lg">{durationMs ? formatDuration(durationMs / 1000) : ''}</BigText>
        </View>
      </View>

      <View className="flex-row items-center justify-around px-6 mt-6">
        <Pressable
          onPress={() => (episode ? jump(-15_000) : previous())}
          hitSlop={10}
          className="w-20 h-20 items-center justify-center active:opacity-50"
          accessibilityLabel={episode ? 'Atrás 15 segundos' : 'Anterior'}
        >
          <Ionicons name={episode ? 'play-back-circle-outline' : 'play-skip-back'} size={episode ? 64 : 48} color={foreground} />
          {episode && <BigText className="text-foreground text-base font-bold">15 s</BigText>}
        </Pressable>
        <RoundButton icon={wantsToPlay ? 'pause' : 'play'} onPress={togglePlay} size={104} busy={buffering} label={wantsToPlay ? 'Pausa' : 'Reproducir'} />
        <Pressable
          onPress={() => (episode ? jump(30_000) : next())}
          hitSlop={10}
          className="w-20 h-20 items-center justify-center active:opacity-50"
          accessibilityLabel={episode ? 'Adelante 30 segundos' : 'Siguiente'}
        >
          <Ionicons name={episode ? 'play-forward-circle-outline' : 'play-skip-forward'} size={episode ? 64 : 48} color={foreground} />
          {episode && <BigText className="text-foreground text-base font-bold">30 s</BigText>}
        </Pressable>
      </View>
    </View>
  );
}
