import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { useAllAlbums } from '@/api/queries';
import { useGridColumns } from '@/components/desktop/layout';
import { LargeTitle } from '@/components/LargeTitle';
import { AlbumTile } from '@/components/rows';
import { matchesQuery, SearchField } from '@/components/SearchField';
import { EmptyState, ErrorState, Loading } from '@/components/states';

export default function AlbumesScreen() {
  const albums = useAllAlbums();
  const grid = useGridColumns();
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const pages = albums.data?.pages;
  const data = useMemo(() => pages?.flat() ?? [], [pages]);
  const shown = useMemo(() => data.filter((a) => matchesQuery(query, a.name, a.artist)), [data, query]);

  // Los álbumes llegan por páginas al desplazar; para buscar en todos se piden las que faltan.
  useEffect(() => {
    if (searching && albums.hasNextPage && !albums.isFetchingNextPage && !albums.isError) albums.fetchNextPage();
  }, [searching, albums]);

  return (
    <FlatList
      key={`cols-${grid.columns}`}
      data={shown}
      keyExtractor={(a) => a.id}
      numColumns={grid.columns}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={
        <View>
          <LargeTitle title="Álbumes" back />
          {data.length > 0 && <SearchField value={query} onChangeText={setQuery} placeholder="Buscar álbumes o artistas" />}
        </View>
      }
      ListEmptyComponent={
        albums.isPending ? <Loading /> : albums.isError ? <ErrorState error={albums.error} onRetry={albums.refetch} /> : searching ? (
          albums.hasNextPage ? null : <EmptyState icon="search" title={`Sin resultados para “${query.trim()}”`} />
        ) : (
          <EmptyState icon="disc" title="Sin álbumes" />
        )
      }
      ListFooterComponent={albums.isFetchingNextPage ? <Loading /> : null}
      onEndReached={() => !searching && albums.hasNextPage && !albums.isFetchingNextPage && albums.fetchNextPage()}
      onEndReachedThreshold={0.5}
      refreshing={albums.isRefetching && !albums.isFetchingNextPage}
      onRefresh={albums.refetch}
      columnWrapperStyle={{ gap: grid.gap, paddingHorizontal: grid.padding }}
      contentContainerStyle={{ gap: 20, paddingBottom: 32 }}
      renderItem={({ item }) => (
        <AlbumTile
          album={item}
          width={grid.columns > 2 ? grid.tileWidth : undefined}
          onPress={() => router.push({ pathname: '/biblioteca/album/[id]', params: { id: item.id } })}
        />
      )}
    />
  );
}
