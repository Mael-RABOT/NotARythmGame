/**
 * Procedural sounds. No audio assets ship with the game: every hitsound, UI blip
 * and the demo track are rendered once with an OfflineAudioContext.
 * The instrument functions take any BaseAudioContext so the demo song reuses them.
 */

export type SfxName =
  | 'don' | 'ka' | 'big' | 'mash' | 'roll' | 'mine' | 'collect' | 'holdBreak'
  | 'metroHi' | 'metroLo' | 'uiHover' | 'uiConfirm' | 'uiBack' | 'uiToggle' | 'countdown' | 'go';

type Ctx = BaseAudioContext;

const noiseBuffers = new WeakMap<Ctx, AudioBuffer>();
const noise = (ctx: Ctx): AudioBuffer => {
  let buf = noiseBuffers.get(ctx);
  if (!buf) {
    buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 1337;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = seed / 2147483648 - 1;
    }
    noiseBuffers.set(ctx, buf);
  }
  return buf;
};

const env = (ctx: Ctx, t: number, attack: number, decay: number, peak: number, dest: AudioNode): GainNode => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
};

// ---------------------------------------------------------------- instruments
export const kick = (ctx: Ctx, t: number, dest: AudioNode, vol = 1, pitch = 1): void => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(160 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(48 * pitch, t + 0.11);
  o.connect(env(ctx, t, 0.002, 0.32, vol, dest));
  o.start(t);
  o.stop(t + 0.4);
  // click transient
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 3000;
  n.connect(f).connect(env(ctx, t, 0.001, 0.02, vol * 0.4, dest));
  n.start(t, Math.random() * 0.5, 0.05);
};

export const snare = (ctx: Ctx, t: number, dest: AudioNode, vol = 1): void => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 2200;
  f.Q.value = 0.7;
  n.connect(f).connect(env(ctx, t, 0.001, 0.18, vol * 0.8, dest));
  n.start(t, 0.1, 0.3);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(240, t);
  o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
  o.connect(env(ctx, t, 0.001, 0.1, vol * 0.5, dest));
  o.start(t);
  o.stop(t + 0.2);
};

export const hat = (ctx: Ctx, t: number, dest: AudioNode, vol = 1, open = false): void => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 7000;
  n.connect(f).connect(env(ctx, t, 0.001, open ? 0.22 : 0.045, vol * 0.35, dest));
  n.start(t, 0.3, 0.3);
};

export const crash = (ctx: Ctx, t: number, dest: AudioNode, vol = 1): void => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = 4000;
  n.connect(f).connect(env(ctx, t, 0.002, 1.6, vol * 0.3, dest));
  n.start(t, 0, 1);
};

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export const bass = (ctx: Ctx, t: number, dur: number, midi: number, dest: AudioNode, vol = 1): void => {
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = midiHz(midi);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 6;
  f.frequency.setValueAtTime(1400, t);
  f.frequency.exponentialRampToValueAtTime(180, t + Math.min(0.25, dur));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol * 0.45, t + 0.005);
  g.gain.setValueAtTime(vol * 0.45, t + dur * 0.8);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
};

export const pluck = (ctx: Ctx, t: number, midi: number, dest: AudioNode, vol = 1, decay = 0.22): void => {
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.value = midiHz(midi);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(5000, t);
  f.frequency.exponentialRampToValueAtTime(600, t + decay);
  o.connect(f).connect(env(ctx, t, 0.002, decay, vol * 0.16, dest));
  o.start(t);
  o.stop(t + decay + 0.05);
};

export const pad = (ctx: Ctx, t: number, dur: number, midis: number[], dest: AudioNode, vol = 1): void => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol * 0.06, t + Math.min(0.6, dur / 3));
  g.gain.setValueAtTime(vol * 0.06, t + dur * 0.7);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1800;
  f.connect(g).connect(dest);
  for (const m of midis) {
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiHz(m);
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
};

