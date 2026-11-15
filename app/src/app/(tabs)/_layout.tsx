import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDesktop } from '@/components/desktop/layout';
import { Sidebar } from '@/components/desktop/Sidebar';
import { MINI_PLAYER_HEIGHT, MiniPlayer } from '@/components/player/MiniPlayer';
import { useThemeColor } from '@/components/theme';
import { usePlayer } from '@/player/store';

// Con navegación por gestos algunos Samsung reportan inset inferior 0 aunque dibujan la barra
// de gestos encima del contenido; garantizamos un margen mínimo para que no tape las etiquetas.
const MIN_BOTTOM_PADDING = 14;
const TAB_BAR_CONTENT_HEIGHT = 54;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');
  const muted = useThemeColor('muted');
  const background = useThemeColor('background');
  const separator = useThemeColor('separator');
  const bottom = Math.max(insets.bottom, MIN_BOTTOM_PADDING);
  const hasPlayer = usePlayer((s) => s.queue.length > 0);
  // En el PC: barra lateral en vez de pestañas, y la barra de reproducción (en el layout raíz) en vez del mini reproductor.
  const desktop = useDesktop();

  return (
    <View className="flex-1">
      <Tabs
        tabBar={desktop ? (props) => <Sidebar {...props} /> : undefined}
        screenOptions={{
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
          sceneStyle: { backgroundColor: background, paddingBottom: hasPlayer && !desktop ? MINI_PLAYER_HEIGHT + 12 : 0 },
        }}
      >
        <Tabs.Screen
          name="biblioteca"
          options={{ title: 'Biblioteca', tabBarIcon: ({ color, size }) => <Ionicons name="albums" size={size} color={color} /> }}
        />
        <Tabs.Screen
          name="buscar"
          options={{ title: 'Buscar', tabBarIcon: ({ color, size }) => <Ionicons name="search" size={size} color={color} /> }}
        />
      </Tabs>
      {!desktop && <MiniPlayer bottom={TAB_BAR_CONTENT_HEIGHT + bottom + 6} />}
    </View>
  );
}
