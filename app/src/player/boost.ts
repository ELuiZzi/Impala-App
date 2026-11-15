import ImpalaPlayer from '../../modules/impala-player';
import { DEVICE } from '@/components/device';

/** Niveles del potenciador de volumen (LoudnessEnhancer en el reproductor nativo). */
export const BOOST_OPTIONS: { db: number; label: string; detail: string }[] = [
  { db: 0, label: 'Desactivado', detail: `Volumen normal del ${DEVICE}` },
  { db: 4, label: 'Suave · +4 dB', detail: 'Un poco más fuerte, sin cambiar el sonido' },
  { db: 8, label: 'Medio · +8 dB', detail: 'Notablemente más fuerte' },
  { db: 12, label: 'Fuerte · +12 dB', detail: 'Máximo: comprime los picos y puede saturar' },
];

export const getVolumeBoostDb = () => ImpalaPlayer.getVolumeBoostDb();
/** Se aplica al instante y se guarda en el teléfono. */
export const setVolumeBoostDb = (db: number) => ImpalaPlayer.setVolumeBoostDb(db);

/** "Desactivado", "+8 dB"… para mostrar el nivel actual en un menú. */
export function boostLabel(db: number): string {
  return db > 0 ? `+${db} dB` : 'Desactivado';
}
