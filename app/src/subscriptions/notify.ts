import * as Notifications from 'expo-notifications';
import { subscription, visibleEpisodes } from './store';

/**
 * Avisos de episodios nuevos («Nueva oración de <canal>»), con su propio canal de notificaciones de Android
 * («Suscripciones»), que se puede silenciar aparte desde los ajustes del sistema. Al tocar uno se abre la
 * suscripción. En el PC no hay (notify.web.ts).
 */
const CHANNEL = 'suscripciones';
let channelReady: Promise<unknown> | null = null;

// Con la app abierta también se muestran (sin sonido extra).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

function ensureChannel() {
  channelReady ??= Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Suscripciones',
    description: 'Episodios nuevos de tus canales y podcasts',
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => null);
  return channelReady;
}

/** Pide permiso para avisar (Android 13+). Devuelve si se puede. */
export async function askNotificationPermission(): Promise<boolean> {
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** Un aviso por suscripción con episodios nuevos (y avisos activados); los Shorts ocultos no cuentan. */
export async function notifyNewEpisodes(added: Record<string, string[]>): Promise<void> {
  const entries = Object.entries(added).filter(([, ids]) => ids.length > 0);
  if (!entries.length) return;
  await ensureChannel();
  if (!(await Notifications.getPermissionsAsync()).granted) return;
  for (const [id, ids] of entries) {
    const sub = subscription(id);
    if (!sub?.notify) continue;
    const fresh = visibleEpisodes(sub).filter((e) => ids.includes(e.id));
    if (!fresh.length) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: sub.title,
        body: fresh.length === 1 ? fresh[0].title : `${fresh.length} episodios nuevos · ${fresh[0].title}`,
        data: { url: `/biblioteca/suscripciones/${encodeURIComponent(sub.id)}` },
      },
      // Ya, en el canal «Suscripciones» (sin indicarlo iría al canal genérico de Expo).
      trigger: { channelId: CHANNEL },
    }).catch(() => {});
  }
}

/** Al tocar un aviso (también si abrió la app): `open` recibe la ruta de la suscripción. */
export function listenNotificationTaps(open: (url: string) => void): () => void {
  const handle = (response: Notifications.NotificationResponse | null) => {
    const url = response?.notification.request.content.data?.url;
    if (typeof url === 'string') open(url);
  };
  handle(Notifications.getLastNotificationResponse());
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => sub.remove();
}
