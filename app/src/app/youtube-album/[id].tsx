import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';
import { isActive as isJobActive, resizeYoutubeThumbnail, useYoutubeAlbum, useYoutubeDownloads, type YoutubeAlbumTrack, type YoutubeJob } from '@/api/youtube';

import { ErrorState, Loading } from '@/components/states';
import { formatTotalDuration, songCount, useThemeColor } from '@/components/theme';
import { albumKind, ResultRow } from '@/components/YoutubeResults';
import { stopPreview } from '@/player/preview';
import { Marquee } from '@/components/Marquee';

const StyledImage = withUniwind(Image);

const isActive = (job?: YoutubeJob) => !!job && isJobActive(job);


/**
 * Álbum de YouTube Music: escuchar cada pista como vista previa y añadirlo entero a la biblioteca
 * (se descarga en el servidor con los datos del álbum en los tags).
 */
export default function YoutubeAlbumScreen() {
  // title, artist, thumbnail y kind (opcionales) vienen del resultado que se tocó: la cabecera se ve
  // al instante mientras llegan las pistas.
  const { id, title, artist, thumbnail, kind } = useLocalSearchParams<{ id: string; title?: string; artist?: string; thumbnail?: string; kind?: string }>();
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const album = useYoutubeAlbum(id);
  const { jobs, startAlbum, cancel } = useYoutubeDownloads();
  const [sending, setSending] = useState(false);

  useEffect(() => stopPreview, []);

  const back = (
    <View style={{ paddingTop: insets.top + 8 }} className="px-3">
      <View className="h-10 justify-center">
        <Pressable onPress={() => router.back()} hitSlop={12} className="active:opacity-50 self-start" accessibilityLabel="Atrás">
          <Ionicons name="chevron-back" size={28} color={accent} />
        </Pressable>
      </View>
    </View>
  );

  const a = album.data;
  if (!a) {
    return (
      <View className="flex-1 bg-background">
        {back}
        {!!title && !album.isError && (
          <AlbumHeader cover={resizeYoutubeThumbnail(thumbnail || null, 544)} title={title} artist={artist || null} meta={['YouTube Music', kind].filter(Boolean).join(' · ')} />
        )}
        {album.isError ? <ErrorState error={album.error} onRetry={album.refetch} /> : <Loading />}
      </View>
    );
  }

  // El trabajo más reciente de cada video (la lista llega de más nuevo a más viejo).
  const jobByVideo = new Map<string, YoutubeJob>();
  for (const job of jobs) if (!jobByVideo.has(job.videoId)) jobByVideo.set(job.videoId, job);

  const pending = a.tracks.filter((t) => {
    const job = jobByVideo.get(t.id);
    return !isActive(job) && job?.status !== 'done';
  });
  const downloading = a.tracks.filter((t) => isActive(jobByVideo.get(t.id))).length;
  const done = a.tracks.length - pending.length - downloading;
  const total = a.tracks.reduce((sum, t) => sum + (t.durationSec ?? 0), 0);

  async function download(tracks: YoutubeAlbumTrack[]) {
    setSending(true);
    try {
      await startAlbum(a!, tracks);
    } catch (e) {
      Alert.alert('No se pudo descargar', e instanceof Error ? e.message : undefined);
    } finally {
      setSending(false);
    }
  }

  const cancelAll = () =>
    Alert.alert('Cancelar descargas', 'Las canciones que ya terminaron se quedan en tu biblioteca.', [
      { text: 'Seguir', style: 'cancel' },
      {
        text: 'Cancelar el resto',
        style: 'destructive',
        onPress: () => cancel(a.tracks.map((t) => jobByVideo.get(t.id)).filter((j): j is YoutubeJob => !!j && isActive(j)).map((j) => j.id)),
      },
    ]);

  const status =
    downloading > 0 ? `Descargando… ${done} de ${a.tracks.length}`
    : pending.length === 0 ? 'En tu biblioteca'
    : done > 0 ? `Añadir ${songCount(pending.length)} que faltan`
    : 'Añadir a la biblioteca';

  return (
    <FlatList
      className="bg-background"
      data={a.tracks}
      keyExtractor={(t) => t.id}
      ListHeaderComponent={
        <View className="pb-2">
          {back}
          <AlbumHeader cover={a.cover ?? resizeYoutubeThumbnail(a.thumbnail, 544)} title={a.title} artist={a.artist} meta={['YouTube Music', albumKind(a)].join(' · ')} />
          <Pressable
            onPress={() => download(pending)}
            disabled={sending || downloading > 0 || pending.length === 0}
            className={`mx-5 mb-3 flex-row items-center justify-center gap-2 rounded-xl py-3 ${pending.length === 0 && downloading === 0 ? 'bg-card' : 'bg-accent active:opacity-80'}`}
          >
            {sending || downloading > 0 ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Ionicons name={pending.length === 0 ? 'checkmark-circle' : 'arrow-down-circle'} size={20} color={pending.length === 0 ? '#34c759' : '#ffffff'} />
            )}
            <Text className={`text-base font-semibold ${pending.length === 0 && downloading === 0 ? 'text-foreground' : 'text-accent-foreground'}`}>{status}</Text>
          </Pressable>
          {downloading > 0 && (
            <Pressable onPress={cancelAll} hitSlop={8} className="self-center mb-3 active:opacity-50">
              <Text className="text-accent text-sm font-semibold">Cancelar descargas</Text>
            </Pressable>
          )}
          <Text className="text-muted text-sm px-5 mb-1">Toca una canción para escucharla antes de descargarla.</Text>
        </View>
      }
      ListFooterComponent={
        <Text style={{ paddingBottom: insets.bottom + 32 }} className="text-muted text-sm px-5 pt-4">
          {[songCount(a.tracks.length), formatTotalDuration(total)].filter(Boolean).join(', ')}
        </Text>
      }
      renderItem={({ item }) => (
        <ResultRow result={item} job={jobByVideo.get(item.id)} onDownload={() => startAlbum(a, [item])} onCancel={(id) => cancel([id])} />
      )}
    />
  );
}

function AlbumHeader({ cover, title, artist, meta }: { cover: string | null; title: string; artist: string | null; meta: string }) {
  return (
    <View className="items-center px-8 pb-4">
      <StyledImage source={cover ? { uri: cover } : undefined} contentFit="cover" cachePolicy="disk" className="w-64 h-64 rounded-2xl bg-card" />
      <Text className="text-foreground text-[22px] font-bold text-center mt-5" numberOfLines={2}>{title}</Text>
      {artist ? (
        <Pressable
          onPress={() => router.push({ pathname: '/youtube-artist/[id]', params: { id: '_', name: artist.split(',')[0].trim() } })}
          hitSlop={6}
          className="active:opacity-50"
        >
          <Marquee className="text-accent text-[19px] text-center" containerClassName="mt-0.5">{artist}</Marquee>
        </Pressable>
      ) : null}
      <Text className="text-muted text-xs font-semibold uppercase text-center mt-1.5">{meta}</Text>
    </View>
  );
}
