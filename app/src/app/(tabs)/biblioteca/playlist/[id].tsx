import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ReorderableList, { reorderItems, useReorderableDrag } from 'react-native-reorderable-list';
import { usePlaylist } from '@/api/queries';
import { invalidatePlaylists } from '@/api/queryClient';
import { useSource, type PlaylistWithSongs, type Song } from '@/sources';
import { Artwork } from '@/components/Artwork';
import { CollectionHeader } from '@/components/CollectionHeader';
import { PlayButtons } from '@/components/PlayButtons';
import { PlaylistArt, SongRow } from '@/components/rows';
import { openSortSheet, PLAYLIST_SORTS, SongFilterBar, useSongFilter } from '@/components/SongFilter';
import { openSongActions } from '@/components/sheets/songActions';
import { closeSheet, showSheet, type SheetOption } from '@/components/sheets/store';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { artistName, formatTotalDuration, songCount, useThemeColor } from '@/components/theme';
import { showToast } from '@/components/Toast';
import { getCoverStyle, setCoverStyle } from '@/library/coverStyles';
import { isFavoritesPlaylist } from '@/library/favorites';
import { FAVORITES_PIN, pin, unpin, usePins } from '@/library/pins';
import { downloadSongs } from '@/offline/store';
import { getGymRamp, getGymSettings, startGymRamp, stopGymRamp } from '@/player/gym';
import { isPlaying, playSongs } from '@/player/store';
import { ListMarquee, Marquee } from '@/components/Marquee';

type EditEntry = Song & { key: string };

export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlist = usePlaylist(id);
  const [editing, setEditing] = useState<EditEntry[] | null>(null);
  const p = playlist.data;

  if (!p) {
    return playlist.isError ? <ErrorState error={playlist.error} onRetry={playlist.refetch} /> : <Loading />;
  }

  return editing ? (
    <EditMode playlist={p} initial={editing} onDone={() => setEditing(null)} />
  ) : (
    <ViewMode playlist={p} onEdit={() => setEditing((p.entry ?? []).map((s, i) => ({ ...s, key: `${s.id}-${i}` })))} />
  );
}

function ViewMode({ playlist: p, onEdit }: { playlist: PlaylistWithSongs; onEdit: () => void }) {
  const source = useSource();
  const accent = useThemeColor('accent');
  const songs = p.entry ?? [];
  const footer = [songCount(p.songCount), formatTotalDuration(p.duration)].filter(Boolean).join(', ');
  // "Canciones Favoritas" refleja las estrellas: su contenido y nombre los gestiona la app.
  const favorites = isFavoritesPlaylist(p, source);
  const pinKey = favorites ? FAVORITES_PIN : p.id;
  const pinned = usePins().includes(pinKey);
  const filter = useSongFilter(songs, { key: `playlist:${p.id}`, sorts: PLAYLIST_SORTS, initial: 'original' });
  const shown = filter.items.map((i) => i.song);

  const gym = getGymRamp();
  const openMenu = () =>
    showSheet({
      kind: 'actions',
      title: p.name,
      subtitle: songCount(p.songCount),
      coverArt: p.coverArt,
      options: [
        ...(songs.length > 1 ? [{ label: 'Ordenar…', icon: 'swap-vertical' as const, onPress: () => openSortSheet(filter) }] : []),
        gym.active
          ? { label: `Detener volumen gradual (${gym.currentPercent} % → ${gym.targetPercent} %)`, icon: 'barbell', onPress: () => (closeSheet(), stopGymRamp()) }
          : { label: 'Volumen gradual (gym)', icon: 'barbell-outline', onPress: () => (closeSheet(), startGym()) },
        pinned
          ? { label: 'Dejar de fijar en Biblioteca', icon: 'pin-outline', onPress: () => (closeSheet(), unpin(pinKey)) }
          : { label: 'Fijar en Biblioteca', icon: 'pin', onPress: () => (closeSheet(), pin(pinKey)) },
        ...(source.capabilities.offlineDownloads
          ? [{ label: 'Descargar playlist', icon: 'arrow-down-circle-outline' as const, onPress: () => (closeSheet(), downloadSongs(source, songs)) }]
          : []),
        ...(favorites ? [] : managedOptions()),
      ],
    });

  /** Activa la subida de volumen; si no suena nada, empieza también esta playlist. */
  async function startGym() {
    if (!isPlaying() && shown.length > 0) await playSongs(shown, 0);
    await startGymRamp();
    const { maxPercent, minutes } = getGymSettings();
    showToast(`Volumen gradual: subirá hasta ${maxPercent} % en ${minutes} min de música`, 'barbell');
  }

  function managedOptions(): SheetOption[] {
    return [
      {
        label: 'Estilo de la portada…',
        icon: 'color-palette-outline',
        onPress: () => showSheet({ kind: 'coverStyle', name: p.name, current: getCoverStyle(p.id), onSelect: (style) => setCoverStyle(p.id, style) }),
      },
      { label: 'Editar orden y canciones', icon: 'reorder-three', onPress: () => (closeSheet(), onEdit()) },
      {
        label: 'Renombrar',
        icon: 'pencil',
        onPress: () =>
          showSheet({
            kind: 'prompt',
            title: 'Renombrar playlist',
            initialValue: p.name,
            confirmLabel: 'Guardar',
            onSubmit: async (name) => {
              await source.renamePlaylist(p.id, name);
              await invalidatePlaylists(source);
              closeSheet();
            },
          }),
      },
      {
        label: 'Eliminar playlist',
        icon: 'trash-outline',
        destructive: true,
        onPress: () => {
          closeSheet();
          Alert.alert('Eliminar playlist', `¿Eliminar «${p.name}»? Las canciones seguirán en tu biblioteca.`, [
            { text: 'Cancelar', style: 'cancel' },
            {
              text: 'Eliminar',
              style: 'destructive',
              onPress: async () => {
                await source.deletePlaylist(p.id);
                await invalidatePlaylists(source);
                router.back();
              },
            },
          ]);
        },
      },
    ];
  }

  return (
    <FlatList
      data={filter.items}
      keyExtractor={(item) => `${item.song.id}-${item.index}`} // una playlist puede repetir canciones
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <View>
          <CollectionHeader
            art={<PlaylistArt playlist={p} size={256} className="w-64 h-64 rounded-2xl" />}
            title={p.name}
            subtitle={p.comment}
            meta={p.owner}
            right={
              <Pressable onPress={openMenu} hitSlop={12} className="active:opacity-50">
                <Ionicons name="ellipsis-horizontal-circle" size={28} color={accent} />
              </Pressable>
            }
          />
          <PlayButtons songs={shown} />
          {songs.length > 0 && <SongFilterBar filter={filter} />}
        </View>
      }
      ListEmptyComponent={
        songs.length > 0 ? (
          <EmptyState icon="search" title={`Sin resultados para “${filter.query.trim()}”`} />
        ) : (
          <EmptyState icon="musical-notes" title="Playlist vacía" subtitle="Añade canciones desde el menú … de cualquier canción." />
        )
      }
      ListFooterComponent={<Text className="text-muted text-sm px-5 pt-4 pb-10">{footer}</Text>}
      renderItem={({ item, index }) => (
        <SongRow
          song={item.song}
          onPress={() => playSongs(shown, index)}
          onMore={() => openSongActions(source, item.song, { playlist: { id: p.id, index: item.index, favorites } })}
        />
      )}
    />
  );
}

