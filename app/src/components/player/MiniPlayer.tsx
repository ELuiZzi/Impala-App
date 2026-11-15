import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { currentSong, next, togglePlay, usePlayer } from '@/player/store';
import { Artwork } from '../Artwork';
import { artistName, useThemeColor } from '../theme';
import { Marquee } from '@/components/Marquee';

export const MINI_PLAYER_HEIGHT = 64;

/** Tarjeta flotante sobre la barra de pestañas; al tocarla abre la pantalla "Reproduciendo". */
export function MiniPlayer({ bottom }: { bottom: number }) {
  const song = usePlayer(currentSong);
  const wantsToPlay = usePlayer((s) => s.playWhenReady);
  const buffering = usePlayer((s) => s.playbackState === 'buffering');
  const error = usePlayer((s) => s.error);
  const progress = usePlayer((s) => (s.durationMs ? Math.min(s.positionMs / s.durationMs, 1) : 0));
  const foreground = useThemeColor('foreground');

  if (!song) return null;

  return (
    <View
      style={{ position: 'absolute', left: 8, right: 8, bottom, height: MINI_PLAYER_HEIGHT, elevation: 6 }}
      className="rounded-2xl bg-card overflow-hidden"
    >
      <Pressable onPress={() => router.push('/reproduciendo')} className="flex-1 flex-row items-center pl-2 pr-1 active:opacity-80">
        <Artwork coverArt={song.coverArt} size={48} className="w-12 h-12 rounded-lg" />
        <View className="flex-1 ml-3">
          <Marquee className="text-foreground text-base font-medium">{song.title}</Marquee>
          <Marquee className={`text-sm ${error ? 'text-accent' : 'text-muted'}`}>
            {error ?? artistName(song.artist)}
          </Marquee>
        </View>
        <Pressable onPress={togglePlay} hitSlop={6} className="w-11 h-11 items-center justify-center active:opacity-50">
          {buffering && wantsToPlay ? (
            <ActivityIndicator color={foreground} />
          ) : (
            <Ionicons name={wantsToPlay ? 'pause' : 'play'} size={28} color={foreground} />
          )}
        </Pressable>
        <Pressable onPress={next} hitSlop={6} className="w-11 h-11 items-center justify-center active:opacity-50">
          <Ionicons name="play-forward" size={26} color={foreground} />
        </Pressable>
      </Pressable>
      <View className="absolute left-0 right-0 bottom-0 h-0.5 bg-separator">
        <View style={{ width: `${progress * 100}%` }} className="h-full bg-accent" />
      </View>
    </View>
  );
}
