import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColor } from './theme';

/** Encabezado estilo Apple Music: título grande en negrita, con botón "atrás" opcional. */
export function LargeTitle({ title, back, right }: { title: string; back?: boolean; right?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');

  return (
    <View style={{ paddingTop: insets.top + 8 }} className="px-5 pb-2">
      <View className="h-10 flex-row items-center justify-between">
        {back ? (
          <Pressable onPress={() => router.back()} hitSlop={12} className="flex-row items-center -ml-2 active:opacity-50">
            <Ionicons name="chevron-back" size={28} color={accent} />
          </Pressable>
        ) : (
          <View />
        )}
        {right}
      </View>
      <Text className="text-foreground text-[34px] font-bold" numberOfLines={2}>{title}</Text>
    </View>
  );
}
