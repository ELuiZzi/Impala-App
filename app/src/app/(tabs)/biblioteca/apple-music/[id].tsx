import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { withUniwind } from 'uniwind';
import {
  deleteAppleImport,
  IMPORT_STATUS,
  cancelAppleImport,
  isImportBusy,
  retryAppleImport,
  startAppleImport,
  useAppleImport,
  type ImportJob,
  type ImportTrack,
} from '@/api/applemusic';
import { usePlaylists } from '@/api/queries';
import { youtubePreviewSource } from '@/api/youtube';
import { useMaybeServerSession, useSource, type Playlist } from '@/sources';
import { LargeTitle } from '@/components/LargeTitle';
import { PlaylistArt } from '@/components/rows';
import { closeSheet, showSheet } from '@/components/sheets/store';
import { ErrorState, Loading } from '@/components/states';
import { formatDuration, songCount, useThemeColor } from '@/components/theme';
import { clock } from '@/components/YoutubeResults';
import { stopPreview, togglePreview, usePreview } from '@/player/preview';
import { usePlayer } from '@/player/store';
import { ListMarquee, Marquee } from '@/components/Marquee';

const StyledImage = withUniwind(Image);
const GREEN = '#34c759';

/**
 * Una importación de Apple Music: qué canciones ya están en la biblioteca, cuáles se descargarán de
 * YouTube Music (se pueden escuchar y desmarcar) y cuáles no se encontraron; después, el progreso.
 */
