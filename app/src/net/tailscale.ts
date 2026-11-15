import { AppState } from 'react-native';
import { queryClient } from '@/api/queryClient';
import ImpalaPlayer from '../../modules/impala-player';

const VPN_WAIT_MS = 10_000;
const VPN_POLL_MS = 300;
/** Con la interfaz ya arriba, MagicDNS y las rutas tardan un instante más. */
const VPN_SETTLE_MS = 500;

/** Solo hace falta la VPN con el servidor propio: con la música del teléfono no se toca. */
let enabled = false;
let waiting = false;

/**
 * Impala enciende Tailscale al pasar a primer plano y el módulo nativo lo apaga al cerrarse (ver
 * Tailscale.kt). Si la VPN estaba apagada, lo que falló mientras conectaba se vuelve a pedir.
 */
async function onForeground() {
  if (!enabled) return;
  const wasActive = ImpalaPlayer.onAppForeground();
  if (wasActive || waiting || !ImpalaPlayer.getManageTailscale() || !ImpalaPlayer.isTailscaleInstalled()) return;
  waiting = true;
  try {
    const deadline = Date.now() + VPN_WAIT_MS;
    while (!ImpalaPlayer.getNetworkInfo().vpn && Date.now() < deadline) await sleep(VPN_POLL_MS);
    await sleep(VPN_SETTLE_MS);
    await queryClient.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' });
  } finally {
    waiting = false;
  }
}

/** Se llama al conocer la fuente activa: con el servidor, enciende Tailscale ya si la app está abierta. */
export function setTailscaleEnabled(on: boolean) {
  if (on === enabled) return;
  enabled = on;
  if (on && AppState.currentState === 'active') void onForeground();
}

export function startTailscaleLifecycle(): () => void {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void onForeground();
  });
  return () => sub.remove();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
