import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { FlatList, Pressable, Text } from 'react-native';
import { usePlaylists } from '@/api/queries';
import { invalidatePlaylists } from '@/api/queryClient';
import { useSource } from '@/sources';
import { LargeTitle } from '@/components/LargeTitle';
import { PlaylistRow } from '@/components/rows';
import { closeSheet, showSheet } from '@/components/sheets/store';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { useThemeColor } from '@/components/theme';

export default function PlaylistsScreen() {
  const source = useSource();
  const playlists = usePlaylists();
  const accent = useThemeColor('accent');

  const create = () =>
    showSheet({
      kind: 'prompt',
      title: 'Nueva playlist',
      placeholder: 'Nombre',
      confirmLabel: 'Crear',
      onSubmit: async (name) => {
        const created = await source.createPlaylist(name);
        await invalidatePlaylists(source);
        closeSheet();
        router.push({ pathname: '/biblioteca/playlist/[id]', params: { id: created.id } });
      },
    });

  return (
    <FlatList
      data={playlists.data ?? []}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={
        <LargeTitle
          title="Playlists"
          back
          right={
            <Pressable onPress={create} hitSlop={12} className="flex-row items-center gap-1 active:opacity-50">
              <Ionicons name="add" size={24} color={accent} />
              <Text className="text-accent text-base">Nueva</Text>
            </Pressable>
          }
        />
      }
      ListEmptyComponent={
        playlists.isPending ? <Loading /> : playlists.isError ? <ErrorState error={playlists.error} onRetry={playlists.refetch} /> : (
          <EmptyState icon="list" title="Aún no tienes playlists" subtitle="Crea una con «Nueva» o desde el menú … de cualquier canción." />
        )
      }
      refreshing={playlists.isRefetching}
      onRefresh={playlists.refetch}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => (
        <PlaylistRow playlist={item} onPress={() => router.push({ pathname: '/biblioteca/playlist/[id]', params: { id: item.id } })} />
      )}
    />
  );
}