export default function AppleImportScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const source = useSource();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const job = useAppleImport(id);
  const playlists = usePlaylists();
  const [name, setName] = useState<string | null>(null);
  const [skip, setSkip] = useState<Set<number>>(() => new Set());
  const [starting, setStarting] = useState(false);
  const [appendTo, setAppendTo] = useState<Playlist | null>(null);

  useEffect(() => stopPreview, []);

  const j = job.data;
  if (!j) {
    return (
      <View className="flex-1">
        <LargeTitle title="Importar" back />
        {job.isError ? <ErrorState error={job.error} onRetry={job.refetch} /> : <Loading />}
      </View>
    );
  }

  const tracks = j.tracks ?? [];
  const toDownload = tracks.filter((t) => t.state === 'youtube' && !skip.has(t.index)).length;
  const toAdd = j.counts.library + toDownload;
  const playlistName = name ?? j.name ?? '';
  const existing = playlists.data?.find((p) => p.name === (playlistName.trim() || j.name) && source.isOwnPlaylist(p));

  async function start() {
    setStarting(true);
    try {
      await startAppleImport(source, j!.id, { name: playlistName.trim() || j!.name || 'Playlist importada', skip: [...skip], appendTo: appendTo?.id });
      await job.refetch();
    } catch (e) {
      Alert.alert('No se pudo empezar', e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(false);
    }
  }

  /** Elegir la playlist existente a la que se añadirán las canciones. */
  function chooseTarget() {
    const own = (playlists.data ?? []).filter((p) => source.isOwnPlaylist(p));
    showSheet({
      kind: 'actions',
      title: 'Añadir a una playlist',
      subtitle: 'Las canciones que ya tenga no se repiten',
      options: own.map((p) => ({ label: p.name, icon: 'list' as const, onPress: () => (closeSheet(), setAppendTo(p)) })),
    });
  }

  function cancelDownloads() {
    Alert.alert('Cancelar descargas', 'Las canciones que ya se descargaron se quedan y se guardan en la playlist.', [
      { text: 'Seguir', style: 'cancel' },
      {
        text: 'Cancelar el resto',
        style: 'destructive',
        onPress: () => cancelAppleImport(source, j!.id).then(() => job.refetch()).catch((e) => Alert.alert('No se pudo cancelar', e instanceof Error ? e.message : undefined)),
      },
    ]);
  }

  const retriable = tracks.filter((t) => t.state === 'failed' && t.match?.source === 'youtube').length;

  async function retry() {
    setStarting(true);
    try {
      await retryAppleImport(source, j!.id);
      await job.refetch();
    } catch (e) {
      Alert.alert('No se pudo reintentar', e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(false);
    }
  }

  function discard() {
    Alert.alert('Descartar importación', 'Se quitará de la lista. Las canciones ya descargadas se quedan en tu biblioteca.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Descartar',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteAppleImport(source, j!.id);
            router.back();
          } catch (e) {
            Alert.alert('No se pudo descartar', e instanceof Error ? e.message : undefined);
          }
        },
      },
    ]);
  }

  const toggle = (index: number) =>
    setSkip((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const header = (
    <View>
      <LargeTitle
        title={j.name ?? 'Apple Music'}
        back
        right={
          !isImportBusy(j.status) && (
            <Pressable onPress={discard} hitSlop={12} className="active:opacity-50" accessibilityLabel="Descartar importación">
              <Ionicons name="trash-outline" size={22} color={accent} />
            </Pressable>
          )
        }
      />
      <View className="flex-row items-center px-5 mb-3">
        <View className="w-20 h-20 rounded-xl bg-card overflow-hidden items-center justify-center">
          <Ionicons name="musical-notes" size={28} color={muted} />
          {j.artwork && <StyledImage source={{ uri: j.artwork }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
        </View>
        <View className="flex-1 ml-4 gap-1">
          {j.curator && <Text className="text-muted text-sm" numberOfLines={1}>{j.curator}</Text>}
          <Text className={`text-sm font-semibold ${j.status === 'error' ? 'text-accent' : 'text-foreground'}`}>
            {j.status === 'error' ? j.error : IMPORT_STATUS[j.status]}
          </Text>
          {tracks.length > 0 && <Summary job={j} />}
        </View>
      </View>
      {isImportBusy(j.status) && <ProgressBar progress={j.progress} />}
      {j.warning && <Text className="text-muted text-sm px-5 mb-3">{j.warning}</Text>}

      {j.status === 'review' && (
        <View className="px-5 mb-3 gap-3">
          {/* Destino: una playlist nueva (con nombre) o añadir a una existente. */}
          <View className="flex-row rounded-lg bg-card p-0.5">
            {(['new', 'append'] as const).map((mode) => (
              <Pressable
                key={mode}
                onPress={() => (mode === 'new' ? setAppendTo(null) : chooseTarget())}
                className={`flex-1 items-center rounded-md py-1.5 ${(mode === 'append') === !!appendTo ? 'bg-background' : ''}`}
              >
                <Text className={`text-sm font-semibold ${(mode === 'append') === !!appendTo ? 'text-foreground' : 'text-muted'}`}>
                  {mode === 'new' ? 'Nueva playlist' : 'Añadir a existente'}
                </Text>
              </Pressable>
            ))}
          </View>
          {appendTo ? (
            <Pressable onPress={chooseTarget} className="flex-row items-center bg-card rounded-xl px-3 py-2 active:opacity-60">
              <PlaylistArt playlist={appendTo} size={40} className="w-10 h-10 rounded-md" />
              <View className="flex-1 ml-3">
                <Marquee className="text-foreground text-base">{appendTo.name}</Marquee>
                <Text className="text-muted text-sm">Se añaden al final las que aún no tiene</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={muted} />
            </Pressable>
          ) : (
            <>
              <TextInput
                value={playlistName}
                onChangeText={setName}
                placeholder="Nombre de la playlist"
                placeholderTextColor={muted}
                className="bg-card text-foreground text-base rounded-xl px-4 py-3"
              />
              {existing && (
                <Text className="text-muted text-sm -mt-1">
                  Ya tienes una playlist «{existing.name}» ({songCount(existing.songCount)}): se actualizará con el orden de Apple Music en vez de crear otra.
                </Text>
              )}
            </>
          )}
          <Pressable
            onPress={start}
            disabled={starting || toAdd === 0}
            className={`rounded-xl py-3 items-center bg-accent ${!starting && toAdd > 0 ? 'active:opacity-80' : 'opacity-40'}`}
          >
            {starting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text className="text-accent-foreground text-base font-semibold">
                {[appendTo ? `Añadir a «${appendTo.name}»` : 'Crear playlist', toDownload > 0 ? `descargar ${songCount(toDownload)}` : null].filter(Boolean).join(' · ')}
              </Text>
            )}
          </Pressable>
          {j.counts.youtube > 0 && <Text className="text-muted text-sm">Toca una canción de YouTube para escucharla; desmarca las que no quieras descargar.</Text>}
        </View>
      )}

      {j.status === 'downloading' && (
        <Pressable onPress={cancelDownloads} hitSlop={8} className="self-center mb-3 active:opacity-50">
          <Text className="text-accent text-sm font-semibold">Cancelar las descargas pendientes</Text>
        </Pressable>
      )}

      {(j.status === 'done' || j.status === 'error') && retriable > 0 && (
        <Pressable
          onPress={retry}
          disabled={starting}
          className={`mx-5 mb-3 rounded-xl py-3 flex-row items-center justify-center gap-2 bg-card ${starting ? 'opacity-40' : 'active:opacity-60'}`}
        >
          {starting ? <ActivityIndicator color={accent} /> : <Ionicons name="refresh" size={18} color={accent} />}
          <Text className="text-accent text-base font-semibold">Reintentar {songCount(retriable)} que fallaron</Text>
        </Pressable>
      )}

      {j.status === 'done' && j.playlistId && (
        <Pressable
          onPress={() => router.push({ pathname: '/biblioteca/playlist/[id]', params: { id: j.playlistId! } })}
          className="mx-5 mb-3 rounded-xl py-3 flex-row items-center justify-center gap-2 bg-accent active:opacity-80"
        >
          <Ionicons name="list" size={18} color="#ffffff" />
          <Text className="text-accent-foreground text-base font-semibold">Abrir playlist</Text>
        </Pressable>
      )}
    </View>
  );

  return (
    <FlatList
      data={tracks}
      keyExtractor={(t) => String(t.index)}
      ListHeaderComponent={header}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => (
        <TrackRow track={item} reviewing={j.status === 'review'} skipped={skip.has(item.index)} onToggle={() => toggle(item.index)} />
      )}
    />
  );
}

function Summary({ job }: { job: ImportJob }) {
  const c = job.counts;
  const parts = [
    c.library + c.added > 0 && `${c.library + c.added} en tu biblioteca`,
    c.youtube > 0 && `${c.youtube} de YouTube`,
    c.notFound > 0 && `${c.notFound} no encontradas`,
    c.failed > 0 && `${c.failed} fallaron`,
  ].filter(Boolean);
  return <Text className="text-muted text-sm">{parts.join(' · ')}</Text>;
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <View className="mx-5 mb-4 h-1 rounded-full bg-separator overflow-hidden">
      <View style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} className="h-full bg-accent" />
    </View>
  );
}

