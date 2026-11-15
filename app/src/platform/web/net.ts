/**
 * En la ventana de Tauri, las peticiones a otros sitios salen desde Rust (tauri-plugin-http): YouTube,
 * LRCLIB o el uploader del servidor no mandan cabeceras CORS y el WebView las bloquearía. Las demás
 * (la propia app) siguen con el fetch del navegador. <img> y <audio> no pasan por aquí.
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke, isTauri } from './tauri';

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function isExternal(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const { origin, hostname } = new URL(url);
    // Tauri habla con Rust por http://ipc.localhost (y sirve la app desde *.localhost): eso no se desvía.
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
    return origin !== globalThis.location?.origin;
  } catch {
    return false;
  }
}

export function routeExternalFetch(): void {
  if (!isTauri()) return;
  const browserFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    isExternal(urlOf(input)) ? tauriFetch(input, init) : browserFetch(input, init);
}

/** Solo en desarrollo: los errores y avisos de la ventana se ven en la terminal de `npm run dev`. */
export function forwardConsoleToTerminal(): void {
  if (!isTauri() || !__DEV__) return;
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const message = args
        .map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : typeof a === 'string' ? a : safeJson(a)))
        .join(' ');
      invoke('dev_log', { level, message: message.slice(0, 4000) }).catch(() => {});
    };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