/** Reordenar arrastrando y quitar canciones; se guarda todo junto al pulsar "Listo". */
function EditMode({ playlist: p, initial, onDone }: { playlist: PlaylistWithSongs; initial: EditEntry[]; onDone: () => void }) {
  const source = useSource();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState(initial);
  const [saving, setSaving] = useState(false);
  const accent = useThemeColor('accent');

  async function save() {
    setSaving(true);
    try {
      await source.setPlaylistSongs(p.id, entries.map((e) => e.id));
      await invalidatePlaylists(source);
      onDone();
    } catch (e) {
      Alert.alert('No se pudo guardar', e instanceof Error ? e.message : 'Error desconocido');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View className="flex-1">
      <View style={{ paddingTop: insets.top + 8 }} className="px-5 pb-3 border-b border-separator">
        <View className="h-10 flex-row items-center justify-between">
          <Pressable onPress={onDone} disabled={saving} hitSlop={12} className="active:opacity-50">
            <Text className="text-accent text-base">Cancelar</Text>
          </Pressable>
          <Pressable onPress={save} disabled={saving} hitSlop={12} className="active:opacity-50">
            {saving ? <ActivityIndicator color={accent} /> : <Text className="text-accent text-base font-semibold">Listo</Text>}
          </Pressable>
        </View>
        <Marquee className="text-foreground text-[22px] font-bold">{p.name}</Marquee>
        <Text className="text-muted text-sm">Mantén ≡ y arrastra para reordenar</Text>
      </View>
      <ReorderableList
        data={entries}
        keyExtractor={(e) => e.key}
        onReorder={({ from, to }) => setEntries((list) => reorderItems(list, from, to))}
        contentContainerStyle={{ paddingBottom: 32 }}
        renderItem={({ item }) => <EditRow entry={item} onRemove={() => setEntries((list) => list.filter((e) => e.key !== item.key))} />}
      />
    </View>
  );
}

function EditRow({ entry, onRemove }: { entry: EditEntry; onRemove: () => void }) {
  const drag = useReorderableDrag();
  const muted = useThemeColor('muted');
  return (
    <View className="flex-row items-center pl-3 pr-2 bg-background">
      <Pressable onPress={onRemove} hitSlop={8} className="p-1.5 active:opacity-50">
        <Ionicons name="remove-circle" size={24} color="#ff3b30" />
      </Pressable>
      <Artwork coverArt={entry.coverArt} size={44} className="w-11 h-11 rounded-md ml-1" />
      <View className="flex-1 ml-3 py-2.5 border-b border-separator">
        <ListMarquee className="text-foreground text-base">{entry.title}</ListMarquee>
        <ListMarquee className="text-muted text-sm">{artistName(entry.artist)}</ListMarquee>
      </View>
      <Pressable onPressIn={drag} hitSlop={8} className="p-2">
        <Ionicons name="reorder-three" size={26} color={muted} />
      </Pressable>
    </View>
  );
}
