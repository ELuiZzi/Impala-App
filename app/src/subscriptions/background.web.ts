import { refreshAll } from './store';

/** En el PC no hay tareas en segundo plano: se revisa al abrir Impala y cada hora mientras está abierta. */
const EVERY_MS = 60 * 60_000;

export async function checkSubscriptions(_opts: { notify: boolean }): Promise<void> {
  await refreshAll();
}

export async function scheduleBackgroundChecks(): Promise<void> {}

export function startForegroundChecks(): () => void {
  const timer = setInterval(() => void refreshAll(), EVERY_MS);
  return () => clearInterval(timer);
}
