import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';
import { useArtist, useArtistSongs, useLibraryArtistByName } from '@/api/queries';
import { fold, useYoutubeArtist, useYoutubeDownloads, type YoutubeAlbum, type YoutubeJob, type YoutubeResult } from '@/api/youtube';
import { downloadSongs } from '@/offline/store';
import { stopPreview } from '@/player/preview';
import { artistSubscription, openSubscription, subscribeToArtist } from '@/subscriptions/actions';
import { PREVIEW_BAR_HEIGHT, usePreviewBarVisible } from '@/components/player/PreviewBar';
import { playSongs } from '@/player/store';
import { useSource, type Song } from '@/sources';
import { AlbumTile as LibraryAlbumTile, SongRow } from './rows';
import { openSongActions } from './sheets/songActions';
import { closeSheet, showSheet, type SheetOption } from './sheets/store';
import { ErrorState, Loading } from './states';
import { artistName, useThemeColor } from './theme';
import { showToast } from './Toast';
import { AlbumTile as YoutubeAlbumTile, ResultRow } from './YoutubeResults';
import { DEVICE } from '@/components/device';

const StyledImage = withUniwind(Image);
/** Populares visibles de entrada; "Ver todas" muestra el resto (hasta 25). */
const TOP_PREVIEW = 5;

type Props = {
  /** Artista de la biblioteca (de la fuente activa). */
  libraryId?: string;
  /** Canal de YouTube Music (desde la búsqueda de YouTube). */
  youtubeId?: string;
  /** Nombre conocido de antemano: enlaza las dos fuentes y muestra el título al instante. */
  name?: string;
};

/** Una canción popular de YouTube Music: la de la biblioteca si ya la tienes, o el resultado de YouTube. */
type Popular = { kind: 'library'; song: Song; result: YoutubeResult } | { kind: 'youtube'; result: YoutubeResult };

/**
 * Página de artista al estilo de Apple Music: foto grande, "Populares" (lo más escuchado ahora según
 * YouTube Music; las que no tienes se pueden escuchar y descargar), sus álbumes en la biblioteca y,
 * después, los álbumes y sencillos de YouTube Music que aún no tienes.
 */
