import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useSource } from '@/sources';
import { LargeTitle } from '@/components/LargeTitle';
import { PlayButtons } from '@/components/PlayButtons';
import { SongRow } from '@/components/rows';
import { matchesQuery, SearchField } from '@/components/SearchField';
import { openSongActions } from '@/components/sheets/songActions';
import { EmptyState } from '@/components/states';
import { songCount } from '@/components/theme';
import { cancelDownloads, formatBytes, offlineSongs, totalBytes, useOffline } from '@/offline/store';
import { playSongs } from '@/player/store';
import { DEVICE } from '@/components/device';
import { Marquee } from '@/components/Marquee';

/** Canciones guardadas en el teléfono: funcionan sin conexión (avión, túneles, sin Tailscale). */
export default function DescargadasScreen() {
  const source = useSource();
  const index = useOffline((s) => s.index);
  const pending = useOffline((s) => s.pending);
  const active = useOffline((s) => s.active);
  const failed = useOffline((s) => Object.keys(s.errors).length);
  const songs = useMemo(() => offlineSongs(index), [index]);
  const bytes = totalBytes(index);
  const [query, setQuery] = useState('');
  // La búsqueda solo cambia lo que se ve: "Reproducir" y tocar una canción usan todas las descargas.
  const shown = useMemo(() => songs.filter((s) => matchesQuery(query, s.title, s.artist, s.album)), [songs, query]);
  const activeSong = active ? pending.find((p) => p.id === active.id) : undefined;

  const header = (
    <View>
      <LargeTitle title="Descargadas" back />
      <Text className="text-muted text-sm px-5 -mt-1 mb-3">
        {songCount(songs.length)} · {formatBytes(bytes)} en el {DEVICE}
      </Text>

      {activeSong && active && (
        <View className="mx-5 mb-4 rounded-xl bg-card p-4">
          <View className="flex-row items-center justify-between">
            <Text className="text-foreground text-sm font-semibold">
              Descargando {pending.length > 1 ? `(${pending.length} en cola)` : ''}
            </Text>
            <Pressable onPress={() => cancelDownloads()} hitSlop={10} className="active:opacity-50" accessibilityLabel="Cancelar descargas">
              <Text className="text-accent text-sm font-semibold">Cancelar</Text>
            </Pressable>
          </View>
          <Marquee className="text-muted text-sm" containerClassName="mt-0.5">{activeSong.title}</Marquee>
          <View className="h-1.5 mt-2.5 rounded-full bg-separator overflow-hidden">
            <View style={{ width: `${active.progress * 100}%` }} className="h-full bg-accent" />
          </View>
        </View>
      )}
      {failed > 0 && !activeSong && (
        <Text className="text-accent text-sm px-5 mb-3">
          {failed} descarga(s) fallaron. Vuelve a intentarlo desde el menú … de la canción.
        </Text>
      )}

      {songs.length > 0 && (
        <>
          <PlayButtons songs={songs} />
          <View className="pb-3">
            <SearchField value={query} onChangeText={setQuery} placeholder="Buscar en tus descargas" />
          </View>
        </>
      )}
    </View>
  );

  return (
    <FlatList
      data={shown}
      keyExtractor={(s) => s.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      ListHeaderComponent={header}
      ListEmptyComponent={
        songs.length > 0 ? (
          <EmptyState icon="search" title={`Sin resultados para “${query.trim()}”`} />
        ) : activeSong ? null : (
          <EmptyState
            icon="arrow-down-circle-outline"
            title="Aún no hay descargas"
            subtitle="Usa «Descargar» en el menú … de una canción, o el botón de descarga de un álbum o playlist."
          />
        )
      }
      contentContainerStyle={{ paddingBottom: 32 }}
      renderItem={({ item }) => (
        <SongRow song={item} onPress={() => playSongs(songs, Math.max(0, songs.indexOf(item)))} onMore={() => openSongActions(source, item)} />
      )}
    />
  );
}
