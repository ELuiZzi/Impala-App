import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';
import { isFavoritesPlaylist, useIsFavorite } from '@/library/favorites';
import { downloadStatusOf, useOffline } from '@/offline/store';
import { currentSong, usePlayer } from '@/player/store';
import { useSource, type Album, type Artist, type Playlist, type Song } from '@/sources';
import { Artwork } from './Artwork';
import { contextMenu } from './desktop/contextMenu';
import { ListMarquee } from './Marquee';
import { PlaylistCover } from './PlaylistCover';
import { albumName, artistName, formatDuration, songCount, useThemeColor } from './theme';

type IconName = keyof typeof Ionicons.glyphMap;

/** Fila de navegación de la Biblioteca: "Playlists ›", "Artistas ›"… */
export function NavRow({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  return (
    <Pressable onPress={onPress} className="flex-row items-center px-5 active:bg-card">
      <Ionicons name={icon} size={24} color={accent} />
      <View className="flex-1 flex-row items-center ml-4 py-3.5 border-b border-separator">
        <Text className="flex-1 text-foreground text-xl">{label}</Text>
        <Ionicons name="chevron-forward" size={18} color={muted} />
      </View>
    </Pressable>
  );
}

type SongRowProps = {
  song: Song;
  showArtwork?: boolean;
  onPress?: () => void;
  /** Abre el menú de acciones (botón "…" y pulsación larga). */
  onMore?: () => void;
};

export function SongRow({ song, showArtwork = true, onPress, onMore }: SongRowProps) {
  const subtitle = [artistName(song.artist), showArtwork ? albumName(song.album) : null].filter(Boolean).join(' · ');
  const isCurrent = usePlayer((s) => currentSong(s)?.id === song.id);
  const download = useOffline((s) => downloadStatusOf(s, song.id));
  const favorite = useIsFavorite(song.id);
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  return (
    <Pressable onPress={onPress} onLongPress={onMore} {...contextMenu(onMore)} className="flex-row items-center px-5 active:bg-card">
      {showArtwork ? (
        <Artwork coverArt={song.coverArt} size={48} className="w-12 h-12 rounded-md" />
      ) : (
        <View className="w-7 items-center">
          {isCurrent ? (
            <Ionicons name="volume-high" size={16} color={accent} />
          ) : (
            <Text className="text-muted text-base">{song.track ?? ''}</Text>
          )}
        </View>
      )}
      <View className="flex-1 flex-row items-center ml-3 py-2.5 border-b border-separator">
        <View className="flex-1">
          <ListMarquee always={isCurrent} className={`text-base ${isCurrent ? 'text-accent' : 'text-foreground'}`}>{song.title}</ListMarquee>
          <View className="flex-row items-center">
            {favorite && <Ionicons name="star" size={12} color={accent} style={{ marginRight: 4 }} />}
            {download === 'downloaded' && <Ionicons name="arrow-down-circle" size={13} color={muted} style={{ marginRight: 4 }} />}
            {(download === 'downloading' || download === 'queued') && (
              <Ionicons name="cloud-download-outline" size={13} color={accent} style={{ marginRight: 4 }} />
            )}
            {subtitle ? <ListMarquee always={isCurrent} className="text-muted text-sm" containerClassName="flex-shrink">{subtitle}</ListMarquee> : null}
          </View>
        </View>
        <Text className="text-muted text-sm ml-3 shrink-0" numberOfLines={1}>{formatDuration(song.duration)}</Text>
        {onMore && (
          <Pressable onPress={onMore} hitSlop={10} className="ml-2 -mr-1 p-1 active:opacity-50">
            <Ionicons name="ellipsis-horizontal" size={18} color={muted} />
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

export function ArtistRow({ artist, onPress }: { artist: Artist; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center px-5 active:bg-card">
      <Artwork coverArt={artist.coverArt} size={48} icon="person" className="w-12 h-12 rounded-full" />
      <View className="flex-1 ml-3 py-4 border-b border-separator">
        <ListMarquee className="text-foreground text-base">{artistName(artist.name)}</ListMarquee>
      </View>
    </Pressable>
  );
}

/** Carátula de una playlist: degradado con su nombre; "Canciones Favoritas" lleva siempre la estrella. */
export function PlaylistArt({ playlist, size, className = '' }: { playlist: Playlist; size: number; className?: string }) {
  const source = useSource();
  if (isFavoritesPlaylist(playlist, source)) {
    return (
      <View className={`bg-accent items-center justify-center ${className}`}>
        <Ionicons name="star" size={Math.max(18, size * 0.42)} color="white" />
      </View>
    );
  }
  return <PlaylistCover name={playlist.name} playlistId={playlist.id} size={size} className={className} />;
}

export function PlaylistRow({ playlist, onPress }: { playlist: Playlist; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center px-5 active:bg-card">
      <PlaylistArt playlist={playlist} size={56} className="w-14 h-14 rounded-lg" />
      <View className="flex-1 ml-3 py-3 border-b border-separator">
        <ListMarquee className="text-foreground text-base">{playlist.name}</ListMarquee>
        <Text className="text-muted text-sm">{songCount(playlist.songCount)}</Text>
      </View>
    </Pressable>
  );
}

/** Tile cuadrado para cuadrículas de álbumes (2 columnas en el teléfono; con `width`, las del PC). */
export function AlbumTile({ album, onPress, width }: { album: Album; onPress: () => void; width?: number }) {
  return (
    <Pressable onPress={onPress} style={width ? { width } : undefined} className={`${width ? '' : 'flex-1'} active:opacity-70`}>
      <Artwork coverArt={album.coverArt} size={200} icon="disc" className="w-full aspect-square rounded-xl" />
      <ListMarquee rowHeight={230} className="text-foreground text-sm" containerClassName="mt-1.5">{albumName(album.name) ?? 'Sin álbum'}</ListMarquee>
      <ListMarquee rowHeight={230} className="text-muted text-sm">{artistName(album.artist)}</ListMarquee>
    </Pressable>
  );
}
