import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColor } from '@/components/theme';
import { currentSong, togglePlay, usePlayer } from '@/player/store';
import { BigText, NowPlayingCard, RoundButton, StyledImage } from '@/simple/ui';
import type { Episode } from '@/subscriptions/feeds';
import { episodeLength, relativeDate } from '@/subscriptions/format';
import { episodeTrackId, playEpisode } from '@/subscriptions/playback';
import { markOpened, refreshSubscription, type Subscription, useSubscriptions, visibleEpisodes } from '@/subscriptions/store';

/** Todas las oraciones de un canal, en grande: tocar ▶ la escucha (sigue donde se quedó). */
export default function SimpleSubscription() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sub = useSubscriptions().find((s) => s.id === id);
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');

  useEffect(() => {
    if (!id) return;
    markOpened(id);
    void refreshSubscription(id);
  }, [id]);

  const back = (
    <Pressable onPress={() => router.back()} hitSlop={12} className="flex-row items-center self-start py-2 active:opacity-50" accessibilityLabel="Volver">
      <Ionicons name="chevron-back" size={32} color={accent} />
      <BigText className="text-accent text-xl font-semibold">Volver</BigText>
    </Pressable>
  );

  if (!sub) {
    return (
      <View className="flex-1 bg-background px-5" style={{ paddingTop: insets.top + 8 }}>
        {back}
      </View>
    );
  }

  return (
    <FlatList
      className="bg-background"
      data={visibleEpisodes(sub)}
      keyExtractor={(e) => e.id}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 40 }}
      ListHeaderComponent={
        <View>
          <View className="px-5">{back}</View>
          <View className="flex-row items-center px-5 mt-2">
            <View className={`w-20 h-20 bg-card overflow-hidden items-center justify-center ${sub.kind === 'youtube' ? 'rounded-full' : 'rounded-2xl'}`}>
              <Ionicons name={sub.kind === 'youtube' ? 'logo-youtube' : 'mic'} size={28} color={muted} />
              {sub.image && <StyledImage source={{ uri: sub.image }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
            </View>
            <BigText className="flex-1 ml-4 text-foreground text-[28px] font-bold" numberOfLines={3}>{sub.title}</BigText>
          </View>
          <NowPlayingCard />
          <View className="h-4" />
        </View>
      }
      renderItem={({ item }) => <EpisodeCard sub={sub} episode={item} />}
    />
  );
}

function EpisodeCard({ sub, episode }: { sub: Subscription; episode: Episode }) {
  const muted = useThemeColor('muted');
  const trackId = episodeTrackId(sub.id, episode.id);
  const current = usePlayer((s) => currentSong(s)?.id === trackId);
  const playing = usePlayer((s) => currentSong(s)?.id === trackId && s.playWhenReady && s.playbackState !== 'ended');
  const [starting, setStarting] = useState(false);
  const progress = sub.progress[episode.id];
  const partial = !!progress && !progress.done && progress.positionMs > 0;
  const note = [
    relativeDate(episode.published),
    progress?.done
      ? 'Ya la escuchaste'
      : partial && progress.durationMs
        ? `Te quedan ${episodeLength(Math.max(60, (progress.durationMs - progress.positionMs) / 1000))}`
        : episodeLength(episode.durationSec),
  ]
    .filter(Boolean)
    .join(' · ');

  async function play() {
    if (current) return togglePlay();
    setStarting(true);
    try {
      await playEpisode(sub, episode);
    } catch (e) {
      Alert.alert('No se pudo reproducir', e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(false);
    }
  }

  return (
    <View className={`mx-5 mb-3 flex-row items-center rounded-3xl bg-card p-4 ${progress?.done && !current ? 'opacity-60' : ''}`}>
      <View className="flex-1 mr-3">
        <BigText className={`text-xl ${current ? 'text-accent font-bold' : 'text-foreground'}`} numberOfLines={3}>
          {episode.title}
        </BigText>
        <View className="flex-row items-center mt-1">
          {progress?.done && <Ionicons name="checkmark-circle" size={18} color={muted} style={{ marginRight: 6 }} />}
          <BigText className="text-muted text-base">{note}</BigText>
        </View>
      </View>
      <RoundButton icon={playing ? 'pause' : 'play'} onPress={play} busy={starting} label={playing ? 'Pausa' : `Escuchar ${episode.title}`} />
    </View>
  );
}
