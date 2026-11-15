import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import {
  formatSemitones,
  formatSpeed,
  presetOf,
  SEMITONES_MAX,
  setTuning,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  TUNING_PRESETS,
  useTuning,
  type PlaybackTuning,
} from '@/player/tuning';
import { Artwork } from '../Artwork';
import { useThemeColor } from '../theme';
import { Panel } from './Sheets';
import { closeSheet, type SheetState } from './store';
import { Marquee } from '@/components/Marquee';

/**
 * Velocidad y tono de lo que suena: preajustes (Normal, Sped up, Slowed, Slowed + reverb), el modo de tono
 * (natural o vinilo) y ajuste fino con botones. Cada toque se oye al momento.
 */
export function TuningSheet({ songId, title, coverArt }: Extract<SheetState, { kind: 'tuning' }>) {
  const accent = useThemeColor('accent');
  const t = useTuning(songId);
  const preset = presetOf(t);
  const update = (patch: Partial<PlaybackTuning>, perSong = t.perSong) => setTuning(songId, { ...t, ...patch }, perSong);

  return (
    <Panel>
      <View className="flex-row items-center px-5 pb-3 mb-2 border-b border-separator">
        <Artwork coverArt={coverArt} size={48} className="w-12 h-12 rounded-lg" />
        <View className="flex-1 ml-3">
          <Text className="text-foreground text-base font-semibold">Velocidad y tono</Text>
          <Marquee className="text-muted text-sm">{title}</Marquee>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingBottom: 4 }}>
        {TUNING_PRESETS.map((p) => (
          <Chip
            key={p.id}
            label={p.label}
            active={preset?.id === p.id}
            onPress={() => update(p.id === 'normal' ? { speed: 1, semitones: 0, reverb: false } : { speed: p.speed, semitones: 0, reverb: p.reverb })}
          />
        ))}
        <Chip label="Personalizado" active={!preset} onPress={() => {}} />
      </ScrollView>

      <Text className="text-muted text-xs font-semibold uppercase px-5 mt-4 mb-2">Tono</Text>
      <View className="flex-row mx-5 rounded-xl bg-background p-1">
        {[
          { vinyl: false, label: 'Natural', hint: 'El tono no cambia' },
          { vinyl: true, label: 'Vinilo', hint: 'Sube y baja con la velocidad' },
        ].map((m) => {
          const active = t.vinyl === m.vinyl;
          return (
            <Pressable key={m.label} onPress={() => update({ vinyl: m.vinyl })} className={`flex-1 rounded-lg py-2 items-center ${active ? 'bg-accent' : ''}`}>
              <Text className={`text-sm font-semibold ${active ? 'text-accent-foreground' : 'text-foreground'}`}>{m.label}</Text>
              <Text className={`text-xs ${active ? 'text-accent-foreground' : 'text-muted'}`}>{m.hint}</Text>
            </Pressable>
          );
        })}
      </View>

      <Stepper
        label="Velocidad"
        value={formatSpeed(t.speed)}
        onMinus={t.speed > SPEED_MIN + 0.001 ? () => update({ speed: t.speed - SPEED_STEP }) : undefined}
        onPlus={t.speed < SPEED_MAX - 0.001 ? () => update({ speed: t.speed + SPEED_STEP }) : undefined}
      />
      <Stepper
        label={t.vinyl ? 'Tono extra' : 'Tono'}
        value={formatSemitones(t.semitones)}
        onMinus={t.semitones > -SEMITONES_MAX ? () => update({ semitones: t.semitones - 1 }) : undefined}
        onPlus={t.semitones < SEMITONES_MAX ? () => update({ semitones: t.semitones + 1 }) : undefined}
      />
      <SwitchRow label="Reverberación" value={t.reverb} accent={accent} onChange={(reverb) => update({ reverb })} />
      <SwitchRow
        label="Recordar solo para esta canción"
        hint={t.perSong ? 'Las demás usan el ajuste general' : 'Se aplica a todas las canciones'}
        value={t.perSong}
        accent={accent}
        onChange={(perSong) => update({}, perSong)}
      />

      <View className="px-5 mt-3">
        <Pressable onPress={closeSheet} className="rounded-xl py-3 items-center bg-accent active:opacity-80">
          <Text className="text-accent-foreground text-base font-semibold">Listo</Text>
        </Pressable>
      </View>
    </Panel>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className={`rounded-full px-4 py-2 active:opacity-70 ${active ? 'bg-accent' : 'bg-background'}`}>
      <Text className={`text-sm font-semibold ${active ? 'text-accent-foreground' : 'text-foreground'}`}>{label}</Text>
    </Pressable>
  );
}

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: string; onMinus?: () => void; onPlus?: () => void }) {
  const foreground = useThemeColor('foreground');
  const muted = useThemeColor('muted');
  const button = (icon: 'remove' | 'add', onPress?: () => void) => (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      className="w-10 h-10 rounded-full bg-background items-center justify-center active:opacity-60"
      accessibilityLabel={`${icon === 'add' ? 'Subir' : 'Bajar'} ${label.toLowerCase()}`}
    >
      <Ionicons name={icon} size={20} color={onPress ? foreground : muted} />
    </Pressable>
  );
  return (
    <View className="flex-row items-center px-5 mt-3">
      <Text className="text-foreground text-base flex-1">{label}</Text>
      {button('remove', onMinus)}
      <Text className="text-foreground text-base font-semibold w-20 text-center">{value}</Text>
      {button('add', onPlus)}
    </View>
  );
}

function SwitchRow({ label, hint, value, accent, onChange }: { label: string; hint?: string; value: boolean; accent: string; onChange: (v: boolean) => void }) {
  return (
    <View className="flex-row items-center px-5 mt-3">
      <View className="flex-1">
        <Text className="text-foreground text-base">{label}</Text>
        {hint ? <Text className="text-muted text-xs">{hint}</Text> : null}
      </View>
      <Switch value={value} trackColor={{ true: accent }} thumbColor="#ffffff" onValueChange={onChange} />
    </View>
  );
}
