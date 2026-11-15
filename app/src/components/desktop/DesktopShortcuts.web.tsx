import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { artistName } from '@/components/theme';
import { showToast } from '@/components/Toast';
import { useMaybeSource } from '@/sources';
import { addPcFiles, type PcFile } from '@/upload/pc';
import { invoke, isTauri } from '@/platform/web/tauri';
import { currentSong, next, previous, seekTo, togglePlay, usePlayer } from '@/player/store';
import { checkForUpdates } from './updates';
import { changeVolume, toggleMute } from './volume';

/**
 * Atajos de teclado del PC:
 *   Espacio            reproducir / pausar
 *   Ctrl + → / ←       siguiente / anterior
 *   Shift + → / ←      adelantar / retroceder 10 s
 *   Ctrl + ↑ / ↓       subir / bajar volumen
 *   M                  silenciar
 *   Ctrl + F           Buscar
 *   Escape             cerrar Reproduciendo o la cola
 * No actúan mientras se escribe en un campo de texto. También quita el menú del navegador al hacer clic derecho
 * (las filas de canciones abren el suyo).
 */
export function DesktopShortcuts() {
  const pathname = usePathname();
  const position = usePlayer((s) => s.positionMs);
  const song = usePlayer(currentSong);

  // Una versión nueva publicada en GitHub: se comprueba al poco de arrancar (sin avisar si no hay nada).
  useEffect(() => {
    const timer = setTimeout(() => void checkForUpdates(false), 5000);
    return () => clearTimeout(timer);
  }, []);

  // El icono de la bandeja: sus controles (desktop.rs llama a window.__impalaTray) y la canción al pasar el ratón.
  useEffect(() => {
    const w = window as { __impalaTray?: (action: string) => void };
    w.__impalaTray = (action) => {
      if (action === 'toggle') void togglePlay();
      else if (action === 'next') void next();
      else if (action === 'previous') void previous();
    };
    return () => void delete w.__impalaTray;
  }, []);
  // Soltar canciones o carpetas en la ventana (desktop.rs → __impalaDrop): a Importar, si la fuente las admite.
  const source = useMaybeSource();
  useEffect(() => {
    const w = window as { __impalaDrop?: (files: PcFile[]) => void };
    w.__impalaDrop = (files) => {
      if (!source?.capabilities.upload) {
        showToast('Para subir música, conecta tu servidor en Ajustes', 'cloud-offline-outline');
        return;
      }
      if (files.length === 0) {
        showToast('No hay audio en lo que soltaste', 'alert-circle');
        return;
      }
      const added = addPcFiles(files);
      router.navigate('/biblioteca/importar');
      showToast(added > 0 ? `${added} archivo${added === 1 ? '' : 's'} listo${added === 1 ? '' : 's'} para subir` : 'Ya estaban en la lista', 'cloud-upload-outline');
    };
    return () => void delete w.__impalaDrop;
  }, [source]);

  useEffect(() => {
    if (!isTauri()) return;
    const text = song ? `${song.title} — ${artistName(song.artist) ?? ''}`.replace(/ — $/, '') : '';
    invoke('set_tray_tooltip', { text: text.slice(0, 120) }).catch(() => {});
  }, [song]);
  const latest = useRef({ pathname, position });
  useEffect(() => {
    latest.current = { pathname, position };
  }, [pathname, position]);

  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return el.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range');
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // p. ej. Escape ya lo usó un diálogo
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        router.navigate('/buscar');
        return;
      }
      if (e.key === 'Escape') {
        const { pathname: path } = latest.current;
        if (path === '/reproduciendo' || path === '/cola') {
          e.preventDefault();
          router.back();
        }
        return;
      }
      if (typing(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        void togglePlay();
      } else if (ctrl && e.key === 'ArrowRight') {
        e.preventDefault();
        void next();
      } else if (ctrl && e.key === 'ArrowLeft') {
        e.preventDefault();
        void previous();
      } else if (e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        void seekTo(Math.max(0, latest.current.position + (e.key === 'ArrowRight' ? 10_000 : -10_000)));
      } else if (ctrl && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        changeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05);
      } else if (!ctrl && !e.altKey && e.key.toLowerCase() === 'm') {
        toggleMute();
      }
    };

    // Sin el menú del navegador (Atrás, Recargar, Inspeccionar…) salvo sobre campos de texto (copiar y pegar).
    const onContextMenu = (e: MouseEvent) => {
      if (!typing(e.target)) e.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', onContextMenu);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  return null;
}
