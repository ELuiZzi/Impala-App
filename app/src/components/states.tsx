import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useThemeColor } from './theme';

export function Loading() {
  const muted = useThemeColor('muted');
  return (
    <View className="py-16 items-center">
      <ActivityIndicator color={muted} />
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Algo salió mal';
  return (
    <View className="py-16 px-8 items-center gap-3">
      <Ionicons name="cloud-offline-outline" size={40} color={useThemeColor('muted')} />
      <Text className="text-foreground text-base text-center">{message}</Text>
      {onRetry && (
        <Pressable onPress={onRetry} className="px-5 py-2 rounded-full bg-card active:opacity-60">
          <Text className="text-accent font-semibold">Reintentar</Text>
        </Pressable>
      )}
    </View>
  );
}

export function EmptyState({ icon, title, subtitle }: { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle?: string }) {
  return (
    <View className="py-16 px-8 items-center gap-2">
      <Ionicons name={icon} size={44} color={useThemeColor('muted')} />
      <Text className="text-foreground text-lg font-semibold text-center">{title}</Text>
      {!!subtitle && <Text className="text-muted text-sm text-center">{subtitle}</Text>}
    </View>
  );
}