function TrackRow({ track, reviewing, skipped, onToggle }: { track: ImportTrack; reviewing: boolean; skipped: boolean; onToggle: () => void }) {
  const session = useMaybeServerSession();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const mainPlaying = usePlayer((s) => s.playWhenReady);
  const youtube = track.match?.source === 'youtube' ? track.match : null;
  const preview = usePreview((s) => (youtube && s.id === youtube.videoId ? s.status : null));

  const detail =
    track.state === 'library' || track.state === 'added' ? `${track.artist} · En tu biblioteca`
    : track.state === 'youtube' && youtube ? `YouTube: ${[youtube.artist, formatDuration(youtube.durationSec ?? undefined)].filter(Boolean).join(' · ')}`
    : track.state === 'notFound' ? `${track.artist} · No se encontró`
    : track.state === 'skipped' ? `${track.artist} · Omitida`
    : track.state === 'downloading' && track.waitingUntil ? `En pausa: YouTube pidió esperar (hasta las ${clock(track.waitingUntil)})`
    : track.state === 'downloading' ? (track.progress ? `Descargando… ${Math.round(track.progress * 100)}%` : 'En cola…')
    : track.state === 'indexing' ? 'Agregando a la biblioteca…'
    : track.state === 'failed' ? (track.error ?? 'No se pudo descargar')
    : track.artist;

  const listen = () =>
    youtube &&
    togglePreview(youtube.videoId, youtubePreviewSource(session, youtube.videoId), mainPlaying, {
      title: track.title,
      subtitle: track.artist,
      thumbnail: track.artwork ?? undefined,
    });

  return (
    <Pressable onPress={listen} disabled={!youtube} className="flex-row items-center px-5 active:bg-card">
      <View className="w-12 h-12 rounded-md bg-card overflow-hidden items-center justify-center">
        <Ionicons name="musical-note" size={18} color={muted} />
        {track.artwork && <StyledImage source={{ uri: track.artwork }} contentFit="cover" cachePolicy="disk" className="absolute inset-0" />}
        {preview && (
          <View className="absolute inset-0 items-center justify-center bg-black/50">
            {preview === 'loading' ? <ActivityIndicator size="small" color="white" /> : preview === 'playing' ? <Ionicons name="stop" size={18} color="white" /> : preview === 'paused' ? <Ionicons name="play" size={18} color="white" /> : null}
          </View>
        )}
      </View>
      <View className="flex-1 flex-row items-center ml-3 py-2.5 border-b border-separator">
        <View className="flex-1">
          <ListMarquee always={!!preview && preview !== 'error'} className={`text-base ${preview && preview !== 'error' ? 'text-accent' : skipped || track.state === 'notFound' ? 'text-muted' : 'text-foreground'}`}>
            {track.title}
          </ListMarquee>
          <Text className={`text-sm ${track.state === 'failed' ? 'text-accent' : 'text-muted'}`} numberOfLines={1}>{detail}</Text>
        </View>
        <View className="w-9 items-end">
          {reviewing && track.state === 'youtube' ? (
            <Pressable onPress={onToggle} hitSlop={10} accessibilityRole="checkbox" accessibilityState={{ checked: !skipped }}>
              <Ionicons name={skipped ? 'square-outline' : 'checkbox'} size={24} color={skipped ? muted : accent} />
            </Pressable>
          ) : track.state === 'library' || track.state === 'added' ? (
            <Ionicons name="checkmark-circle" size={22} color={GREEN} />
          ) : track.state === 'downloading' || track.state === 'indexing' || track.state === 'pending' ? (
            <ActivityIndicator size="small" color={accent} />
          ) : track.state === 'failed' || track.state === 'notFound' ? (
            <Ionicons name="close-circle-outline" size={22} color={muted} />
          ) : track.state === 'youtube' ? (
            <Ionicons name="logo-youtube" size={20} color={muted} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
