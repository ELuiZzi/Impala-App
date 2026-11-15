import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { withUniwind } from 'uniwind';
import {
  prefetchYoutubeAlbum,
  useYoutubeDownloads,
  useYoutubeSearch,
  youtubePreviewSource,
  type YoutubeAlbum,
  type YoutubeArtistResult,
  type YoutubeJob,
  type YoutubeResult,
} from '@/api/youtube';
import { useMaybeServerSession, useSource } from '@/sources';
import { openYoutubeActions } from '@/components/sheets/songActions';
import { stopPreview, togglePreview, usePreview } from '@/player/preview';
import { usePlayer } from '@/player/store';
import { contextMenu } from './desktop/contextMenu';
import { EmptyState, ErrorState, Loading } from './states';
import { formatDuration, useThemeColor } from './theme';
import { DEVICE } from '@/components/device';
import { ListMarquee } from '@/components/Marquee';

const StyledImage = withUniwind(Image);

/** 1791605301403 → "14:35" */
export const clock = (ms: number) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

/** 195698085 → "196 M vistas" */
function formatViews(views: number | null): string | null {
  if (!views) return null;
  if (views >= 1e6) return `${Math.round(views / 1e6)} M vistas`;
  if (views >= 1e3) return `${Math.round(views / 1e3)} k vistas`;
  return `${views} vistas`;
}

/**
 * Resultados de YouTube (pedidos desde el teléfono; el servidor, de respaldo): primero las canciones
 * de YouTube Music (el audio oficial) y después los videos. Tocar uno lo escucha como vista previa; la
 * flecha lo descarga.
 */
/** Álbumes que se piden por adelantado al llegar los resultados: los que más se suelen abrir. */
const PREFETCH_ALBUMS = 4;

export function YoutubeResults({ query }: { query: string }) {
  const source = useSource();
  const { music, videos } = useYoutubeSearch(query);
  const { jobs, start, cancel } = useYoutubeDownloads();
  const muted = useThemeColor('muted');

  // La vista previa no sigue sonando al salir de los resultados o cambiar de búsqueda.
  useEffect(() => stopPreview, [query]);

  // Los primeros álbumes se cargan mientras se leen los resultados: abrirlos es instantáneo.
  const albums = music.data?.albums ?? [];
  const prefetchIds = albums.slice(0, PREFETCH_ALBUMS).map((a) => a.id).join(',');
  useEffect(() => {
    for (const id of prefetchIds.split(',').filter(Boolean)) prefetchYoutubeAlbum(source, id).catch(() => {});
  }, [prefetchIds, source]);

  if (!query) {
    return (
      <EmptyState
        icon="logo-youtube"
        title="Busca en YouTube"
        subtitle="Escribe lo que buscas o pega un enlace de YouTube. Toca un resultado para escucharlo antes de descargarlo."
      />
    );
  }
  // La música llega antes; si falla, los videos aún pueden mostrarse.
  if (music.isPending && videos.isPending) return <Loading />;
  if (music.isError && videos.isError) return <ErrorState error={music.error} onRetry={() => (music.refetch(), videos.refetch())} />;

  const songs = (music.data?.results ?? []).filter((r) => r.kind === 'song');
  const artists = music.data?.artists ?? [];
  const seen = new Set(songs.map((s) => s.id));
  const videoResults = (videos.data?.results ?? []).filter((r) => r.kind === 'video' && !seen.has(r.id));
  const nothing = songs.length + albums.length + artists.length + videoResults.length === 0;
  if (nothing && !music.isPending && !videos.isPending) return <EmptyState icon="sad-outline" title={`Sin resultados para “${query}”`} />;

  // El trabajo más reciente de cada video (la lista llega ordenada de más nuevo a más viejo).
  const jobByVideo = new Map<string, YoutubeJob>();
  for (const job of jobs) if (!jobByVideo.has(job.videoId)) jobByVideo.set(job.videoId, job);

  const section = (title: string, items: YoutubeResult[]) =>
    items.length > 0 && (
      <View className="mb-4">
        <Text className="text-foreground text-[22px] font-bold px-5 mb-1">{title}</Text>
        {items.map((r) => (
          <ResultRow key={r.id} result={r} job={jobByVideo.get(r.id)} onDownload={() => start(r)} onCancel={(id) => cancel([id])} />
        ))}
      </View>
    );

  return (
    <View>
      {music.isPending && <Loading />}
      {/* Artistas y álbumes, en carrusel, arriba: después de 15 canciones quedarían fuera de la vista. */}
      {artists.length > 0 && (
        <View className="mb-4">
          <Text className="text-foreground text-[22px] font-bold px-5 mb-2">Artistas</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingHorizontal: 20 }}>
            {artists.map((a) => <ArtistTile key={a.id} artist={a} />)}
          </ScrollView>
        </View>
      )}
      {albums.length > 0 && (
        <View className="mb-4">
          <Text className="text-foreground text-[22px] font-bold px-5 mb-2">Álbumes</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}>
            {albums.map((a) => <AlbumTile key={a.id} album={a} />)}
          </ScrollView>
        </View>
      )}
      {section('Canciones', songs)}
      {section('Videos', videoResults)}
      {videos.isPending && !music.isPending && (
        <View className="flex-row items-center justify-center gap-2 py-4">
          <ActivityIndicator size="small" color={muted} />
          <Text className="text-muted text-sm">Buscando videos…</Text>
        </View>
      )}
    </View>
  );
}

