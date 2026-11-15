import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useThemeColor } from './theme';

export type MenuItem = { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void };

const MENU_WIDTH = 220;

/** Menú ⋯ de las pantallas principales (Biblioteca y Buscar). */
export const APP_MENU: MenuItem[] = [{ label: 'Ajustes', icon: 'settings-outline', onPress: () => router.push('/ajustes') }];

/** Botón ⋯ que despliega una lista anclada bajo él, alineada a su borde derecho. */
export function OverflowMenu({ items }: { items: MenuItem[] }) {
  const accent = useThemeColor('accent');
  const foreground = useThemeColor('foreground');
  const { width } = useWindowDimensions();
  const button = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  function open() {
    button.current?.measureInWindow((x, y, w, h) => setAnchor({ top: y + h + 6, right: Math.max(width - (x + w), 12) }));
  }

  return (
    <>
      <Pressable ref={button} onPress={open} hitSlop={12} className="active:opacity-50" accessibilityLabel="Más opciones">
        <Ionicons name="ellipsis-horizontal-circle" size={28} color={accent} />
      </Pressable>
      <Modal transparent visible={!!anchor} animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => setAnchor(null)}>
        <Pressable onPress={() => setAnchor(null)} className="absolute inset-0" />
        {anchor && (
          <View style={{ position: 'absolute', top: anchor.top, right: anchor.right, width: MENU_WIDTH, elevation: 12 }} className="rounded-xl bg-card overflow-hidden">
            {items.map((item, i) => (
              <Pressable
                key={item.label}
                onPress={() => {
                  setAnchor(null);
                  item.onPress();
                }}
                className={`flex-row items-center justify-between px-4 py-3 active:bg-separator ${i < items.length - 1 ? 'border-b border-separator' : ''}`}
              >
                <Text className="text-foreground text-base">{item.label}</Text>
                <Ionicons name={item.icon} size={20} color={foreground} />
              </Pressable>
            ))}
          </View>
        )}
      </Modal>
    </>
  );
}
