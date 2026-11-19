import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { withUniwind } from 'uniwind';
import { contextMenu } from '@/components/desktop/contextMenu';
import { LargeTitle } from '@/components/LargeTitle';
import { closeSheet, showSheet, type SheetOption } from '@/components/sheets/store';
import { EmptyState } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { currentSong, togglePlay, usePlayer } from '@/player/store';
import { confirmUnsubscribe } from '@/subscriptions/actions';
import { canDownloadEpisodes, downloadedUri, downloadEpisode, removeDownload, syncDownloads, useEpisodeDownloading } from '@/subscriptions/downloads';
import { askNotificationPermission } from '@/subscriptions/notify';
import type { Episode } from '@/subscriptions/feeds';
import { episodeLength, relativeDate } from '@/subscriptions/format';
import { applyEpisodeSpeed, episodeTrackId, playEpisode } from '@/subscriptions/playback';
import {
  AUTO_DOWNLOAD_OPTIONS,
  EPISODE_SPEEDS,
  markOpened,
  setAutoDownload,
  setNotify,
  refreshSubscription,
  setEpisodeSpeed,
  setHideShorts,
  setProgress,
  type Subscription,
  useEpisodeSpeed,
  useSubscriptions,
  visibleEpisodes,
} from '@/subscriptions/store';

const StyledImage = withUniwind(Image);

