import { useNavigation, useRoute } from 'expo-router';
import { useEffect } from 'react';

/**
 * Quita esta pantalla de la pila cuando ya no hay nada que mostrar (la cola se vació, p. ej. al
 * cambiar de fuente de música). No usa router.back(): si encima hay otra pantalla (Ajustes), back
 * cerraría esa y esta se quedaría arriba, vacía y transparente, tragándose los toques.
 */
export function useCloseWhenEmpty(empty: boolean) {
  const navigation = useNavigation();
  const { key } = useRoute();
  useEffect(() => {
    if (!empty) return;
    navigation.dispatch((state) => {
      const routes = state.routes.filter((r) => r.key !== key);
      return { type: 'RESET', payload: { ...state, routes, index: Math.max(0, routes.length - 1) } };
    });
  }, [empty, key, navigation]);
}
