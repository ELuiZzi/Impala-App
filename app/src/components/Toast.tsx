import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type ToastState = { id: number; text: string; icon: keyof typeof Ionicons.glyphMap } | null;

let current: ToastState = null;
let nextId = 1;
const listeners = new Set<() => void>();

/** Aviso breve en la parte superior (p. ej. "Se añadirá a la cola al terminar la descarga"). */
export function showToast(text: string, icon: keyof typeof Ionicons.glyphMap = 'checkmark-circle') {
  current = { id: nextId++, text, icon };
  listeners.forEach((l) => l());
}

const VISIBLE_MS = 3500;

export function Toast() {
  const insets = useSafeAreaInsets();
  const toast = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => current,
  );
  const [opacity] = useState(() => new Animated.Value(0));
  const shown = useRef<number | null>(null);

  useEffect(() => {
    if (!toast || shown.current === toast.id) return;
    shown.current = toast.id;
    opacity.stopAnimation();
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(VISIBLE_MS),
      Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [toast, opacity]);

  if (!toast) return null;
  return (
    <Animated.View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, opacity, elevation: 20 }}>
      <View className="flex-row items-center gap-2.5 rounded-2xl bg-neutral-800/95 px-4 py-3">
        <Ionicons name={toast.icon} size={20} color="white" />
        <Text className="flex-1 text-white text-sm font-medium">{toast.text}</Text>
      </View>
    </Animated.View>
  );
}
