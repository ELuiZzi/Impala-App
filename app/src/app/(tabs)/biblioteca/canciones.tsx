import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useAllSongs } from '@/api/queries';
import { LargeTitle } from '@/components/LargeTitle';
import { PlayButtons } from '@/components/PlayButtons';
import { SongRow } from '@/components/rows';
import { openSortSheet, SongFilterBar, useSongFilter } from '@/components/SongFilter';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { useThemeColor } from '@/components/theme';
import { useSource } from '@/sources';
import { openSongActions } from '@/components/sheets/songActions';
import { playSongs } from '@/player/store';

export default function CancionesScreen() {
  const source = useSource();
  const songs = useAllSongs();
  const accent = useThemeColor('accent');
  const data = songs.data?.pages.flat() ?? [];
  const filter = useSongFilter(data, { key: 'canciones', sorts: ['title', 'artist', 'album', 'recent', 'duration'], initial: 'title' });
  const shown = filter.queue; // todas, en el orden elegido, aunque se esté buscando

  // Buscar, ordenar y "Reproducir todo" necesitan la biblioteca completa: se piden todas las páginas.
  useEffect(() => {
    if (songs.hasNextPage && !songs.isFetchingNextPage && !songs.isError) songs.fetchNextPage();
  }, [songs]);
  const complete = !songs.hasNextPage && !songs.isPending;

  return (
    <FlatList
      data={filter.items}
      keyExtractor={(item) => item.song.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <View>
          <LargeTitle
            title="Canciones"
            back
            right={
              data.length > 1 ? (
                <Pressable onPress={() => openSortSheet(filter)} hitSlop={12} className="active:opacity-50" accessibilityLabel="Ordenar">
                  <Ionicons name="ellipsis-horizontal-circle" size={28} color={accent} />
                </Pressable>
              ) : undefined
            }
          />
          {data.length > 0 && (
            <>
              {/* Mientras faltan páginas, reproducir todo dejaría fuera canciones. */}
              <View className={complete ? '' : 'opacity-40'} pointerEvents={complete ? 'auto' : 'none'}>
                <PlayButtons songs={shown} />
              </View>
              <SongFilterBar filter={filter} placeholder="Buscar en tus canciones" />
            </>
          )}
        </View>
      }
      ListEmptyComponent={
        songs.isPending ? <Loading /> : songs.isError ? <ErrorState error={songs.error} onRetry={songs.refetch} /> : data.length > 0 ? (
          <EmptyState icon="search" title={`Sin resultados para “${filter.query.trim()}”`} />
        ) : (
          <EmptyState icon="musical-note" title="Sin canciones" />
        )
      }
      ListFooterComponent={songs.isFetchingNextPage ? <Loading /> : null}
      refreshing={songs.isRefetching && !songs.isFetchingNextPage}
      onRefresh={songs.refetch}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => <SongRow song={item.song} onPress={() => playSongs(shown, filter.queueIndex(item))} onMore={() => openSongActions(source, item.song)} />}
    />
  );
}
