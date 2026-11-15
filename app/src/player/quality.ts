import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import ImpalaPlayer from '../../modules/impala-player';
import type { StreamQuality } from '@/sources';

export type QualityPreference = 'auto' | StreamQuality;

const KEY = 'impala.quality';
let cached: QualityPreference | null = null;
const listeners = new Set<(p: QualityPreference) => void>();

export async function getQualityPreference(): Promise<QualityPreference> {
  if (cached) return cached;
  const stored = await SecureStore.getItemAsync(KEY).catch(() => null);
  cached = stored === 'original' || stored === 'ahorro' ? stored : 'auto';
  return cached;
}

export async function setQualityPreference(pref: QualityPreference) {
  cached = pref;
  listeners.forEach((l) => l(pref));
  await SecureStore.setItemAsync(KEY, pref);
}

export function useQualityPreference(): QualityPreference {
  const [pref, setPref] = useState<QualityPreference>(cached ?? 'auto');
  useEffect(() => {
    getQualityPreference().then(setPref);
    listeners.add(setPref);
    return () => void listeners.delete(setPref);
  }, []);
  return pref;
}

/** Automático: original en redes sin límite (Wi-Fi), ahorro en redes de pago por uso (datos móviles). */
export async function resolveQuality(): Promise<StreamQuality> {
  const pref = await getQualityPreference();
  if (pref !== 'auto') return pref;
  return ImpalaPlayer.getNetworkInfo().metered ? 'ahorro' : 'original';
}
