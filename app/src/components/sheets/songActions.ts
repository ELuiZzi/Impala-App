import { router } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { invalidateLibrary, invalidatePlaylists, queryClient } from '@/api/queryClient';
import { ensureInLibrary, type YoutubeResult } from '@/api/youtube';
import { setFavorite, starredKey } from '@/library/favorites';
import { cancelDownloads, downloadSongs, isDownloaded, isDownloading, removeDownload } from '@/offline/store';
import {
  cancelSleepTimer,
  getSleepTimer,
  isSleepTimerActive,
  SLEEP_OPTIONS,
  sleepAtEndOfTrack,
  startSleepTimer,
} from '@/player/sleep';
import { BOOST_OPTIONS, boostLabel, getVolumeBoostDb, setVolumeBoostDb } from '@/player/boost';
import { getTuning, isNormal, tuningLabel } from '@/player/tuning';
import { getGymRamp, getGymSettings, startGymRamp, stopGymRamp } from '@/player/gym';
import { addToQueue, playNext, removeSongFromQueue } from '@/player/store';
import { albumName, artistName } from '../theme';
import { showToast } from '../Toast';
import { closeSheet, showSheet, type SheetOption } from './store';
import { DeleteCancelledError, type MusicSource, type Song } from '@/sources';
import { DEVICE } from '@/components/device';
import { invoke } from '@/platform/web/tauri';

type Context = {
  /** Si la canción se muestra dentro de una playlist, ofrece quitarla (por posición). */
  playlist?: { id: string; index: number; favorites?: boolean };
};

/** Navidrome detecta el borrado en ~2 s; después se refresca la biblioteca. */
const LIBRARY_REFRESH_DELAY_MS = 4000;

/** Menú "…" de una canción, como el de Apple Music. */
export function openSongActions(source: MusicSource, song: Song, ctx: Context = {}) {
  const go = (action: () => void) => () => {
    closeSheet();
    action();
  };

  const favorite = queryClient.getQueryData<Song[]>(starredKey(source))?.some((s) => s.id === song.id) ?? !!song.starred;
  const { capabilities } = source;

  const options: SheetOption[] = [
    favorite
      ? { label: 'Quitar de favoritas', icon: 'star', onPress: go(() => setFavorite(source, song, false).catch(showError)) }
      : { label: 'Marcar como favorita', icon: 'star-outline', onPress: go(() => setFavorite(source, song, true).catch(showError)) },
    { label: 'Reproducir a continuación', icon: 'return-down-forward', onPress: go(() => playNext([song])) },
    { label: 'Añadir a la cola', icon: 'list', onPress: go(() => addToQueue([song])) },
    { label: 'Añadir a una playlist…', icon: 'add-circle-outline', onPress: () => showSheet({ kind: 'playlistPicker', songs: [song] }) },
  ];
  if (capabilities.offlineDownloads) {
    options.push(
      isDownloaded(song.id)
        ? { label: `Eliminar del ${DEVICE}`, icon: 'phone-portrait-outline', onPress: go(() => removeDownload(song.id)) }
        : isDownloading(song.id)
          ? { label: 'Cancelar descarga', icon: 'close-circle-outline', onPress: go(() => cancelDownloads([song.id])) }
          : { label: 'Descargar', icon: 'arrow-down-circle-outline', onPress: go(() => downloadSongs(source, [song])) },
    );
  }

  if (song.albumId && albumName(song.album)) {
    options.push({
      label: 'Ir al álbum',
      icon: 'disc-outline',
      onPress: go(() => router.push({ pathname: '/biblioteca/album/[id]', params: { id: song.albumId! } })),
    });
  }
  if (song.artistId) {
    options.push({
      label: 'Ir al artista',
      icon: 'mic-outline',
      onPress: go(() => router.push({ pathname: '/biblioteca/artista/[id]', params: { id: song.artistId! } })),
    });
  }
  if (ctx.playlist) {
    const { id, index, favorites } = ctx.playlist;
    options.push({
      label: 'Quitar de esta playlist',
      icon: 'remove-circle-outline',
      destructive: true,
      onPress: async () => {
        // "Canciones Favoritas" refleja las estrellas: quitarla de ahí es quitar la estrella.
        if (favorites) await setFavorite(source, song, false);
        else {
          await source.removeFromPlaylist(id, [index]);
          await invalidatePlaylists(source);
        }
        closeSheet();
      },
    });
  }

  // PC, música del equipo: abre su carpeta en el Explorador con el archivo seleccionado.
  if (source.kind === 'local' && Platform.OS === 'web') {
    options.push({ label: 'Mostrar en el Explorador', icon: 'folder-open-outline', onPress: go(() => void invoke('library_reveal', { id: song.id }).catch(showError)) });
  }
  if (capabilities.trim) options.push({ label: 'Recortar…', icon: 'cut-outline', onPress: go(() => openTrimmer(song)) });
  if (capabilities.deleteSongs) {
    options.push({
      label: 'Eliminar de la biblioteca',
      icon: 'trash-outline',
      destructive: true,
      onPress: go(() => confirmDelete(source, song)),
    });
  }

  showSheet({
    kind: 'actions',
    title: song.title,
    subtitle: [artistName(song.artist), albumName(song.album)].filter(Boolean).join(' · '),
    coverArt: song.coverArt,
    options,
  });
}

