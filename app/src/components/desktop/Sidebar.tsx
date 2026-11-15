import Ionicons from '@expo/vector-icons/Ionicons';
import { router, usePathname, type Href, type Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { usePlaylists } from '@/api/queries';
import { PlaylistArt } from '@/components/rows';
import { useThemeColor } from '@/components/theme';
import { useSource } from '@/sources';
import { SIDEBAR_WIDTH } from './layout';
import { ListMarquee } from '@/components/Marquee';

type IconName = keyof typeof Ionicons.glyphMap;
/** Las props que expo-router pasa a una barra de pestañas propia (las de React Navigation). */
type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

/**
 * Barra lateral del PC (sustituye a las pestañas de abajo): Biblioteca y Buscar, los apartados de la
 * biblioteca, las playlists y Ajustes. Lo activo se resalta según la ruta.
 */
export function Sidebar({ state, navigation }: BottomTabBarProps) {
  const pathname = usePathname();
  const source = useSource();
  const playlists = usePlaylists();
  const tab = state.routes[state.index]?.name;

  const goTab = (name: string) => {
    // Volver a tocar la pestaña activa la deja en su pantalla principal.
    if (tab === name) router.dismissTo(name === 'buscar' ? '/buscar' : '/biblioteca');
    else navigation.navigate(name);
  };

  return (
    <View style={{ width: SIDEBAR_WIDTH }} className="h-full bg-card/60 border-r border-separator">
      <View className="flex-row items-center gap-2 px-5 pt-5 pb-4">
        <Ionicons name="musical-notes" size={24} color={useThemeColor('accent')} />
        <Text className="text-foreground text-xl font-bold">Impala</Text>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
        <Item icon="albums" label="Biblioteca" active={pathname === '/biblioteca'} onPress={() => goTab('biblioteca')} />
        <Item icon="search" label="Buscar" active={pathname.startsWith('/buscar')} onPress={() => goTab('buscar')} />

        <Section title="Tu música" />
        <Item icon="list" label="Playlists" active={pathname === '/biblioteca/playlists'} onPress={() => go('/biblioteca/playlists')} />
        <Item icon="mic" label="Artistas" active={pathname.startsWith('/biblioteca/artista')} onPress={() => go('/biblioteca/artistas')} />
        <Item icon="disc" label="Álbumes" active={pathname.startsWith('/biblioteca/album')} onPress={() => go('/biblioteca/albumes')} />
        <Item icon="musical-note" label="Canciones" active={pathname === '/biblioteca/canciones'} onPress={() => go('/biblioteca/canciones')} />
        {source.capabilities.offlineDownloads && (
          <Item icon="arrow-down-circle" label="Descargadas" active={pathname === '/biblioteca/descargadas'} onPress={() => go('/biblioteca/descargadas')} />
        )}
        {(source.capabilities.upload || source.capabilities.appleMusicImport) && (
          <Item icon="cloud-upload-outline" label="Importar" active={pathname.startsWith('/biblioteca/importar')} onPress={() => go('/biblioteca/importar')} />
        )}

        {(playlists.data?.length ?? 0) > 0 && <Section title="Playlists" />}
        {playlists.data?.map((p) => {
          const href = `/biblioteca/playlist/${p.id}`;
          return (
            <Pressable
              key={p.id}
              onPress={() => go({ pathname: '/biblioteca/playlist/[id]', params: { id: p.id } })}
              className={`flex-row items-center gap-3 mx-2 px-3 py-1.5 rounded-lg hover:bg-foreground/5 active:opacity-60 ${pathname === href ? 'bg-foreground/10' : ''}`}
            >
              <PlaylistArt playlist={p} size={32} className="w-8 h-8 rounded" />
              <ListMarquee rowHeight={36} className="text-foreground text-sm" containerClassName="flex-1">{p.name}</ListMarquee>
            </Pressable>
          );
        })}
      </ScrollView>
      <View className="border-t border-separator py-2">
        <Item icon="settings-outline" label="Ajustes" active={pathname === '/ajustes'} onPress={() => router.push('/ajustes')} />
      </View>
    </View>
  );
}

/** Dentro de la pestaña Biblioteca: cambia a ella si hace falta y abre la pantalla. */
function go(href: Href) {
  router.navigate(href);
}

function Section({ title }: { title: string }) {
  return <Text className="text-muted text-xs font-semibold uppercase px-5 pt-5 pb-1.5">{title}</Text>;
}

function Item({ icon, label, active, onPress }: { icon: IconName; label: string; active: boolean; onPress: () => void }) {
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center gap-3 mx-2 px-3 py-2 rounded-lg hover:bg-foreground/5 active:opacity-60 ${active ? 'bg-foreground/10' : ''}`}
    >
      <Ionicons name={icon} size={20} color={active ? accent : muted} />
      <Text className={`text-[15px] ${active ? 'text-foreground font-semibold' : 'text-foreground/85'}`}>{label}</Text>
    </Pressable>
  );
}