/** Artista de YouTube Music: foto redonda; abre su página (populares, álbumes, sencillos). */
function ArtistTile({ artist }: { artist: YoutubeArtistResult }) {
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/youtube-artist/[id]', params: { id: artist.id, name: artist.name } })}
      className="w-28 items-center active:opacity-60"
      accessibilityLabel={`Abrir el artista ${artist.name}`}
    >
      <StyledImage source={artist.thumbnail ? { uri: artist.thumbnail } : undefined} contentFit="cover" cachePolicy="disk" className="w-28 h-28 rounded-full bg-card" />
      <ListMarquee rowHeight={150} className="text-foreground text-sm font-medium text-center" containerClassName="mt-1.5">{artist.name}</ListMarquee>
    </Pressable>
  );
}

/** "Álbum · 2015", "EP · 2020", "Sencillo"… */
export function albumKind(album: Pick<YoutubeAlbum, 'type' | 'year'>): string {
  const type = album.type === 'Single' ? 'Sencillo' : album.type === 'Album' || !album.type ? 'Álbum' : album.type;
  return [type, album.year].filter(Boolean).join(' · ');
}

/** Abre un álbum de YouTube Music; la cabecera se muestra al instante con los datos que ya hay. */
export function openYoutubeAlbum(album: YoutubeAlbum) {
  router.push({
    pathname: '/youtube-album/[id]',
    params: { id: album.id, title: album.title, artist: album.artist ?? '', thumbnail: album.thumbnail ?? '', kind: albumKind(album) },
  });
}

export function AlbumTile({ album }: { album: YoutubeAlbum }) {
  return (
    <Pressable
      onPress={() => openYoutubeAlbum(album)}
      className="w-36 active:opacity-60"
      accessibilityLabel={`Abrir el álbum ${album.title}`}
    >
      <StyledImage source={album.thumbnail ? { uri: album.thumbnail } : undefined} contentFit="cover" cachePolicy="disk" className="w-36 h-36 rounded-lg bg-card" />
      <View className="flex-row items-center mt-1.5">
        <ListMarquee rowHeight={190} className="text-foreground text-sm font-medium" containerClassName="flex-shrink">{album.title}</ListMarquee>
        {album.explicit && (
          <View className="ml-1 rounded-sm bg-separator px-1">
            <Text className="text-foreground text-[9px] font-bold">E</Text>
          </View>
        )}
      </View>
      <ListMarquee rowHeight={190} className="text-muted text-sm">{[album.artist, albumKind(album)].filter(Boolean).join(' · ')}</ListMarquee>
    </Pressable>
  );
}