/** Un canal o podcast: sus episodios del más nuevo al más viejo, con los nuevos marcados. */
export default function SuscripcionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sub = useSubscriptions().find((s) => s.id === id);
  const accent = useThemeColor('accent');
  const [refreshing, setRefreshing] = useState(false);
  // Lo «nuevo» se calcula con la última visita de ANTES de entrar (al entrar se marca como vista).
  const [seenBefore] = useState(() => sub?.lastOpened ?? null);

  useEffect(() => {
    if (!id) return;
    markOpened(id);
    void refreshSubscription(id);
  }, [id]);

  if (!sub) {
    return (
      <View className="flex-1">
        <LargeTitle title="" back />
        <EmptyState icon="radio-outline" title="Ya no sigues esta suscripción" />
      </View>
    );
  }

  const episodes = visibleEpisodes(sub);
  const shorts = sub.kind === 'youtube' ? sub.episodes.filter((e) => e.short).length : 0;

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshSubscription(sub!.id, { force: true });
    } finally {
      setRefreshing(false);
    }
  }

  function openMenu() {
    const s = sub!;
    const options: SheetOption[] = [];
    if (shorts > 0) {
      options.push({
        label: s.hideShorts ? `Mostrar los Shorts (${shorts})` : `Ocultar los Shorts (${shorts})`,
        icon: s.hideShorts ? 'eye-outline' : 'eye-off-outline',
        onPress: () => (closeSheet(), setHideShorts(s.id, !s.hideShorts)),
      });
    }
    if (canDownloadEpisodes) {
      options.push({
        label: s.autoDownload ? `Descarga automática: los ${s.autoDownload} más nuevos` : 'Descarga automática: desactivada',
        icon: 'arrow-down-circle-outline',
        onPress: () => {
          closeSheet();
          showSheet({
            kind: 'actions',
            title: 'Descarga automática',
            subtitle: 'Los episodios más nuevos sin escuchar, para oírlos sin internet. Se borran al terminarlos.',
            options: AUTO_DOWNLOAD_OPTIONS.map((n) => ({
              label: `${n === s.autoDownload ? '✓ ' : ''}${n === 0 ? 'Desactivada' : n === 1 ? 'El más nuevo' : `Los ${n} más nuevos`}`,
              icon: n === 0 ? 'close-circle-outline' : 'arrow-down-circle-outline',
              onPress: () => {
                closeSheet();
                setAutoDownload(s.id, n);
                void syncDownloads();
              },
            })),
          });
        },
      });
      options.push({
        label: s.notify ? 'Avisar de episodios nuevos: sí' : 'Avisar de episodios nuevos: no',
        icon: s.notify ? 'notifications' : 'notifications-off-outline',
        onPress: async () => {
          closeSheet();
          if (!s.notify && !(await askNotificationPermission())) {
            Alert.alert('Avisos desactivados', 'Permite las notificaciones de Impala en los ajustes de Android para recibir los avisos.');
          }
          setNotify(s.id, !s.notify);
        },
      });
    }
    options.push({
      label: 'Quitar suscripción',
      icon: 'trash-outline',
      destructive: true,
      onPress: () => (closeSheet(), confirmUnsubscribe(s, () => router.back())),
    });
    showSheet({ kind: 'actions', title: s.title, subtitle: s.kind === 'youtube' ? 'Canal de YouTube' : 'Podcast', thumbnail: s.image ?? undefined, options });
  }

  const header = (
    <View>
      <LargeTitle
        title=""
        back
        right={
          <Pressable onPress={openMenu} hitSlop={12} className="active:opacity-50" accessibilityLabel="Más opciones">
            <Ionicons name="ellipsis-horizontal-circle" size={28} color={accent} />
          </Pressable>
        }
      />
      <View className="items-center px-8 pb-4">
        <View className={`w-40 h-40 bg-card overflow-hidden items-center justify-center ${sub.kind === 'youtube' ? 'rounded-full' : 'rounded-2xl'}`}>
          <Ionicons name={sub.kind === 'youtube' ? 'logo-youtube' : 'mic'} size={48} color={accent} />
          {sub.image && <StyledImage source={{ uri: sub.image }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
        </View>
        <Text className="text-foreground text-[22px] font-bold text-center mt-4" numberOfLines={2}>{sub.title}</Text>
        <Text className="text-muted text-sm text-center mt-1">
          {[sub.kind === 'youtube' ? 'Canal de YouTube' : 'Podcast', sub.author && sub.author !== sub.title ? sub.author : null, `${episodes.length} episodios`]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {sub.error && <Text className="text-accent text-sm text-center mt-2">{sub.error}</Text>}
        {sub.hideShorts && shorts > 0 && <Text className="text-muted text-xs text-center mt-2">{`${shorts} Shorts ocultos`}</Text>}
        <View className="mt-3">
          <SpeedButton />
        </View>
      </View>
    </View>
  );

  return (
    <FlatList
      data={episodes}
      keyExtractor={(e) => e.id}
      ListHeaderComponent={header}
      ListEmptyComponent={<EmptyState icon="time-outline" title="Sin episodios todavía" subtitle="Cuando publique algo nuevo aparecerá aquí." />}
      refreshing={refreshing}
      onRefresh={refresh}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => <EpisodeRow sub={sub} episode={item} isNew={!!item.published && !!seenBefore && item.published > seenBefore} />}
    />
  );
}

function EpisodeRow({ sub, episode, isNew }: { sub: Subscription; episode: Episode; isNew: boolean }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const trackId = episodeTrackId(sub.id, episode.id);
  const current = usePlayer((s) => currentSong(s)?.id === trackId);
  const playing = usePlayer((s) => currentSong(s)?.id === trackId && s.playWhenReady && s.playbackState !== 'ended');
  const loading = usePlayer((s) => currentSong(s)?.id === trackId && s.playWhenReady && s.playbackState === 'buffering');
  const [starting, setStarting] = useState(false);
  const downloading = useEpisodeDownloading(sub.id, episode.id);
  const downloaded = !!downloadedUri(sub, episode);
  const youtube = sub.kind === 'youtube';
  const progress = sub.progress[episode.id];
  const durationMs = progress?.durationMs ?? (episode.durationSec ? episode.durationSec * 1000 : null);
  const partial = !!progress && !progress.done && progress.positionMs > 0;

  async function play(fromStart = false) {
    if (current && !fromStart) return togglePlay();
    setStarting(true);
    try {
      await playEpisode(sub, episode, { fromStart });
    } catch (e) {
      Alert.alert('No se pudo reproducir', e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(false);
    }
  }

  const more = () => {
    const options: SheetOption[] = [];
    if (partial) options.push({ label: 'Escuchar desde el principio', icon: 'play-back', onPress: () => (closeSheet(), void play(true)) });
    if (canDownloadEpisodes && !downloading) {
      options.push(
        downloaded
          ? { label: 'Quitar la descarga', icon: 'trash-outline', onPress: () => (closeSheet(), removeDownload(sub, episode.id)) }
          : {
              label: 'Descargar para escuchar sin internet',
              icon: 'arrow-down-circle-outline',
              onPress: () => {
                closeSheet();
                downloadEpisode(sub, episode).catch((e) => Alert.alert('No se pudo descargar', e instanceof Error ? e.message : undefined));
              },
            },
      );
    }
    options.push(
      progress?.done
        ? { label: 'Marcar como no escuchado', icon: 'ellipse-outline', onPress: () => (closeSheet(), setProgress(sub.id, episode.id, null)) }
        : {
            label: 'Marcar como escuchado',
            icon: 'checkmark-circle-outline',
            onPress: () => (closeSheet(), setProgress(sub.id, episode.id, { positionMs: 0, durationMs, done: true })),
          },
    );
    showSheet({ kind: 'actions', title: episode.title, subtitle: sub.title, thumbnail: episode.image ?? undefined, options });
  };

  const left = partial && durationMs ? `Quedan ${episodeLength(Math.max(60, (durationMs - progress.positionMs) / 1000))}` : null;
  const meta = [
    relativeDate(episode.published),
    progress?.done ? 'Escuchado' : (left ?? episodeLength(episode.durationSec)),
    episode.short ? 'Short' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable onPress={() => void play()} onLongPress={more} {...contextMenu(more)} className="flex-row items-center px-5 active:bg-card" accessibilityLabel={`Escuchar ${episode.title}`}>
      <View className={`${youtube ? 'w-24 h-[54px]' : 'w-14 h-14'} rounded-md bg-card overflow-hidden items-center justify-center ${progress?.done && !current ? 'opacity-50' : ''}`}>
        <Ionicons name={youtube ? 'logo-youtube' : 'mic'} size={18} color={muted} />
        {episode.image && <StyledImage source={{ uri: episode.image }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
        {(current || starting) && (
          <View className="absolute inset-0 items-center justify-center bg-black/50">
            {starting || loading ? <ActivityIndicator size="small" color="white" /> : <Ionicons name={playing ? 'pause' : 'play'} size={18} color="white" />}
          </View>
        )}
      </View>
      <View className="flex-1 ml-3 py-3 border-b border-separator">
        <Text className={`text-base ${current ? 'text-accent' : progress?.done ? 'text-muted' : 'text-foreground'}`} numberOfLines={2}>
          {episode.title}
        </Text>
        <View className="flex-row items-center mt-0.5">
          {isNew && !progress && (
            <View style={{ backgroundColor: accent }} className="rounded px-1.5 mr-1.5">
              <Text className="text-white text-[10px] font-bold">NUEVO</Text>
            </View>
          )}
          {progress?.done && <Ionicons name="checkmark-circle" size={14} color={muted} style={{ marginRight: 4 }} />}
          {downloading ? (
            <ActivityIndicator size="small" color={muted} style={{ marginRight: 4, transform: [{ scale: 0.7 }] }} />
          ) : downloaded ? (
            <Ionicons name="arrow-down-circle" size={14} color={accent} style={{ marginRight: 4 }} accessibilityLabel="Descargado" />
          ) : null}
          <Text className="text-sm flex-shrink text-muted" numberOfLines={1}>{meta}</Text>
        </View>
        {partial && durationMs && (
          <View className="h-1 mt-1.5 rounded-full bg-separator overflow-hidden w-32">
            <View style={{ width: `${Math.min(100, (progress.positionMs / durationMs) * 100)}%` }} className="h-full bg-accent" />
          </View>
        )}
      </View>
    </Pressable>
  );
}

/** Velocidad de los episodios: 1× → 1,25× → … → 2× → 1×. */
function SpeedButton() {
  const speed = useEpisodeSpeed();
  const accent = useThemeColor('accent');
  const next = () => {
    const value = EPISODE_SPEEDS[(EPISODE_SPEEDS.indexOf(speed) + 1) % EPISODE_SPEEDS.length];
    setEpisodeSpeed(value);
    applyEpisodeSpeed(value);
  };
  return (
    <Pressable onPress={next} hitSlop={8} className="flex-row items-center gap-1 rounded-full bg-card px-3 py-1.5 active:opacity-60" accessibilityLabel="Velocidad de los episodios">
      <Ionicons name="speedometer-outline" size={16} color={accent} />
      <Text className="text-accent text-sm font-semibold">{`${String(speed).replace('.', ',')}×`}</Text>
    </Pressable>
  );
}
