/**
 * El grafo de Web Audio del reproductor de PC:
 *
 *   <audio> → tono (semitonos) ─┬─ seco ──────────────┬→ volumen del deck (fundidos) ┐
 *                               └─ reverb → húmedo ───┘                              │
 *   (dos decks: el que suena y el que tiene la siguiente cargada)                     ↓
 *                                         potenciador → limitador → volumen de la app → altavoces
 *
 * La velocidad la hace el propio <audio> (playbackRate; preservesPitch conserva el tono salvo en «vinilo»).
 * Los semitonos extra, un desplazador de tono propio en un AudioWorklet (solo procesa si hay semitonos).
 */

let context: AudioContext | null = null;
let master: { input: GainNode; boost: GainNode; limiter: DynamicsCompressorNode; volume: GainNode } | null = null;
let workletReady: Promise<boolean> | null = null;
let reverbImpulse: AudioBuffer | null = null;

export function audioContext(): AudioContext {
  if (!context) {
    context = new AudioContext({ latencyHint: 'playback' });
    workletReady = loadPitchWorklet(context);
  }
  return context;
}

/** El navegador arranca el AudioContext suspendido hasta que hay un gesto del usuario. */
export async function resumeAudio() {
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
}

function masterChain() {
  if (master) return master;
  const ctx = audioContext();
  const input = ctx.createGain();
  const boost = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const volume = ctx.createGain();
  input.connect(boost).connect(limiter).connect(volume).connect(ctx.destination);
  master = { input, boost, limiter, volume };
  return master;
}

/**
 * Potenciador (como el LoudnessEnhancer de Android): ganancia en dB y un limitador que evita el recorte
 * digital. Sin potenciar, el limitador queda neutro.
 */
export function setBoostDb(db: number) {
  const m = masterChain();
  const now = audioContext().currentTime;
  m.boost.gain.setTargetAtTime(Math.pow(10, db / 20), now, 0.05);
  const on = db > 0;
  m.limiter.threshold.setValueAtTime(on ? -1 : 0, now);
  m.limiter.ratio.setValueAtTime(on ? 20 : 1, now);
  m.limiter.knee.setValueAtTime(on ? 0 : 0, now);
  m.limiter.attack.setValueAtTime(0.003, now);
  m.limiter.release.setValueAtTime(0.25, now);
}

export function setAppVolume(volume: number) {
  masterChain().volume.gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), audioContext().currentTime, 0.05);
}

/** Lo que cada <audio> necesita: tono, reverb y su volumen para los fundidos. */
export type DeckChain = {
  /** 1 = sin cambio de tono. */
  setPitchRatio(ratio: number): void;
  /** 0 = apagada, 1 = máxima. */
  setReverb(amount: number): void;
  gain: GainNode;
};

export function connectDeck(audio: HTMLAudioElement): DeckChain {
  const ctx = audioContext();
  const source = ctx.createMediaElementSource(audio);
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const gain = ctx.createGain();
  const convolver = ctx.createConvolver();
  convolver.buffer = impulse(ctx);
  wet.gain.value = 0;
  dry.connect(gain);
  convolver.connect(wet).connect(gain);
  gain.connect(masterChain().input);

  // Hasta que carga el desplazador de tono, el audio va directo.
  let pitch: AudioWorkletNode | null = null;
  let pendingRatio = 1;
  const route = (node: AudioNode) => {
    node.connect(dry);
    node.connect(convolver);
  };
  route(source);
  void workletReady?.then((ok) => {
    if (!ok) return;
    pitch = new AudioWorkletNode(ctx, 'impala-pitch', { outputChannelCount: [2] });
    pitch.parameters.get('ratio')!.value = pendingRatio;
    source.disconnect();
    source.connect(pitch);
    route(pitch);
  });

  return {
    gain,
    setPitchRatio(ratio) {
      pendingRatio = ratio;
      pitch?.parameters.get('ratio')!.setValueAtTime(ratio, ctx.currentTime);
    },
    setReverb(amount) {
      const now = ctx.currentTime;
      const a = Math.min(1, Math.max(0, amount));
      // Como en Android: húmedo = cantidad^1,5 y el seco solo baja (hasta 0,85) en la mitad alta.
      wet.gain.setTargetAtTime(0.5 * Math.pow(a, 1.5), now, 0.08);
      dry.gain.setTargetAtTime(1 - 0.15 * Math.max(0, (a - 0.5) / 0.5), now, 0.08);
    },
  };
}

/** Respuesta al impulso de una sala grande: ruido con caída de ~3,2 s y agudos que se apagan antes. */
function impulse(ctx: AudioContext): AudioBuffer {
  if (reverbImpulse) return reverbImpulse;
  const seconds = 3.2;
  const preDelay = Math.floor(0.04 * ctx.sampleRate);
  const length = Math.floor(seconds * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / ctx.sampleRate;
      const decay = Math.exp((-6.9 * t) / seconds);
      // Filtro paso bajo cada vez más cerrado: la cola suena más oscura, como una sala real.
      const damping = Math.min(0.97, 0.2 + t * 0.4);
      low = low * damping + (Math.random() * 2 - 1) * (1 - damping);
      data[i] = low * decay;
    }
  }
  reverbImpulse = buffer;
  return buffer;
}

/**
 * Desplazador de tono por línea de retardo: dos lecturas que se deslizan a distinta velocidad que la escritura,
 * desfasadas medio ciclo y cruzadas con ventanas que suman 1. Con ratio 1 copia la entrada tal cual.
 */
const PITCH_WORKLET = `
class ImpalaPitch extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4 }]; }
  constructor() {
    super();
    this.size = 16384;
    this.window = Math.round(sampleRate * 0.06);
    this.buffers = [new Float32Array(this.size), new Float32Array(this.size)];
    this.write = 0;
    this.phase = 0;
  }
  read(buf, delay) {
    const pos = this.write - delay;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = buf[(i % this.size + this.size) % this.size];
    const b = buf[((i + 1) % this.size + this.size) % this.size];
    return a + (b - a) * frac;
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const ratio = parameters.ratio[0];
    const frames = output[0].length;
    const channels = output.length;
    if (!input || input.length === 0) return true;
    if (Math.abs(ratio - 1) < 1e-4) {
      for (let c = 0; c < channels; c++) output[c].set(input[Math.min(c, input.length - 1)]);
      this.phase = 0;
      return true;
    }
    const step = (1 - ratio) / this.window;
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < 2; c++) this.buffers[c][this.write % this.size] = input[Math.min(c, input.length - 1)][n];
      this.phase = ((this.phase + step) % 1 + 1) % 1;
      const p2 = (this.phase + 0.5) % 1;
      const w1 = Math.sin(Math.PI * this.phase) ** 2;
      const w2 = 1 - w1;
      const d1 = this.phase * this.window + 1;
      const d2 = p2 * this.window + 1;
      for (let c = 0; c < channels; c++) {
        const buf = this.buffers[Math.min(c, 1)];
        output[c][n] = this.read(buf, d1) * w1 + this.read(buf, d2) * w2;
      }
      this.write++;
    }
    return true;
  }
}
registerProcessor('impala-pitch', ImpalaPitch);
`;

async function loadPitchWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    const url = URL.createObjectURL(new Blob([PITCH_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    return true;
  } catch (e) {
    console.warn('Sin cambio de tono por semitonos (AudioWorklet no disponible):', e);
    return false;
  }
}