/**
 * Menú "…" de un resultado de YouTube: las mismas acciones que una canción de la biblioteca. Como aún
 * no está en ella, cada acción primero la descarga en el servidor y se completa cuando Navidrome la
 * indexa (puede tardar si YouTube pide una pausa); mientras tanto un aviso lo explica.
 */
export function openYoutubeActions(source: MusicSource, result: YoutubeResult) {
  const later = (what: string, done: string, action: (song: Song) => void | Promise<void>) => () => {
    closeSheet();
    const where = source.kind === 'local' ? `el ${DEVICE}` : 'el servidor';
    showToast(`Descargando «${result.title}» en ${where}; ${what} al terminar`, 'cloud-download-outline');
    ensureInLibrary(source, result)
      .then(async (song) => {
        await action(song);
        showToast(done);
      })
      .catch(showError);
  };

  showSheet({
    kind: 'actions',
    title: result.title,
    subtitle: [result.artist, result.album].filter(Boolean).join(' · ') || 'YouTube',
    coverArt: undefined,
    thumbnail: result.thumbnail,
    options: [
      { label: 'Marcar como favorita', icon: 'star-outline', onPress: later('se marcará como favorita', `«${result.title}» está en tus favoritas`, (song) => setFavorite(source, song, true)) },
      { label: 'Reproducir a continuación', icon: 'return-down-forward', onPress: later('sonará a continuación', `«${result.title}» sonará a continuación`, (song) => playNext([song])) },
      { label: 'Añadir a la cola', icon: 'list', onPress: later('se añadirá a la cola', `«${result.title}» añadida a la cola`, (song) => addToQueue([song])) },
      {
        label: 'Añadir a una playlist…',
        icon: 'add-circle-outline',
        onPress: () =>
          showSheet({ kind: 'playlistPicker', songs: [], pending: { title: result.title, resolve: async () => [await ensureInLibrary(source, result)] } }),
      },
      // En modo local la descarga ya deja la canción en el teléfono.
      ...(source.capabilities.offlineDownloads
        ? [{ label: `Descargar en el ${DEVICE}`, icon: 'arrow-down-circle-outline' as const, onPress: later(`se descargará en el ${DEVICE}`, `Descargando «${result.title}» en el ${DEVICE}`, (song) => downloadSongs(source, [song])) }]
        : []),
      ...(result.artist
        ? [
            {
              label: 'Ir al artista',
              icon: 'mic-outline' as const,
              // El artista principal (YouTube Music los separa con comas): su página, por nombre.
              onPress: () => (closeSheet(), router.push({ pathname: '/youtube-artist/[id]', params: { id: '_', name: result.artist!.split(',')[0].trim() } })),
            },
          ]
        : []),
    ],
  });
}

/** Menú "…" del reproductor: añadir lo que suena a playlists y el temporizador de reposo. */
export function openPlayerActions(source: MusicSource, song: Song) {
  const timer = getSleepTimer();
  const active = isSleepTimerActive(timer);
  const remaining = timer.endOfTrack ? 'al terminar la canción' : timer.endsAt ? `en ${Math.max(1, Math.round((timer.endsAt - Date.now()) / 60_000))} min` : '';
  showSheet({
    kind: 'actions',
    title: song.title,
    subtitle: [artistName(song.artist), albumName(song.album)].filter(Boolean).join(' · '),
    coverArt: song.coverArt,
    options: [
      { label: 'Añadir a una playlist…', icon: 'add-circle-outline', onPress: () => showSheet({ kind: 'playlistPicker', songs: [song] }) },
      ...(song.artistId
        ? [{ label: 'Ir al artista', icon: 'mic-outline' as const, onPress: leavePlayer(() => router.push({ pathname: '/biblioteca/artista/[id]', params: { id: song.artistId! } })) }]
        : []),
      ...(song.albumId && albumName(song.album)
        ? [{ label: 'Ir al álbum', icon: 'disc-outline' as const, onPress: leavePlayer(() => router.push({ pathname: '/biblioteca/album/[id]', params: { id: song.albumId! } })) }]
        : []),
      ...(source.capabilities.trim ? [{ label: 'Recortar…', icon: 'cut-outline' as const, onPress: () => (closeSheet(), openTrimmer(song)) }] : []),
      {
        label: `Velocidad y tono: ${tuningLabel(getTuning(song.id))}`,
        icon: isNormal(getTuning(song.id)) ? 'speedometer-outline' : 'speedometer',
        onPress: () => openTuning(song),
      },
      {
        label: `Potenciador de volumen: ${boostLabel(getVolumeBoostDb())}`,
        icon: getVolumeBoostDb() > 0 ? 'volume-high' : 'volume-high-outline',
        onPress: () => openVolumeBoost(song),
      },
      {
        label: active ? `Temporizador: pausa ${remaining}` : 'Temporizador de reposo…',
        icon: active ? 'moon' : 'moon-outline',
        onPress: () => openSleepTimer(song),
      },
      getGymRamp().active
        ? { label: 'Detener volumen gradual', icon: 'barbell', onPress: () => (closeSheet(), void stopGymRamp()) }
        : {
            label: 'Volumen gradual (gym)',
            icon: 'barbell-outline',
            onPress: () => {
              closeSheet();
              startGymRamp()
                .then(() => {
                  const { maxPercent, minutes } = getGymSettings();
                  showToast(`Volumen gradual: subirá hasta ${maxPercent} % en ${minutes} min de música`, 'barbell');
                })
                .catch(showError);
            },
          },
    ],
  });
}

