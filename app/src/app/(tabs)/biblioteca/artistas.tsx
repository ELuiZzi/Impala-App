import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useArtists } from '@/api/queries';
import { LargeTitle } from '@/components/LargeTitle';
import { ArtistRow } from '@/components/rows';
import { matchesQuery, SearchField } from '@/components/SearchField';
import { EmptyState, ErrorState, Loading } from '@/components/states';

export default function ArtistasScreen() {
  const artists = useArtists();
  const [query, setQuery] = useState('');
  const all = artists.data;
  const shown = useMemo(() => (all ?? []).filter((a) => matchesQuery(query, a.name)), [all, query]);

  return (
    <FlatList
      data={shown}
      keyExtractor={(a) => a.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <View>
          <LargeTitle title="Artistas" back />
          {!!all?.length && (
            <View className="pb-3">
              <SearchField value={query} onChangeText={setQuery} placeholder="Buscar artistas" />
            </View>
          )}
        </View>
      }
      ListEmptyComponent={
        artists.isPending ? <Loading /> : artists.isError ? <ErrorState error={artists.error} onRetry={artists.refetch} /> : all?.length ? (
          <EmptyState icon="search" title={`Sin resultados para “${query.trim()}”`} />
        ) : (
          <EmptyState icon="mic" title="Sin artistas" />
        )
      }
      refreshing={artists.isRefetching}
      onRefresh={artists.refetch}
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => (
        <ArtistRow artist={item} onPress={() => router.push({ pathname: '/biblioteca/artista/[id]', params: { id: item.id } })} />
      )}
    />
  );
}
