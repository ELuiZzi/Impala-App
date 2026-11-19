import { router } from 'expo-router';
import { Alert } from 'react-native';
import { closeSheet, showSheet } from '@/components/sheets/store';
import { showToast } from '@/components/Toast';
import { scheduleBackgroundChecks } from './background';
import { removeAllDownloads, syncDownloads } from './downloads';
import { askNotificationPermission } from './notify';
import { normalize, officialChannelFor } from './resolve';
import { addSubscription, removeSubscription, type Subscription, subscriptions } from './store';

/** Tras suscribirse: permiso para avisar, revisión en segundo plano y primeras descargas. */
function afterSubscribe() {
  void askNotificationPermission();
  void scheduleBackgroundChecks();
  void syncDownloads();
}

export const openSubscription = (sub: Subscription) => router.push({ pathname: '/biblioteca/suscripciones/[id]', params: { id: sub.id } });

/** Pide el enlace (canal, video o podcast) y se suscribe; los errores se ven en la propia hoja. */
export function promptSubscribe(onAdded?: (s: Subscription) => void) {
  showSheet({
    kind: 'prompt',
    title: 'Nueva suscripción',
    placeholder: 'Enlace del canal, de un video o del podcast',
    confirmLabel: 'Suscribirme',
    onSubmit: async (text) => {
      const sub = await addSubscription(text);
      closeSheet();
      showToast(`Suscrito a ${sub.title}`, 'checkmark-circle');
      afterSubscribe();
      onAdded?.(sub);
    },
  });
}

/** Suscribirse sin preguntar (p. ej. desde la página de un canal). Devuelve si se pudo. */
export async function subscribeTo(input: string): Promise<Subscription | null> {
  try {
    const sub = await addSubscription(input);
    showToast(`Suscrito a ${sub.title}`, 'checkmark-circle');
    afterSubscribe();
    return sub;
  } catch (e) {
    Alert.alert('No se pudo suscribir', e instanceof Error ? e.message : undefined);
    return null;
  }
}

/** La suscripción al canal de un artista, si ya existe (por el id de YouTube Music o por el nombre). */
export function artistSubscription(channelId: string | null | undefined, name: string): Subscription | undefined {
  const want = normalize(name);
  return subscriptions().find((s) => s.id === `yt:${channelId}` || (s.kind === 'youtube' && normalize(s.title) === want));
}

/** Suscribirse al canal oficial de un artista (el de YouTube Music suele ser el automático, sin videos). */
export async function subscribeToArtist(name: string, musicChannelId: string | null | undefined): Promise<Subscription | null> {
  const official = await officialChannelFor(name).catch(() => null);
  const id = official ?? musicChannelId;
  if (!id) {
    Alert.alert('No se pudo suscribir', 'No se encontró el canal de YouTube de este artista.');
    return null;
  }
  return subscribeTo(`https://www.youtube.com/channel/${id}`);
}

export function confirmUnsubscribe(sub: Subscription, onDone?: () => void) {
  Alert.alert('Quitar suscripción', `¿Dejar de seguir «${sub.title}»?`, [
    { text: 'Cancelar', style: 'cancel' },
    {
      text: 'Quitar',
      style: 'destructive',
      onPress: () => {
        removeAllDownloads(sub);
        removeSubscription(sub.id);
        void scheduleBackgroundChecks();
        onDone?.();
      },
    },
  ]);
}
