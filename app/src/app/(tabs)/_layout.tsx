import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDesktop } from '@/components/desktop/layout';
import { Sidebar } from '@/components/desktop/Sidebar';
import { MINI_PLAYER_HEIGHT, MiniPlayer } from '@/components/player/MiniPlayer';
import { PREVIEW_BAR_HEIGHT, PreviewBar, usePreviewBarVisible } from '@/components/player/PreviewBar';
import { useThemeColor } from '@/components/theme';
import { usePlayer } from '@/player/store';
import { warmUpDiscover } from '@/discover/session';
import { useSource } from '@/sources';

// Con navegación por gestos algunos Samsung reportan inset inferior 0 aunque dibujan la barra
// de gestos encima del contenido; garantizamos un margen mínimo para que no tape las etiquetas.
const MIN_BOTTOM_PADDING = 14;
const TAB_BAR_CONTENT_HEIGHT = 54;
/** Descubrir se prepara un rato después de abrir la app (para que la primera canción suene al instante). */
const WARM_UP_DELAY_MS = 5000;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const background = useThemeColor('background');
  const separator = useThemeColor('separator');
  const bottom = Math.max(insets.bottom, MIN_BOTTOM_PADDING);
  const hasPlayer = usePlayer((s) => s.queue.length > 0);
  // La vista previa de YouTube ocupa el sitio del mini reproductor mientras suena.
  const previewing = usePreviewBarVisible();
  // En el PC: barra lateral en vez de pestañas, y la barra de reproducción (en el layout raíz) en vez del mini reproductor.
  const desktop = useDesktop();
  // Descubrir ocupa toda la pantalla, con su propio audio: ni mini reproductor ni hueco para él.
  const discovering = usePathname() === '/descubrir';
  const source = useSource();

  useEffect(() => {
    const t = setTimeout(() => void warmUpDiscover(source).catch(() => {}), WARM_UP_DELAY_MS);
    return () => clearTimeout(t);
  }, [source]);

  return (
    <View className="flex-1">
      <Tabs
        tabBar={desktop ? (props) => <Sidebar {...props} /> : undefined}
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarPosition: desktop ? 'left' : 'bottom',
          tabBarActiveTintColor: accent,
          tabBarInactiveTintColor: muted,
          tabBarStyle: {
            backgroundColor: background,
            borderTopColor: separator,
            height: TAB_BAR_CONTENT_HEIGHT + bottom,
            paddingBottom: bottom,
          },
          // Deja sitio para el mini reproductor, que flota sobre la barra de pestañas.
          sceneStyle: {
            backgroundColor: route.name === 'descubrir' ? 'black' : background,
            paddingBottom: route.name === 'descubrir' ? 0 : previewing ? PREVIEW_BAR_HEIGHT + 12 : hasPlayer && !desktop ? MINI_PLAYER_HEIGHT + 12 : 0,
          },
        })}
      >
        <Tabs.Screen
          name="biblioteca"
          options={{ title: 'Biblioteca', tabBarIcon: ({ color, size }) => <Ionicons name="albums" size={size} color={color} /> }}
        />
        <Tabs.Screen
          name="descubrir"
          options={{
            title: 'Descubrir',
            tabBarIcon: ({ color, size }) => <Ionicons name="sparkles" size={size} color={color} />,
            ...(desktop ? {} : { tabBarStyle: { backgroundColor: 'black', borderTopColor: 'transparent', height: TAB_BAR_CONTENT_HEIGHT + bottom, paddingBottom: bottom }, tabBarInactiveTintColor: '#8e8e93' }),
          }}
        />
        <Tabs.Screen
          name="buscar"
          options={{ title: 'Buscar', tabBarIcon: ({ color, size }) => <Ionicons name="search" size={size} color={color} /> }}
        />
      </Tabs>
      {!desktop && !previewing && !discovering && <MiniPlayer bottom={TAB_BAR_CONTENT_HEIGHT + bottom + 6} />}
      {!discovering && <PreviewBar bottom={desktop ? 16 : TAB_BAR_CONTENT_HEIGHT + bottom + 6} />}
    </View>
  );
}
