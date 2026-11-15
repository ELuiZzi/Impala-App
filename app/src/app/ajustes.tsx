import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Paths } from 'expo-file-system';
import { Alert, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { useServerInfo } from '@/api/queries';
import { useAuth } from '@/auth/session';
import { LargeTitle } from '@/components/LargeTitle';
import { songCount, useThemeColor } from '@/components/theme';
import { formatBytes, removeAllDownloads, totalBytes, useOffline } from '@/offline/store';
import { invoke, isTauri } from '@/platform/web/tauri';
import { canUpdate, checkForUpdates } from '@/components/desktop/updates';
import { BOOST_OPTIONS, getVolumeBoostDb, setVolumeBoostDb } from '@/player/boost';
import { GYM_MAX_OPTIONS, GYM_MINUTES_OPTIONS, getGymSettings, setGymSettings } from '@/player/gym';
import { setQualityPreference, useQualityPreference, type QualityPreference } from '@/player/quality';
import { useSource } from '@/sources';
import { refreshLocalLibrary } from '@/sources/local';
import { DEFAULT_FOLDER, updateLocalData, useLocalFolders } from '@/sources/localData';
import ImpalaLibrary from '../../modules/impala-library';
import ImpalaPlayer, { type GymSettings } from '../../modules/impala-player';
import { DEVICE } from '@/components/device';
import { useDesktop } from '@/components/desktop/layout';
import { setPlayerControls, usePlayerControls } from '@/player/controls';

const CROSSFADE_OPTIONS: { ms: number; label: string; detail: string }[] = [
  { ms: 0, label: 'Desactivado', detail: 'Las canciones se suceden sin pausas (gapless)' },
  { ms: 3000, label: '3 segundos', detail: 'Fundido corto' },
  { ms: 4000, label: '4 segundos', detail: 'Fundido medio' },
  { ms: 5000, label: '5 segundos', detail: 'Fundido largo' },
];

const QUALITY_OPTIONS: { value: QualityPreference; label: string; detail: string }[] = [
  { value: 'auto', label: 'Automática', detail: 'Original en Wi-Fi, ahorro en datos móviles' },
  { value: 'original', label: 'Siempre original', detail: 'FLAC/ALAC sin pérdida, bit a bit' },
  { value: 'ahorro', label: 'Siempre ahorro de datos', detail: 'Opus 192 kbps transcodificado' },
];

export default function AjustesScreen() {
  const source = useSource();
  const { session, signOut, setMode } = useAuth();
  const local = source.kind === 'local';
  const queryClient = useQueryClient();
  const info = useServerInfo();
  const quality = useQualityPreference();
  const playerControls = usePlayerControls();
  const desktop = useDesktop();
  const [crossfadeMs, setCrossfadeMs] = useState(() => ImpalaPlayer.getCrossfadeMs());
  const [boostDb, setBoostDb] = useState(getVolumeBoostDb);
  const [manageTailscale, setManageTailscale] = useState(() => ImpalaPlayer.getManageTailscale());
  const [gym, setGym] = useState(getGymSettings);
  const updateGym = (next: GymSettings) => {
    setGymSettings(next);
    setGym(next);
  };
  const tailscaleInstalled = ImpalaPlayer.isTailscaleInstalled();
  const accent = useThemeColor('accent');
  const offlineIndex = useOffline((s) => s.index);
  const downloadedCount = Object.keys(offlineIndex.songs).length;
  const network = ImpalaPlayer.getNetworkInfo();
  const networkLabel = !network.connected ? 'Sin conexión' : network.metered ? 'Red de pago por uso (datos móviles)' : 'Red sin límite (Wi-Fi)';

  const status = info.isPending ? 'Comprobando…' : info.isError ? 'Sin conexión' : 'Conectado';
  const version = info.data?.version ?? '—';

  function confirmRemoveDownloads() {
    Alert.alert('Eliminar descargas', `Se borrarán ${songCount(downloadedCount)} del ${DEVICE}. Seguirán en tu servidor.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: removeAllDownloads },
    ]);
  }

  function confirmSignOut() {
    Alert.alert('Cerrar sesión', `¿Quieres desconectar Impala de este servidor? Volverá a usar la música del ${DEVICE}.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Cerrar sesión',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          queryClient.clear();
        },
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <LargeTitle title="Ajustes" back />

      <Group
        title="Fuente de música"
        footer={
          session
            ? `Al cambiar de fuente se detiene lo que suena. Cada fuente conserva sus playlists, favoritas y fijadas; la sesión del servidor se guarda aunque uses el ${DEVICE}.`
            : `Impala funciona sin servidor ni cuenta. Si tienes tu propio servidor Navidrome, puedes conectarlo cuando quieras: cada fuente conserva sus playlists, favoritas y fijadas.`
        }
      >
        <Option
          label={DEVICE === 'equipo' ? 'Este equipo' : 'Este dispositivo'}
          detail={`La música guardada en el ${DEVICE}`}
          selected={local}
          onPress={() => setMode('local')}
        />
        <Option
          label="Servidor propio"
          detail={session ? `${session.username} · ${session.server.replace(/^https?:\/\//, '')}` : 'Navidrome en tu servidor: toca para conectarlo'}
          selected={!local}
          last
          onPress={() => (session ? setMode('server') : router.push('/login'))}
        />
      </Group>

      {local ? (
        <LocalFolders songs={version} />
      ) : (
        <Group
          title={source.label}
          footer={
            tailscaleInstalled
              ? undefined
              : 'Tailscale es opcional: solo hace falta si tu servidor está en una red de Tailscale (dirección .ts.net).'
          }
        >
          <Item label="Estado" value={status} />
          {source.details.map((d) => <Item key={d.label} label={d.label} value={d.value} />)}
          <Item label="Versión" value={version} />
          <Pressable onPress={() => router.push('/login')} className="active:opacity-60">
            <Text className="text-accent text-base ml-4 py-3">Cambiar de servidor o cuenta…</Text>
          </Pressable>
        </Group>
      )}

      {source.capabilities.streamQuality && (
        <Group title="Calidad de streaming" footer={`Ahora: ${networkLabel}. Se aplica al iniciar una lista.`}>
          {QUALITY_OPTIONS.map((o, i) => (
            <Option
              key={o.value}
              label={o.label}
              detail={o.detail}
              selected={quality === o.value}
              last={i === QUALITY_OPTIONS.length - 1}
              onPress={() => setQualityPreference(o.value)}
            />
          ))}
        </Group>
      )}

      {!desktop && (
        <Group
          title="Controles del reproductor"
          footer="Con gestos: desliza la carátula hacia arriba o abajo para cambiar de canción, tócala para pausar, doble toque para favorita y cierra con dos dedos hacia abajo."
        >
          <Option
            label="Gestos"
            detail="Sin botones de reproducción, como un feed"
            selected={playerControls === 'gestos'}
            onPress={() => setPlayerControls('gestos')}
          />
          <Option
            label="Botones"
            detail="Anterior, reproducir y siguiente, aleatorio y repetir"
            selected={playerControls === 'botones'}
            last
            onPress={() => setPlayerControls('botones')}
          />
        </Group>
      )}

      <Group title="Crossfade" footer="No se aplica entre canciones del mismo álbum, para respetar los discos sin pausas.">
        {CROSSFADE_OPTIONS.map((o, i) => (
          <Option
            key={o.ms}
            label={o.label}
            detail={o.detail}
            selected={crossfadeMs === o.ms}
            last={i === CROSSFADE_OPTIONS.length - 1}
            onPress={() => {
              ImpalaPlayer.setCrossfadeMs(o.ms);
              setCrossfadeMs(o.ms);
            }}
          />
        ))}
      </Group>

      <Group
        title="Potenciador de volumen"
        footer={`Sube el volumen por encima del máximo del ${DEVICE}. Cuidado con los oídos y con bocinas pequeñas en los niveles altos.`}
      >
        {BOOST_OPTIONS.map((o, i) => (
          <Option
            key={o.db}
            label={o.label}
            detail={o.detail}
            selected={boostDb === o.db}
            last={i === BOOST_OPTIONS.length - 1}
            onPress={() => {
              setVolumeBoostDb(o.db);
              setBoostDb(o.db);
            }}
          />
        ))}
      </Group>

      <Group
        title="Volumen gradual (gym)"
        footer={`Se activa desde el menú … de una playlist. Sube el volumen del ${DEVICE} poco a poco, desde el que tengas, hasta este máximo; solo avanza mientras suena música. Si mueves el volumen tú, se detiene.`}
      >
        <Text className="text-muted text-xs font-semibold uppercase ml-4 pt-3 pb-1">Volumen máximo</Text>
        <Chips
          options={GYM_MAX_OPTIONS.map((p) => ({ value: p, label: `${p} %` }))}
          selected={gym.maxPercent}
          onSelect={(maxPercent) => updateGym({ ...gym, maxPercent })}
        />
        <Text className="text-muted text-xs font-semibold uppercase ml-4 pt-2 pb-1">Llegar al máximo en</Text>
        <Chips
          options={GYM_MINUTES_OPTIONS.map((m) => ({ value: m, label: `${m} min` }))}
          selected={gym.minutes}
          onSelect={(minutes) => updateGym({ ...gym, minutes })}
        />
      </Group>

      {tailscaleInstalled && !local && (
        <Group
          title="Tailscale (opcional)"
          footer="Para servidores en tu red de Tailscale. Impala enciende la VPN al abrirse y la apaga al cerrarla, o al quedar minimizada sin reproducir. Mientras suena música sigue encendida."
        >
          <View className="flex-row items-center justify-between ml-4 pr-4 py-2">
            <Text className="text-foreground text-base flex-1">Encender y apagar automáticamente</Text>
            <Switch
              value={manageTailscale}
              trackColor={{ true: accent }}
              thumbColor="#ffffff"
              onValueChange={(v) => {
                ImpalaPlayer.setManageTailscale(v);
                setManageTailscale(v);
              }}
            />
          </View>
        </Group>
      )}

      {source.capabilities.offlineDownloads && (
        <Group title="Descargas" footer={Paths.availableDiskSpace > 0 ? `Espacio libre en el ${DEVICE}: ${formatBytes(Paths.availableDiskSpace)}` : undefined}>
          <Item label="Guardadas" value={`${songCount(downloadedCount)} · ${formatBytes(totalBytes(offlineIndex))}`} last={downloadedCount === 0} />
          {downloadedCount > 0 && (
            <Pressable onPress={confirmRemoveDownloads} className="active:opacity-60">
              <Text className="text-accent text-base ml-4 py-3">Eliminar todas las descargas</Text>
            </Pressable>
          )}
        </Group>
      )}

      {isTauri() && <WindowSettings />}

      <Group title="Acerca de">
        <Item label="Impala" value={Constants.expoConfig?.version ?? ''} last={!canUpdate} />
        {canUpdate && (
          <Pressable onPress={() => void checkForUpdates(true)} className="active:opacity-60">
            <Text className="text-accent text-base ml-4 py-3">Buscar actualizaciones</Text>
          </Pressable>
        )}
      </Group>

      {session && (
        <View className="mx-5 mt-8 rounded-xl bg-card overflow-hidden">
          <Pressable onPress={confirmSignOut} className="py-3.5 items-center active:opacity-60">
            <Text className="text-accent text-base">Cerrar sesión del servidor</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

/** "Music/Impala/" → "Music/Impala" */
const folderLabel = (path: string) => path.replace(/\/$/, '') || 'Almacenamiento interno';

/**
 * Carpetas de las que sale la música del teléfono (cada una con sus subcarpetas). Se eligen entre las
 * que contienen audio según Android, más sus carpetas superiores (p. ej. "Music" para todo lo de dentro).
 */
function LocalFolders({ songs }: { songs: string }) {
  const folders = useLocalFolders();
  const [editing, setEditing] = useState(false);
  const available = useQuery({
    queryKey: ['local', 'folders'],
    enabled: editing,
    queryFn: async () => {
      const counts = new Map<string, number>([[DEFAULT_FOLDER, 0]]);
      // En PC se buscan en Música y en las ya elegidas (Android las conoce todas por su índice).
      for (const { path, count } of await (ImpalaLibrary.getFolders as (extra?: string[]) => Promise<{ path: string; count: number }[]>)(folders)) {
        // Android/media: sonidos y audios internos de otras apps (notificaciones de Gmail, WhatsApp…).
        if (path.startsWith('Android/')) continue;
        const parts = path.split('/').filter(Boolean);
        // La canción cuenta en su carpeta y en todas las superiores (las subcarpetas van incluidas).
        for (let i = 1; i <= parts.length; i++) {
          const prefix = `${parts.slice(0, i).join('/')}/`;
          counts.set(prefix, (counts.get(prefix) ?? 0) + count);
        }
      }
      return [...counts].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path));
    },
  });

  function toggle(path: string) {
    const next = folders.includes(path) ? folders.filter((f) => f !== path) : [...folders, path];
    if (next.length === 0) {
      Alert.alert('Elige al menos una carpeta', 'Impala necesita alguna carpeta de la que leer la música.');
      return;
    }
    updateLocalData(() => ({ folders: next }));
    void refreshLocalLibrary();
  }

  const insideSelected = (path: string) => folders.some((f) => f !== path && path.startsWith(f));

  // Solo en PC: cualquier carpeta del equipo (otro disco, una carpeta fuera de Música…).
  const pickOther = (ImpalaLibrary as { pickFolder?: () => Promise<string | null> }).pickFolder;
  async function addOther() {
    const path = await pickOther?.().catch(() => null);
    if (!path || folders.includes(path)) return;
    updateLocalData(() => ({ folders: [...folders, path] }));
    void refreshLocalLibrary();
    void available.refetch();
  }

  return (
    <Group title="Este dispositivo" footer="Se incluyen las subcarpetas. Copia música a estas carpetas y aparecerá sola en la biblioteca.">
      <Item label="Canciones" value={songs} />
      {folders.map((f) => (
        <Item key={f} label="Carpeta" value={folderLabel(f)} />
      ))}
      {editing &&
        (available.data ?? []).map((f) => {
          const depth = f.path.split('/').filter(Boolean).length - 1;
          const selected = folders.includes(f.path);
          const included = !selected && insideSelected(f.path);
          return (
            <Option
              key={f.path}
              label={`${'   '.repeat(depth)}${folderLabel(f.path).split('/').pop()}`}
              detail={`${folderLabel(f.path)} · ${songCount(f.count)}${included ? ' · ya incluida' : ''}`}
              selected={selected}
              onPress={() => toggle(f.path)}
            />
          );
        })}
      {editing && pickOther && (
        <Pressable onPress={addOther} className="active:opacity-60">
          <Text className="text-accent text-base ml-4 py-3">Añadir otra carpeta…</Text>
        </Pressable>
      )}
      <Pressable onPress={() => setEditing(!editing)} className="active:opacity-60">
        <Text className="text-accent text-base ml-4 py-3">{editing ? 'Listo' : 'Elegir carpetas…'}</Text>
      </Pressable>
    </Group>
  );
}

/** Solo en la app de PC: qué hace el botón de cerrar la ventana (lo guarda la parte en Rust, desktop.rs). */
function WindowSettings() {
  const accent = useThemeColor('accent');
  const closeToTray = useQuery({ queryKey: ['desktop', 'closeToTray'], queryFn: () => invoke<boolean>('get_close_to_tray') });
  const queryClient = useQueryClient();
  return (
    <Group
      title="Ventana"
      footer="Con la opción activada, al cerrar la ventana Impala sigue sonando en la bandeja del sistema (junto al reloj). Para salir del todo: clic derecho en su icono → Salir de Impala."
    >
      <View className="flex-row items-center justify-between ml-4 pr-4 py-2">
        <Text className="text-foreground text-base flex-1">Al cerrar, seguir en la bandeja</Text>
        <Switch
          value={closeToTray.data ?? true}
          trackColor={{ true: accent }}
          thumbColor="#ffffff"
          onValueChange={(enabled) => {
            queryClient.setQueryData(['desktop', 'closeToTray'], enabled);
            invoke('set_close_to_tray', { enabled }).catch(() => closeToTray.refetch());
          }}
        />
      </View>
    </Group>
  );
}

function Group({ title, footer, children }: { title: string; footer?: string; children: React.ReactNode }) {
  return (
    <View className="mt-6">
      <Text className="text-muted text-xs font-semibold uppercase px-9 mb-1.5">{title}</Text>
      <View className="mx-5 rounded-xl bg-card overflow-hidden">{children}</View>
      {footer && <Text className="text-muted text-xs px-9 mt-1.5">{footer}</Text>}
    </View>
  );
}

function Option(props: { label: string; detail: string; selected: boolean; last?: boolean; onPress: () => void }) {
  const accent = useThemeColor('accent');
  return (
    <Pressable onPress={props.onPress} className="active:opacity-60">
      <View className={`flex-row items-center ml-4 pr-4 py-2.5 ${props.last ? '' : 'border-b border-separator'}`}>
        <View className="flex-1">
          <Text className="text-foreground text-base">{props.label}</Text>
          <Text className="text-muted text-xs">{props.detail}</Text>
        </View>
        {props.selected && <Ionicons name="checkmark" size={20} color={accent} />}
      </View>
    </Pressable>
  );
}

/** Fila de fichas para elegir un valor (p. ej. un porcentaje). */
function Chips<T extends number>({ options, selected, onSelect }: { options: { value: T; label: string }[]; selected: number; onSelect: (value: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
      {options.map((o) => {
        const active = o.value === selected;
        return (
          <Pressable
            key={o.value}
            onPress={() => onSelect(o.value)}
            className={`rounded-full px-3.5 py-1.5 ${active ? 'bg-accent' : 'bg-background active:opacity-60'}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text className={`text-sm font-semibold ${active ? 'text-accent-foreground' : 'text-foreground'}`}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Item({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View className={`flex-row items-center justify-between ml-4 pr-4 py-3 ${last ? '' : 'border-b border-separator'}`}>
      <Text className="text-foreground text-base">{label}</Text>
      <Text className="text-muted text-base flex-shrink ml-4" numberOfLines={1}>{value}</Text>
    </View>
  );
}
