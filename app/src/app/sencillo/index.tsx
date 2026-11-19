import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlaylists } from '@/api/queries';
import { playPinned } from '@/components/PinnedPlaylists';
import { PlaylistArt } from '@/components/rows';
import { songCount, useThemeColor } from '@/components/theme';
import { isFavoritesPlaylist, useEnsureFavoritesPlaylist } from '@/library/favorites';
import { FAVORITES_PIN, usePins } from '@/library/pins';
import { currentSong, togglePlay, usePlayer } from '@/player/store';
import { askExitSimpleMode } from '@/simple/actions';
import { useSimpleMode } from '@/simple/store';
import { BigText, greeting, longDate, NowPlayingCard, RoundButton, SectionTitle, StyledImage } from '@/simple/ui';
import { useSource, type Playlist } from '@/sources';
import type { Episode } from '@/subscriptions/feeds';
import { episodeLength } from '@/subscriptions/format';
import { episodeTrackId, playEpisode } from '@/subscriptions/playback';
import { type Subscription, useSubscriptions, visibleEpisodes } from '@/subscriptions/store';

/**
 * Inicio del modo sencillo: lo que suena, «Mis oraciones» (las suscripciones, con su episodio más nuevo sin
 * escuchar listo para tocar) y «Mis canciones» (las playlists fijadas). Nada escondido: todo se hace con un toque
 * en botones grandes.
 */
export default function SimpleHome() {
  const insets = useSafeAreaInsets();
  const subs = useSubscriptions();
  const muted = useThemeColor('muted');
  const { hiddenSubscriptions } = useSimpleMode();
  const withEpisodes = subs.filter((s) => !hiddenSubscriptions.includes(s.id) && visibleEpisodes(s).length > 0);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 40 }}>
      <View className="px-5">
        <BigText className="text-muted text-xl">{longDate()}</BigText>
        <BigText className="text-foreground text-[36px] font-bold">{greeting()}</BigText>
      </View>

      <NowPlayingCard />

      <SectionTitle>Mis oraciones</SectionTitle>
      {withEpisodes.length === 0 ? (
        <BigText className="text-muted text-lg px-5">
          Todavía no hay canales. Para añadirlos, sal del modo sencillo y entra en Biblioteca → Suscripciones.
        </BigText>
      ) : (
        withEpisodes.map((sub) => <SubscriptionCard key={sub.id} sub={sub} />)
      )}

      <SimplePlaylists />

      <Pressable onPress={askExitSimpleMode} hitSlop={10} className="flex-row items-center justify-center gap-2 mt-12 py-3 active:opacity-50">
        <Ionicons name="exit-outline" size={20} color={muted} />
        <BigText className="text-muted text-base">Salir del modo sencillo</BigText>
      </Pressable>
    </ScrollView>
  );
}

/** El episodio que toca: el más nuevo sin terminar (si todos están escuchados, el más nuevo). */
const nextEpisode = (sub: Subscription): Episode | undefined => {
  const list = visibleEpisodes(sub);
  return list.find((e) => !sub.progress[e.id]?.done) ?? list[0];
};

function SubscriptionCard({ sub }: { sub: Subscription }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const episode = nextEpisode(sub);
  const trackId = episode ? episodeTrackId(sub.id, episode.id) : null;
  const current = usePlayer((s) => !!trackId && currentSong(s)?.id === trackId);
  const playing = usePlayer((s) => !!trackId && currentSong(s)?.id === trackId && s.playWhenReady && s.playbackState !== 'ended');
  const [starting, setStarting] = useState(false);
  if (!episode) return null;

  const progress = sub.progress[episode.id];
  const partial = !!progress && !progress.done && progress.positionMs > 0;
  const fresh = !progress && !!episode.published && !!sub.lastOpened && episode.published > sub.lastOpened;
  const note = progress?.done
    ? 'Ya la escuchaste'
    : partial && progress.durationMs
      ? `Te quedan ${episodeLength(Math.max(60, (progress.durationMs - progress.positionMs) / 1000))}`
      : fresh
        ? 'Nueva'
        : episodeLength(episode.durationSec);

  async function play() {
    if (current) return togglePlay();
    setStarting(true);
    try {
      await playEpisode(sub, episode!);
    } catch (e) {
      Alert.alert('No se pudo reproducir', e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/sencillo/[id]', params: { id: sub.id } })}
      className="mx-5 mb-3 flex-row items-center rounded-3xl bg-card p-3 active:opacity-80"
      accessibilityLabel={`${sub.title}: ver todas`}
    >
      <View className={`w-20 h-20 bg-separator overflow-hidden items-center justify-center ${sub.kind === 'youtube' ? 'rounded-full' : 'rounded-2xl'}`}>
        <Ionicons name={sub.kind === 'youtube' ? 'logo-youtube' : 'mic'} size={28} color={muted} />
        {sub.image && <StyledImage source={{ uri: sub.image }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
      </View>
      <View className="flex-1 mx-3">
        <BigText className="text-foreground text-xl font-bold" numberOfLines={1}>{sub.title}</BigText>
        <BigText className="text-foreground text-lg" numberOfLines={2}>{episode.title}</BigText>
        {!!note && (
          <BigText className="text-base font-semibold" style={{ color: fresh ? accent : muted }}>
            {note}
          </BigText>
        )}
      </View>
      <RoundButton icon={playing ? 'pause' : 'play'} onPress={play} busy={starting} label={playing ? 'Pausa' : `Escuchar ${episode.title}`} />
    </Pressable>
  );
}

/** Las playlists fijadas (Canciones Favoritas incluida), en su orden; tocar ▶ las reproduce. */
function SimplePlaylists() {
  const source = useSource();
  const pins = usePins();
  const chosen = useSimpleMode().playlists;
  const playlists = usePlaylists();
  useEnsureFavoritesPlaylist(playlists.data);
  const all = playlists.data ?? [];
  // Las elegidas en Ajustes → Modo sencillo; si no se eligió nada, las fijadas de la Biblioteca.
  const pinned = chosen
    ? chosen.map((id) => all.find((p) => p.id === id)).filter((p): p is Playlist => !!p)
    : pins
        .map((pin) => (pin === FAVORITES_PIN ? all.find((p) => isFavoritesPlaylist(p, source)) : all.find((p) => p.id === pin)))
        .filter((p): p is Playlist => !!p);
  if (pinned.length === 0) return null;

  return (
    <>
      <SectionTitle>Mis canciones</SectionTitle>
      {pinned.map((p) => (
        <View key={p.id} className="mx-5 mb-3 flex-row items-center rounded-3xl bg-card p-3">
          <PlaylistArt playlist={p} size={80} className="w-20 h-20 rounded-2xl" />
          <View className="flex-1 mx-3">
            <BigText className="text-foreground text-xl font-bold" numberOfLines={2}>{p.name}</BigText>
            <BigText className="text-muted text-base">{songCount(p.songCount)}</BigText>
          </View>
          <RoundButton icon="play" onPress={() => void playPinned(source, p, false)} label={`Escuchar ${p.name}`} />
        </View>
      ))}
    </>
  );
}
