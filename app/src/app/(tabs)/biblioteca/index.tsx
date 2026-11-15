import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useAlbumList } from '@/api/queries';
import { useGridColumns } from '@/components/desktop/layout';
import { LargeTitle } from '@/components/LargeTitle';
import { APP_MENU, OverflowMenu } from '@/components/OverflowMenu';
import { PinnedPlaylists } from '@/components/PinnedPlaylists';
import { AlbumTile, NavRow } from '@/components/rows';
import { EmptyState, ErrorState, Loading } from '@/components/states';
import { songCount, useThemeColor } from '@/components/theme';
import { useOffline } from '@/offline/store';
import { useSource } from '@/sources';
import { DEVICE } from '@/components/device';

export default function BibliotecaScreen() {
  const { capabilities, kind } = useSource();
  const recent = useAlbumList('newest', 20);
  const accent = useThemeColor('accent');
  const downloaded = useOffline((s) => Object.keys(s.index.songs).length);
  const grid = useGridColumns();

  const header = (
    <View>
      <LargeTitle
        title="Biblioteca"
        right={
          <View className="flex-row items-center gap-5">
            {(capabilities.upload || capabilities.appleMusicImport) && (
              <Pressable onPress={() => router.push('/biblioteca/importar')} hitSlop={12} className="flex-row items-center gap-1 active:opacity-50">
                <Ionicons name="cloud-upload-outline" size={22} color={accent} />
                <Text className="text-accent text-base">Importar</Text>
              </Pressable>
            )}
            <OverflowMenu items={APP_MENU} />
          </View>
        }
      />
      <PinnedPlaylists />
      {/* En el PC estos apartados ya están en la barra lateral. */}
      <View className={`mt-2 ${grid.columns > 2 ? 'hidden' : ''}`}>
        <NavRow icon="list" label="Playlists" onPress={() => router.push('/biblioteca/playlists')} />
        <NavRow icon="mic" label="Artistas" onPress={() => router.push('/biblioteca/artistas')} />
        <NavRow icon="disc" label="Álbumes" onPress={() => router.push('/biblioteca/albumes')} />
        <NavRow icon="musical-note" label="Canciones" onPress={() => router.push('/biblioteca/canciones')} />
        {/* Con la música del teléfono todo está ya en él: no hay nada que descargar. */}
        {capabilities.offlineDownloads && (
          <NavRow icon="arrow-down-circle" label="Descargadas" onPress={() => router.push('/biblioteca/descargadas')} />
        )}
      </View>
      {recent.isError && capabilities.offlineDownloads && downloaded > 0 && (
        <Pressable
          onPress={() => router.push('/biblioteca/descargadas')}
          className="mx-5 mt-6 flex-row items-center rounded-xl bg-card px-4 py-3 active:opacity-60"
        >
          <Ionicons name="cloud-offline-outline" size={22} color={accent} />
          <View className="flex-1 ml-3">
            <Text className="text-foreground text-base font-semibold">Sin conexión con el servidor</Text>
            <Text className="text-muted text-sm">Tus {songCount(downloaded)} descargadas siguen disponibles</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={accent} />
        </Pressable>
      )}
      <Text className="text-foreground text-[22px] font-bold px-5 mt-8 mb-3">Agregado recientemente</Text>
      {recent.isPending && <Loading />}
      {recent.isError && <ErrorState error={recent.error} onRetry={recent.refetch} />}
      {recent.data?.length === 0 && (
        <EmptyState
          icon={kind === 'local' ? 'folder-open-outline' : 'cloud-upload-outline'}
          title="Tu biblioteca está vacía"
          subtitle={
            kind === 'local'
              ? `Copia música a la carpeta Music/Impala del ${DEVICE} (o elige otra en Ajustes) para verla aquí.`
              : 'Sube música al servidor para verla aquí.'
          }
        />
      )}
    </View>
  );

  return (
    <FlatList
      // Cambiar el número de columnas exige montar la lista de nuevo.
      key={`cols-${grid.columns}`}
      data={recent.data ?? []}
      keyExtractor={(a) => a.id}
      numColumns={grid.columns}
      ListHeaderComponent={header}
      columnWrapperStyle={{ gap: grid.gap, paddingHorizontal: grid.padding }}
      contentContainerStyle={{ gap: 20, paddingBottom: 32 }}
      refreshing={recent.isRefetching}
      onRefresh={recent.refetch}
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