const blip = (ctx: Ctx, t: number, f0: number, f1: number, dur: number, vol: number, dest: AudioNode, type: OscillatorType = 'sine'): void => {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.connect(env(ctx, t, 0.002, dur, vol, dest));
  o.start(t);
  o.stop(t + dur + 0.05);
};

// ---------------------------------------------------------------- sfx bank
const SFX: Record<SfxName, [number, (ctx: Ctx, out: AudioNode) => void]> = {
  don: [0.35, (c, o) => kick(c, 0, o, 0.9, 1.15)],
  ka: [0.12, (c, o) => {
    blip(c, 0, 1900, 1200, 0.05, 0.35, o, 'triangle');
    hat(c, 0, o, 1.4);
  }],
  big: [0.45, (c, o) => {
    kick(c, 0, o, 1, 1.0);
    snare(c, 0, o, 0.6);
  }],
  mash: [0.1, (c, o) => blip(c, 0, 900, 700, 0.06, 0.4, o, 'square')],
  roll: [0.08, (c, o) => blip(c, 0, 1300, 1000, 0.04, 0.25, o, 'triangle')],
  mine: [0.35, (c, o) => {
    blip(c, 0, 110, 55, 0.3, 0.6, o, 'square');
    const n = c.createBufferSource();
    n.buffer = noise(c);
    n.connect(env(c, 0, 0.002, 0.2, 0.3, o));
    n.start(0, 0, 0.3);
  }],
  collect: [0.45, (c, o) => {
    blip(c, 0, 1318, 1318, 0.18, 0.25, o);
    blip(c, 0.06, 1760, 1760, 0.3, 0.22, o);
  }],
  holdBreak: [0.3, (c, o) => blip(c, 0, 400, 90, 0.25, 0.3, o, 'sawtooth')],
  metroHi: [0.06, (c, o) => blip(c, 0, 1760, 1760, 0.035, 0.5, o)],
  metroLo: [0.06, (c, o) => blip(c, 0, 1175, 1175, 0.035, 0.4, o)],
  uiHover: [0.04, (c, o) => blip(c, 0, 2600, 2400, 0.018, 0.12, o)],
  uiConfirm: [0.16, (c, o) => {
    blip(c, 0, 880, 880, 0.05, 0.2, o, 'triangle');
    blip(c, 0.05, 1320, 1320, 0.09, 0.2, o, 'triangle');
  }],
  uiBack: [0.14, (c, o) => {
    blip(c, 0, 990, 990, 0.05, 0.18, o, 'triangle');
    blip(c, 0.05, 660, 660, 0.07, 0.18, o, 'triangle');
  }],
  uiToggle: [0.06, (c, o) => blip(c, 0, 1500, 1800, 0.035, 0.18, o, 'triangle')],
  countdown: [0.2, (c, o) => blip(c, 0, 1046, 1046, 0.12, 0.3, o, 'triangle')],
  go: [0.4, (c, o) => {
    blip(c, 0, 1568, 1568, 0.3, 0.3, o, 'triangle');
    blip(c, 0, 2093, 2093, 0.3, 0.15, o, 'sine');
  }],
};

export const renderSfxBank = async (sampleRate: number): Promise<Record<SfxName, AudioBuffer>> => {
  const entries = await Promise.all(
    (Object.keys(SFX) as SfxName[]).map(async (name) => {
      const [dur, build] = SFX[name];
      const ctx = new OfflineAudioContext(1, Math.ceil(sampleRate * dur), sampleRate);
      build(ctx, ctx.destination);
      return [name, await ctx.startRendering()] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<SfxName, AudioBuffer>;
};

// ---------------------------------------------------------------- WAV export
/** Encodes an AudioBuffer as 16-bit PCM WAV (used to package generated audio) */
export const encodeWav = (buffer: AudioBuffer, maxChannels = 2): Uint8Array => {
  const ch = Math.min(maxChannels, buffer.numberOfChannels);
  const len = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  out.setUint32(4, 36 + len * ch * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  w(36, 'data');
  out.setUint32(40, len * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
};
