import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Artwork } from './Artwork';
import { useThemeColor } from './theme';
import { Marquee } from '@/components/Marquee';

type Props = {
  coverArt?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onSubtitlePress?: () => void;
  meta?: string;
  /** Acción en la esquina superior derecha (p. ej. menú "…"). */
  right?: ReactNode;
  /** Carátula propia (p. ej. la de una playlist) en lugar de coverArt. */
  art?: ReactNode;
};

/** Cabecera de álbum/playlist estilo Apple Music: carátula grande centrada y títulos debajo. */
export function CollectionHeader({ coverArt, icon = 'disc', title, subtitle, onSubtitlePress, meta, right, art }: Props) {
  const insets = useSafeAreaInsets();
  const accent = useThemeColor('accent');

  return (
    <View style={{ paddingTop: insets.top + 8 }} className="pb-4">
      <View className="h-10 flex-row items-center justify-between px-3">
        <Pressable onPress={() => router.back()} hitSlop={12} className="active:opacity-50">
          <Ionicons name="chevron-back" size={28} color={accent} />
        </Pressable>
        {right}
      </View>
      <View className="items-center px-8">
        {art ?? <Artwork coverArt={coverArt} size={600} icon={icon} className="w-64 h-64 rounded-2xl" />}
        <Text className="text-foreground text-[22px] font-bold text-center mt-5" numberOfLines={2}>{title}</Text>
        {subtitle ? (
          <Pressable onPress={onSubtitlePress} disabled={!onSubtitlePress} className="active:opacity-50">
            <Marquee className="text-accent text-[19px] text-center" containerClassName="mt-0.5">{subtitle}</Marquee>
          </Pressable>
        ) : null}
        {meta ? <Text className="text-muted text-xs font-semibold uppercase text-center mt-1.5">{meta}</Text> : null}
      </View>
    </View>
  );
}
