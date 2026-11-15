import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { httpError } from './auth.js';

/** Tras este tiempo el proceso se renueva (cuando no tiene peticiones): recoge las actualizaciones de pip. */
const MAX_AGE_MS = 6 * 60 * 60_000;

/**
 * Proceso persistente de ytmusic.py ("serve"): arrancar Python e importar ytmusicapi y yt-dlp cuesta
 * 1-2 s, más que la propia búsqueda. Se lanza al primer uso, atiende varias peticiones a la vez (una
 * línea JSON por petición y por respuesta) y se relanza solo si muere.
 *
 * call(cmd, args, timeoutMs) → result. Un error de Python llega como Error con su mensaje.
 */
export function createYtWorker({ python, script, spawnImpl = spawn, maxAgeMs = MAX_AGE_MS }) {
  let child = null;
  let startedAt = 0;
  let nextId = 0;
  const pending = new Map();

  function start() {
    const proc = spawnImpl(python, ['-I', script, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    startedAt = Date.now();
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.result);
      else request.reject(new Error(message.error ?? 'Error de ytmusic'));
    });
    proc.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) console.error('ytmusic:', line.trim().slice(0, 500));
    });
    const fail = (err) => {
      if (child === proc) child = null;
      // Lo que esperaba a este proceso falla; la siguiente petición lanza uno nuevo.
      for (const [id, request] of pending) {
        if (request.proc !== proc) continue;
        pending.delete(id);
        clearTimeout(request.timer);
        request.reject(err);
      }
    };
    proc.on('error', (err) => fail(err));
    proc.on('close', (code) => fail(new Error(`ytmusic terminó (código ${code})`)));
    // stdin cerrado por el otro lado: se detecta en close.
    proc.stdin.on('error', () => {});
    return proc;
  }

  function current() {
    const idle = ![...pending.values()].some((r) => r.proc === child);
    if (child && idle && Date.now() - startedAt > maxAgeMs) {
      const old = child;
      child = null;
      old.stdin.end();
    }
    return child ?? start();
  }

  function call(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const proc = current();
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(httpError(504, 'YouTube Music tardó demasiado en responder'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, proc });
      proc.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }

  /** Arranca el proceso por adelantado para que la primera búsqueda no pague la importación. */
  function warm() {
    current();
  }

  function stop() {
    child?.stdin.end();
    child = null;
  }

  return { call, warm, stop };
}

/**
 * Caché en memoria con caducidad: guarda la promesa, así varias peticiones iguales simultáneas
 * comparten la misma consulta. Los errores no se guardan.
 */
export function createCache({ ttlMs, max = 300, now = Date.now }) {
  const entries = new Map();
  return function cached(key, load) {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) {
      // Más reciente al final (LRU).
      entries.delete(key);
      entries.set(key, hit);
      return hit.value;
    }
    const value = Promise.resolve().then(load);
    entries.delete(key);
    if (entries.size >= max) entries.delete(entries.keys().next().value);
    entries.set(key, { value, expires: now() + ttlMs });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}
