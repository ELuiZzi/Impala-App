import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

const ROWS: { icon: keyof typeof Ionicons.glyphMap; title: string; detail: string }[] = [
  { icon: 'arrow-up', title: 'Desliza hacia arriba', detail: 'Siguiente canción' },
  { icon: 'arrow-down', title: 'Desliza hacia abajo', detail: 'Canción anterior' },
  { icon: 'finger-print', title: 'Toca la carátula', detail: 'Pausar o seguir' },
  { icon: 'star', title: 'Doble toque', detail: 'Añadir a favoritas' },
  { icon: 'chevron-down', title: 'Dos dedos hacia abajo', detail: 'Cerrar el reproductor' },
];

/** Explicación de los gestos la primera vez que se abre el reproductor con gestos. */
export function GestureHint({ onDismiss, onUseButtons }: { onDismiss: () => void; onUseButtons: () => void }) {
  return (
    <View className="absolute inset-0 bg-black/85 items-center justify-center px-8 z-20">
      <Text className="text-white text-2xl font-bold mb-1 text-center">Reproductor con gestos</Text>
      <Text className="text-white/60 text-sm mb-6 text-center">Los botones de reproducción se ocultan: se maneja con el dedo.</Text>
      <View className="self-stretch gap-4 mb-8">
        {ROWS.map((r) => (
          <View key={r.title} className="flex-row items-center gap-4">
            <View className="w-11 h-11 rounded-full bg-white/15 items-center justify-center">
              <Ionicons name={r.icon} size={22} color="white" />
            </View>
            <View className="flex-1">
              <Text className="text-white text-base font-semibold">{r.title}</Text>
              <Text className="text-white/60 text-sm">{r.detail}</Text>
            </View>
          </View>
        ))}
      </View>
      <Pressable onPress={onDismiss} className="self-stretch rounded-full bg-white py-3.5 items-center active:opacity-70" accessibilityLabel="Entendido">
        <Text className="text-black text-base font-bold">Entendido</Text>
      </Pressable>
      <Pressable onPress={onUseButtons} hitSlop={8} className="mt-4 py-2 active:opacity-50" accessibilityLabel="Cambiar a botones">
        <Text className="text-white/70 text-sm font-semibold">Cambiar a botones</Text>
      </Pressable>
      <Text className="text-white/40 text-xs mt-2 text-center">Puedes cambiarlo cuando quieras en Ajustes.</Text>
    </View>
  );
}