/** Cierra el reproductor (pantalla modal) y luego navega: la pantalla se abre debajo de él. */
const leavePlayer = (navigate: () => void) => () => {
  closeSheet();
  if (router.canGoBack()) router.back();
  setTimeout(navigate, 50);
};

function openSleepTimer(song: Song) {
  const timer = getSleepTimer();
  const run = (action: () => Promise<void>) => () => {
    closeSheet();
    action().catch(showError);
  };
  const options: SheetOption[] = [
    ...SLEEP_OPTIONS.map((o) => ({ label: o.label, icon: 'time-outline' as const, onPress: run(() => startSleepTimer(o.minutes)) })),
    { label: 'Al terminar la canción', icon: 'musical-note-outline', onPress: run(sleepAtEndOfTrack) },
  ];
  if (isSleepTimerActive(timer)) {
    options.push({ label: 'Desactivar temporizador', icon: 'close-circle-outline', destructive: true, onPress: run(cancelSleepTimer) });
  }
  showSheet({
    kind: 'actions',
    title: 'Temporizador de reposo',
    subtitle: 'La música se pausará automáticamente',
    coverArt: song.coverArt,
    options,
  });
}

/** Velocidad y tono (sped up / slowed) de lo que suena. */
export function openTuning(song: Song) {
  showSheet({ kind: 'tuning', songId: song.id, title: song.title, coverArt: song.coverArt });
}

/** Niveles del potenciador (los mismos de Ajustes); se aplica al momento sobre lo que suena. */
function openVolumeBoost(song: Song) {
  const current = getVolumeBoostDb();
  showSheet({
    kind: 'actions',
    title: 'Potenciador de volumen',
    subtitle: `Por encima del máximo del ${DEVICE}. Cuidado con los oídos en los niveles altos.`,
    coverArt: song.coverArt,
    options: BOOST_OPTIONS.map((o) => ({
      label: o.label,
      icon: o.db === current ? 'checkmark-circle' : o.db > 0 ? 'volume-high-outline' : 'volume-medium-outline',
      onPress: () => {
        closeSheet();
        setVolumeBoostDb(o.db);
        showToast(o.db > 0 ? `Potenciador: ${o.label}` : 'Potenciador desactivado', 'volume-high');
      },
    })),
  });
}

/** Editor para quitar la intro, el final o trozos intermedios de la canción (en el servidor). */
function openTrimmer(song: Song) {
  router.push({ pathname: '/recortar', params: { id: song.id } });
}

function showError(e: unknown) {
  Alert.alert('No se pudo completar', e instanceof Error ? e.message : undefined);
}

/** Borra el archivo (del servidor o del teléfono, tras confirmar), su descarga en el teléfono y su estrella. */
function confirmDelete(source: MusicSource, song: Song) {
  const where = source.kind === 'local' ? `del ${DEVICE}` : 'del servidor';
  // En el PC la música del equipo va a la papelera de reciclaje (se puede recuperar).
  const undo = source.kind === 'local' && Platform.OS === 'web' ? 'El archivo irá a la papelera de reciclaje.' : 'No se puede deshacer.';
  Alert.alert(
    'Eliminar de la biblioteca',
    `¿Eliminar «${song.title}» ${where}? Se borrará el archivo y desaparecerá de todas tus playlists. ${undo}`,
    [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          try {
            await source.deleteSong(song.id);
          } catch (e) {
            // Cancelado en el diálogo de Android: no se borró nada y no hay error que mostrar.
            if (e instanceof DeleteCancelledError) return;
            return showError(e);
          }
          removeDownload(song.id);
          await removeSongFromQueue(song.id);
          const favorite = queryClient.getQueryData<Song[]>(starredKey(source))?.some((s) => s.id === song.id);
          if (favorite) await setFavorite(source, song, false).catch(() => {});
          if (source.kind === 'local') invalidatePlaylists(source);
          setTimeout(() => invalidateLibrary(source), LIBRARY_REFRESH_DELAY_MS);
        },
      },
    ],
  );
}