export function ResultRow({ result, job, onDownload, onCancel }: { result: YoutubeResult; job?: YoutubeJob; onDownload: () => Promise<void>; onCancel?: (jobId: string) => Promise<void> }) {
  const source = useSource();
  const session = useMaybeServerSession();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const [sending, setSending] = useState(false);
  const mainPlaying = usePlayer((s) => s.playWhenReady);
  const preview = usePreview((s) => (s.id === result.id ? s.status : null));
  const progress = usePreview((s) => (s.id === result.id ? s.progress : 0));
  const active = sending || job?.status === 'queued' || job?.status === 'downloading' || job?.status === 'processing';

  async function download() {
    setSending(true);
    try {
      await onDownload();
    } catch (e) {
      Alert.alert('No se pudo descargar', e instanceof Error ? e.message : undefined);
    } finally {
      setSending(false);
    }
  }

  const listen = () => togglePreview(result.id, youtubePreviewSource(session, result.id), mainPlaying);
  const more = () => openYoutubeActions(source, result);

  // Tocar el indicador de una descarga en curso permite cancelarla.
  const confirmCancel = () =>
    job &&
    onCancel &&
    Alert.alert('Cancelar descarga', `¿Dejar de descargar «${result.title}»?`, [
      { text: 'Seguir', style: 'cancel' },
      { text: 'Cancelar descarga', style: 'destructive', onPress: () => onCancel(job.id).catch(() => {}) },
    ]);

  const detail =
    job?.status === 'queued' && job.waitingUntil ? `En pausa: YouTube pidió esperar (hasta las ${clock(job.waitingUntil)})`
    : job?.status === 'queued' ? 'En cola…'
    : job?.status === 'downloading' ? `Descargando… ${Math.round(job.progress * 100)}%`
    : job?.status === 'processing' ? 'Guardando en la biblioteca…'
    : job?.status === 'done' ? (job.duplicate ? 'Ya estaba en tu biblioteca' : 'En tu biblioteca')
    : job?.status === 'error' ? job.error
    : job?.status === 'cancelled' ? 'Descarga cancelada'
    : preview === 'error' ? 'No se pudo reproducir la vista previa'
    : result.kind === 'song'
      ? [result.artist, result.album, formatDuration(result.durationSec ?? undefined)].filter(Boolean).join(' · ')
      : [result.artist, result.channel && result.channel !== result.artist ? result.channel : null, formatDuration(result.durationSec ?? undefined), formatViews(result.views)]
          .filter(Boolean)
          .join(' · ');

  return (
    <Pressable onPress={listen} onLongPress={more} {...contextMenu(more)} className="flex-row items-center pl-5 pr-3 active:bg-card" accessibilityLabel={`Escuchar ${result.title}`}>
      <View className="w-12 h-12">
        <StyledImage source={{ uri: result.thumbnail }} contentFit="cover" cachePolicy="disk" className="w-12 h-12 rounded-md bg-card" />
        <View className={`absolute inset-0 items-center justify-center rounded-md ${preview ? 'bg-black/50' : ''}`}>
          {preview === 'loading' ? (
            <ActivityIndicator size="small" color="white" />
          ) : preview === 'playing' ? (
            <Ionicons name="stop" size={20} color="white" />
          ) : null}
        </View>
      </View>
      <View className="flex-1 flex-row items-center ml-3 py-2.5 border-b border-separator">
        <View className="flex-1">
          <View className="flex-row items-center">
            <ListMarquee always={!!preview && preview !== 'error'} className={`text-base ${preview && preview !== 'error' ? 'text-accent' : 'text-foreground'}`} containerClassName="flex-shrink">
              {result.title}
            </ListMarquee>
            {result.explicit && (
              <View className="ml-1.5 rounded-sm bg-separator px-1">
                <Text className="text-foreground text-[10px] font-bold">E</Text>
              </View>
            )}
          </View>
          <ListMarquee className={`text-sm ${job?.status === 'error' || preview === 'error' ? 'text-accent' : 'text-muted'}`}>{detail}</ListMarquee>
          {preview === 'playing' && (
            <View className="h-0.5 mt-1 rounded-full bg-separator overflow-hidden">
              <View style={{ width: `${Math.round(progress * 100)}%` }} className="h-full bg-accent" />
            </View>
          )}
        </View>
        <View className="w-9 items-end">
          {active ? (
            <Pressable onPress={confirmCancel} disabled={!job || !onCancel} hitSlop={10} accessibilityLabel="Cancelar descarga">
              <ActivityIndicator size="small" color={accent} />
            </Pressable>
          ) : job?.status === 'done' ? (
            <Ionicons name="checkmark-circle" size={24} color="#34c759" />
          ) : (
            <Pressable onPress={download} hitSlop={10} className="active:opacity-50" accessibilityLabel={source.kind === 'local' ? `Descargar al ${DEVICE}` : 'Descargar al servidor'}>
              <Ionicons name={job?.status === 'error' ? 'refresh-circle-outline' : 'arrow-down-circle-outline'} size={26} color={job?.status === 'error' ? muted : accent} />
            </Pressable>
          )}
        </View>
        <Pressable onPress={more} hitSlop={10} className="w-8 items-end active:opacity-50" accessibilityLabel="Más opciones">
          <Ionicons name="ellipsis-horizontal" size={20} color={muted} />
        </Pressable>
      </View>
    </Pressable>
  );
}
