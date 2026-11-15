import { router, useLocalSearchParams } from 'expo-router';
import { FlatList, Text, View } from 'react-native';
import { useAlbum } from '@/api/queries';
import { useSource } from '@/sources';
import { CollectionHeader } from '@/components/CollectionHeader';
import { DownloadButton } from '@/components/DownloadButton';
import { PlayButtons } from '@/components/PlayButtons';
import { SongRow } from '@/components/rows';
import { openSongActions } from '@/components/sheets/songActions';
import { ErrorState, Loading } from '@/components/states';
import { albumName, artistName, formatTotalDuration, songCount } from '@/components/theme';
import { playSongs } from '@/player/store';

export default function AlbumScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const source = useSource();
  const album = useAlbum(id);
  const a = album.data;

  if (!a) {
    return album.isError ? <ErrorState error={album.error} onRetry={album.refetch} /> : <Loading />;
  }

  const songs = a.song ?? [];
  const meta = [a.year].filter(Boolean).join(' · ');
  const footer = [a.songCount && songCount(a.songCount), formatTotalDuration(a.duration)].filter(Boolean).join(', ');

  return (
    <FlatList
      data={songs}
      keyExtractor={(s) => s.id}
      ListHeaderComponent={
        <View>
          <CollectionHeader
            coverArt={a.coverArt}
            title={albumName(a.name) ?? 'Sin álbum'}
            subtitle={artistName(a.artist)}
            meta={meta}
            right={source.capabilities.offlineDownloads ? <DownloadButton songs={songs} /> : undefined}
            onSubtitlePress={a.artistId ? () => router.push({ pathname: '/biblioteca/artista/[id]', params: { id: a.artistId! } }) : undefined}
          />
          <PlayButtons songs={songs} />
        </View>
      }
      ListFooterComponent={<Text className="text-muted text-sm px-5 pt-4 pb-10">{footer}</Text>}
      renderItem={({ item, index }) => (
        <SongRow song={item} showArtwork={false} onPress={() => playSongs(songs, index)} onMore={() => openSongActions(source, item)} />
      )}
    />
  );
}
