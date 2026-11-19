import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { syncDownloads } from './downloads';
import { notifyNewEpisodes } from './notify';
import { refreshAll, subscriptions } from './store';

/**
 * Revisar las suscripciones aunque Impala esté cerrada: una tarea de Android (WorkManager) cada ~3 h, cuando el
 * sistema lo vea bien (batería y red). Avisa de lo nuevo y descarga lo que toque. Se define al cargar el código
 * (index.ts), porque en segundo plano Android arranca solo el JS, sin pantallas. En el PC: background.web.ts.
 */
const TASK = 'impala-suscripciones';
const INTERVAL_MIN = 180;

/**
 * Revisa todas, avisa de lo nuevo (si `notify`) y pone al día las descargas. Con la app abierta se respeta el
 * intervalo mínimo por feed; en segundo plano (`notify`, cada ~3 h) se revisan todas siempre.
 */
export async function checkSubscriptions({ notify }: { notify: boolean }): Promise<void> {
  const added = await refreshAll({ force: notify });
  if (notify) await notifyNewEpisodes(added);
  await syncDownloads();
}

TaskManager.defineTask(TASK, async () => {
  try {
    await checkSubscriptions({ notify: true });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Activa la revisión en segundo plano si hay suscripciones (y la quita si no). */
export async function scheduleBackgroundChecks(): Promise<void> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(TASK);
    const wanted = subscriptions().length > 0;
    // Si cambió el intervalo (otra versión de Impala), se vuelve a registrar con el nuevo.
    const options = registered ? await TaskManager.getTaskOptionsAsync<{ minimumInterval?: number }>(TASK).catch(() => null) : null;
    if (wanted && (!registered || options?.minimumInterval !== INTERVAL_MIN)) {
      // Quitarla antes: registrar encima cambia el ajuste pero no el trabajo que ya estaba en cola.
      if (registered) await BackgroundTask.unregisterTaskAsync(TASK);
      await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: INTERVAL_MIN });
    }
    if (!wanted && registered) await BackgroundTask.unregisterTaskAsync(TASK);
  } catch {
    // Sin servicios de segundo plano: se revisa al abrir la app.
  }
}

/** Con la app abierta no hace falta: se revisa al abrirla y al volver a ella (ver _layout). */
export function startForegroundChecks(): () => void {
  return () => {};
}