export function ArtistPage({ libraryId, youtubeId, name: knownName }: Props) {
  const source = useSource();
  const insets = useSafeAreaInsets();
  const previewing = usePreviewBarVisible();
  const { width } = useWindowDimensions();
  const accent = useThemeColor('accent');
  const background = useThemeColor('background');
  const [showAll, setShowAll] = useState(false);

  // Desde YouTube se busca el mismo artista en la biblioteca (por nombre), y viceversa.
  const byName = useLibraryArtistByName(libraryId ? undefined : knownName);
  const libId = libraryId ?? byName.data?.id;
  const library = useArtist(libId ?? '', !!libId);
  const name = library.data?.name ?? knownName;
  const youtube = useYoutubeArtist(youtubeId ? { id: youtubeId } : name ? { name: artistName(name) } : null);
  const songs = useArtistSongs(libId ? name : undefined, libId);
  const { jobs, startMany, start, cancel } = useYoutubeDownloads();

  useEffect(() => stopPreview, []);

  // Sin YouTube (música del teléfono) la página es solo la de la biblioteca: no se espera nada de él.
  const youtubeOn = source.capabilities.youtube;
  const youtubePending = youtubeOn && youtube.isPending;
  const title = name ?? youtube.data?.name ?? '';
  const librarySongs = useMemo(() => songs.data ?? [], [songs.data]);

  // Populares: el orden de YouTube Music, con la versión de la biblioteca cuando ya la tienes.
  const populars = useMemo<Popular[]>(() => {
    // YouTube Music repite canciones (la misma en el sencillo y en el álbum): una por título completo.
    const seen = new Set<string>();
    const top = (youtube.data?.songs ?? []).filter((r) => {
      const key = foldFull(r.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const used = new Set<string>();
    return top.map((result) => {
      // Mismo título completo ("Dracula (feat. JENNIE)" no es "Dracula"); sin lo de los paréntesis
      // ("Remastered", "Radio Edit"…) solo si además dura lo mismo.
      const candidates = librarySongs.filter((s) => !used.has(s.id));
      const song =
        candidates.find((s) => foldFull(s.title) === foldFull(result.title)) ??
        candidates.find(
          (s) => fold(s.title) === fold(result.title) && !!s.duration && !!result.durationSec && Math.abs(s.duration - result.durationSec) <= 3,
        );
      if (!song) return { kind: 'youtube', result };
      used.add(song.id);
      return { kind: 'library', song, result };
    });
  }, [youtube.data, librarySongs]);
  const owned = populars.flatMap((p) => (p.kind === 'library' ? [p.song] : []));
  const missing = populars.flatMap((p) => (p.kind === 'youtube' ? [p.result] : []));

  // Álbumes de YouTube Music que no están en la biblioteca (por título).
  const libraryAlbums = library.data?.album ?? [];
  const ownedTitles = new Set(libraryAlbums.map((a) => fold(a.name)));
  const notOwned = (list: YoutubeAlbum[] | undefined) => (list ?? []).filter((a) => !ownedTitles.has(fold(a.title)));
  const ytAlbums = notOwned(youtube.data?.albums);
  const ytSingles = notOwned(youtube.data?.singles);

  // Reproducir: primero las populares que tienes y luego el resto de sus canciones.
  const playQueue = useMemo(() => {
    const ids = new Set(owned.map((s) => s.id));
    return [...owned, ...librarySongs.filter((s) => !ids.has(s.id))];
  }, [owned, librarySongs]);

  const jobByVideo = new Map<string, YoutubeJob>();
  for (const job of jobs) if (!jobByVideo.has(job.videoId)) jobByVideo.set(job.videoId, job);
  const missingNotQueued = missing.filter((r) => {
    const job = jobByVideo.get(r.id);
    return !job || job.status === 'error' || job.status === 'cancelled';
  });

  const loading = (libId ? library.isPending : false) && (youtubePending || !youtubeOn);
  const failed = (!libId || library.isError) && youtube.isError && !library.data;
  // La foto de YouTube Music; la de Navidrome solo si YouTube no responde (así no cambia a media carga).
  const image =
    youtube.data?.image?.replace(/=w\d+-h\d+/, '=w1200-h1200') ??
    (!youtubePending && library.data?.coverArt ? source.coverUrl(library.data.coverArt, 900) : undefined);
  const heroHeight = Math.min(width, 460) * 0.95;

  const openMenu = () => {
    const options: SheetOption[] = [];
    if (playQueue.length > 0) {
      options.push(
        { label: 'Reproducir', icon: 'play', onPress: () => (closeSheet(), playSongs(playQueue, 0)) },
        { label: 'Aleatorio', icon: 'shuffle', onPress: () => (closeSheet(), playSongs(playQueue, 0, { shuffle: true })) },
      );
      if (source.capabilities.offlineDownloads) {
        options.push({
          label: `Descargar sus canciones en el ${DEVICE}`,
          icon: 'arrow-down-circle-outline',
          onPress: () => (closeSheet(), downloadSongs(source, librarySongs)),
        });
      }
    }
    if (missingNotQueued.length > 0) {
      options.push({
        label: `Añadir a la biblioteca las populares que faltan (${missingNotQueued.length})`,
        icon: 'cloud-download-outline',
        onPress: async () => {
          await startMany(missingNotQueued);
          closeSheet();
          showToast(`Descargando ${missingNotQueued.length} canciones de ${title} en ${source.kind === 'local' ? `el ${DEVICE}` : 'el servidor'}`, 'cloud-download-outline');
        },
      });
    }
    // Seguir su canal de YouTube: sus videos nuevos llegan a Suscripciones.
    const channelId = youtube.data?.id;
    if (youtubeOn && title) {
      const followed = artistSubscription(channelId, artistName(title));
      options.push(
        followed
          ? { label: 'Ver su canal en Suscripciones', icon: 'radio', onPress: () => (closeSheet(), openSubscription(followed)) }
          : {
              label: 'Suscribirse a su canal',
              icon: 'radio-outline',
              onPress: async () => {
                closeSheet();
                await subscribeToArtist(artistName(title), channelId);
              },
            },
      );
    }
    if (options.length === 0) return;
    showSheet({ kind: 'actions', title: artistName(title), subtitle: 'Artista', coverArt: library.data?.coverArt, thumbnail: image, options });
  };

  const visible = showAll ? populars : populars.slice(0, TOP_PREVIEW);

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ paddingBottom: insets.bottom + 32 + (previewing ? PREVIEW_BAR_HEIGHT : 0) }}>
      {/* Foto grande con el nombre encima, fundida con el fondo. */}
      <View style={{ height: heroHeight }} className="bg-card">
        {image && <StyledImage source={{ uri: image }} contentFit="cover" cachePolicy="disk" transition={250} className="absolute inset-0" />}
        <LinearGradient colors={['rgba(0,0,0,0.35)', 'transparent', 'transparent', background]} locations={[0, 0.25, 0.6, 1]} style={{ position: 'absolute', inset: 0 }} />
        <View style={{ paddingTop: insets.top + 8 }} className="flex-row items-center justify-between px-3">
          <Pressable onPress={() => router.back()} hitSlop={12} className="w-9 h-9 rounded-full bg-black/35 items-center justify-center active:opacity-50" accessibilityLabel="Atrás">
            <Ionicons name="chevron-back" size={24} color="white" />
          </Pressable>
          <Pressable onPress={openMenu} hitSlop={12} className="w-9 h-9 rounded-full bg-black/35 items-center justify-center active:opacity-50" accessibilityLabel="Más opciones">
            <Ionicons name="ellipsis-horizontal" size={20} color="white" />
          </Pressable>
        </View>
        <View className="absolute left-5 right-5 bottom-3 flex-row items-end">
          <Text className="flex-1 text-foreground text-[34px] font-bold" numberOfLines={2}>{artistName(title)}</Text>
          {playQueue.length > 0 && (
            <Pressable
              onPress={() => playSongs(playQueue, 0)}
              className="ml-3 w-14 h-14 rounded-full bg-accent items-center justify-center active:opacity-80"
              accessibilityLabel={`Reproducir ${artistName(title)}`}
            >
              <Ionicons name="play" size={26} color="white" style={{ marginLeft: 3 }} />
            </Pressable>
          )}
        </View>
      </View>

      {loading && <Loading />}
      {failed && <ErrorState error={youtube.error} onRetry={() => (youtube.refetch(), library.refetch())} />}

      {populars.length > 0 && (
        <View className="mt-4">
          <SectionTitle title="Populares" />
          {visible.map((p, i) =>
            p.kind === 'library' ? (
              <SongRow
                key={p.result.id}
                song={p.song}
                onPress={() => playSongs(owned, owned.indexOf(p.song))}
                onMore={() => openSongActions(source, p.song)}
              />
            ) : (
              <ResultRow key={p.result.id} result={p.result} job={jobByVideo.get(p.result.id)} onDownload={() => start(p.result)} onCancel={(id) => cancel([id])} />
            ),
          )}
          {populars.length > TOP_PREVIEW && (
            <Pressable onPress={() => setShowAll((v) => !v)} hitSlop={8} className="px-5 py-3 active:opacity-50">
              <Text className="text-accent text-base font-semibold">{showAll ? 'Ver menos' : `Ver las ${populars.length}`}</Text>
            </Pressable>
          )}
          {missing.length > 0 && (
            <Text className="text-muted text-xs px-5 mt-1">
              Las que aún no tienes se escuchan como vista previa; la flecha las descarga a tu biblioteca.
            </Text>
          )}
        </View>
      )}
      {youtubePending && !loading && populars.length === 0 && <Loading />}

      {!youtubeOn && librarySongs.length > 0 && (
        <View className="mt-4">
          <SectionTitle title="Canciones" />
          {librarySongs.map((song, i) => (
            <SongRow key={song.id} song={song} onPress={() => playSongs(librarySongs, i)} onMore={() => openSongActions(source, song)} />
          ))}
        </View>
      )}

      {libraryAlbums.length > 0 && (
        <View className="mt-6">
          <SectionTitle title="En tu biblioteca" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}>
            {libraryAlbums.map((a) => (
              <View key={a.id} className="w-36">
                <LibraryAlbumTile album={a} onPress={() => router.push({ pathname: '/biblioteca/album/[id]', params: { id: a.id } })} />
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {ytAlbums.length > 0 && (
        <View className="mt-6">
          <SectionTitle title="Álbumes en YouTube Music" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}>
            {ytAlbums.map((a) => <YoutubeAlbumTile key={a.id} album={a} />)}
          </ScrollView>
        </View>
      )}

      {ytSingles.length > 0 && (
        <View className="mt-6">
          <SectionTitle title="Sencillos y EP" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}>
            {ytSingles.map((a) => <YoutubeAlbumTile key={a.id} album={a} />)}
          </ScrollView>
        </View>
      )}

      {youtube.isError && !failed && (
        <View className="flex-row items-center gap-2 px-5 mt-6">
          <Ionicons name="cloud-offline-outline" size={16} color={accent} />
          <Text className="text-muted text-sm flex-1">No se pudo consultar YouTube Music: {youtube.error instanceof Error ? youtube.error.message : ''}</Text>
        </View>
      )}
    </ScrollView>
  );
}

/** Como fold, pero conserva lo que va entre paréntesis: "Dracula (feat. JENNIE)" → "dracula feat jennie". */
const foldFull = (text: string | null | undefined) =>
  (text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

function SectionTitle({ title }: { title: string }) {
  return <Text className="text-foreground text-[22px] font-bold px-5 mb-2">{title}</Text>;
}
