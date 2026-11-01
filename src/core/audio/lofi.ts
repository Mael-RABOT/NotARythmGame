/**
 * Lo-fi instrument set for the built-in demo track. Everything is synthesized
 * into an OfflineAudioContext: FM electric piano, soft drums, sub bass with
 * glide, a breathy lead, and vinyl/tape artefacts.
 *
 * Tape wow & flutter is one ConstantSourceNode per render whose offset follows
 * a curve computed from *absolute song time*, connected to the detune of every
 * pitched oscillator, so chunks rendered in parallel stay phase-continuous.
 */
type Ctx = BaseAudioContext;

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Small deterministic PRNG (mulberry32) */
export const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const noiseBufs = new WeakMap<Ctx, AudioBuffer>();
const noise = (ctx: Ctx): AudioBuffer => {
  let b = noiseBufs.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    const r = prng(77);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    noiseBufs.set(ctx, b);
  }
  return b;
};

const adsr = (ctx: Ctx, t: number, a: number, peak: number, decayTo: number, decayTau: number, end: number, release: number, dest: AudioNode): GainNode => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setTargetAtTime(peak * decayTo, t + a, decayTau);
  g.gain.setTargetAtTime(0, end, release / 4);
  g.connect(dest);
  return g;
};

const perc = (ctx: Ctx, t: number, attack: number, decay: number, peak: number, dest: AudioNode): GainNode => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
};

/** Everything an instrument needs from one render context */
export interface Rig {
  ctx: Ctx;
  drums: AudioNode;
  keys: AudioNode;
  bass: AudioNode;
  lead: AudioNode;
  /** wow/flutter in cents, connect to oscillator.detune */
  wow: AudioNode;
}

// ---------------------------------------------------------------- drums
export const softKick = ({ ctx, drums }: Rig, t: number, vol = 1): void => {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(118, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
  o.connect(perc(ctx, t, 0.003, 0.38, vol * 0.95, drums));
  o.start(t);
  o.stop(t + 0.45);
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 1400;
  n.connect(f).connect(perc(ctx, t, 0.001, 0.025, vol * 0.18, drums));
  n.start(t, 0.2, 0.05);
};

export const dustySnare = ({ ctx, drums }: Rig, t: number, vol = 1): void => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 0.8;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  n.connect(bp).connect(lp).connect(perc(ctx, t, 0.002, 0.17, vol * 0.62, drums));
  n.start(t, 0.37 + (t % 0.1), 0.3);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.setValueAtTime(205, t);
  o.frequency.exponentialRampToValueAtTime(162, t + 0.07);
  o.connect(perc(ctx, t, 0.001, 0.09, vol * 0.32, drums));
  o.start(t);
  o.stop(t + 0.15);
};

export const rim = ({ ctx, drums }: Rig, t: number, vol = 1): void => {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 1750;
  o.connect(perc(ctx, t, 0.001, 0.025, vol * 0.25, drums));
  o.start(t);
  o.stop(t + 0.06);
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 3400;
  f.Q.value = 2;
  n.connect(f).connect(perc(ctx, t, 0.001, 0.02, vol * 0.4, drums));
  n.start(t, 0.6, 0.05);
};

export const lofiHat = ({ ctx, drums }: Rig, t: number, vol = 1, open = false): void => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 10500;
  n.connect(hp).connect(lp).connect(perc(ctx, t, 0.001, open ? 0.2 : 0.032, vol * 0.2, drums));
  n.start(t, (t * 7.31) % 0.6, 0.3);
};

// ---------------------------------------------------------------- pitched
/** Rhodes-ish FM voice: carrier + 1:1 modulator with a decaying index, plus a tine ping */
export const ePiano = ({ ctx, keys, wow }: Rig, t: number, dur: number, midi: number, vol = 1): void => {
  const f = midiHz(midi);
  const end = t + dur;
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f;
  const idx = ctx.createGain();
  idx.gain.setValueAtTime(f * 2.1 * Math.min(1.2, vol), t);
  idx.gain.setTargetAtTime(f * 0.35, t, 0.25);
  mod.connect(idx).connect(car.frequency);
  const amp = adsr(ctx, t, 0.004, vol * 0.085, 0.35, 0.9, end, 0.25, keys);
  car.connect(amp);
  const tine = ctx.createOscillator();
  tine.frequency.value = f * 4.02;
  tine.connect(perc(ctx, t, 0.001, 0.12, vol * 0.012, keys));
  for (const o of [car, mod, tine]) {
    wow.connect(o.detune);
    o.start(t);
    o.stop(end + 0.4);
  }
};

/** Warm sub bass; `fromMidi` glides into the note */
export const subBass = ({ ctx, bass, wow }: Rig, t: number, dur: number, midi: number, vol = 1, fromMidi?: number): void => {
  const f = midiHz(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 520;
  const amp = adsr(ctx, t, 0.012, vol * 0.42, 0.75, 0.6, t + dur, 0.06, bass);
  lp.connect(amp);
  const oscs = [ctx.createOscillator(), ctx.createOscillator()];
  oscs[1].type = 'triangle';
  oscs.forEach((o, i) => {
    const target = f * (i ? 2 : 1);
    if (fromMidi !== undefined) {
      o.frequency.setValueAtTime(midiHz(fromMidi) * (i ? 2 : 1), t);
      o.frequency.exponentialRampToValueAtTime(target, t + 0.07);
    } else o.frequency.value = target;
    const g = ctx.createGain();
    g.gain.value = i ? 0.22 : 1;
    o.connect(g).connect(lp);
    wow.connect(o.detune);
    o.start(t);
    o.stop(t + dur + 0.1);
  });
};

/** Soft triangle/sine lead with delayed vibrato and a little scoop into long notes */
export const softLead = ({ ctx, lead, wow }: Rig, t: number, dur: number, midi: number, vol = 1): void => {
  const f = midiHz(midi);
  const end = t + dur * 0.92;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  const amp = adsr(ctx, t, 0.028, vol * 0.14, 0.8, 0.5, end, 0.14, lead);
  lp.connect(amp);
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.1;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.setValueAtTime(0, t + 0.22);
  depth.gain.linearRampToValueAtTime(dur > 0.4 ? 16 : 4, t + 0.6);
  vib.connect(depth);
  vib.start(t);
  vib.stop(end + 0.2);
  [['triangle', 1, 1], ['sine', 2, 0.18]].forEach(([type, mul, gain]) => {
    const o = ctx.createOscillator();
    o.type = type as OscillatorType;
    if (dur > 0.5) {
      o.frequency.setValueAtTime(f * (mul as number) * 0.97, t);
      o.frequency.exponentialRampToValueAtTime(f * (mul as number), t + 0.06);
    } else o.frequency.value = f * (mul as number);
    const g = ctx.createGain();
    g.gain.value = gain as number;
    o.connect(g).connect(lp);
    depth.connect(o.detune);
    wow.connect(o.detune);
    o.start(t);
    o.stop(end + 0.2);
  });
};

// ---------------------------------------------------------------- texture
/** Vinyl bed (hiss + pops) for [0, sec) of this context, seeded per chunk */
export const vinyl = (ctx: Ctx, dest: AudioNode, sec: number, seed: number, vol = 1): void => {
  const len = Math.ceil(sec * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const r = prng(seed);
  for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * 0.0035;
  const pops = Math.round(sec * 7);
  for (let p = 0; p < pops; p++) {
    const at = Math.floor(r() * len);
    const big = r() < 0.15;
    const amp = (big ? 0.12 : 0.025) * (0.4 + r());
    const decay = big ? 40 : 8;
    for (let k = 0; k < decay * 4 && at + k < len; k++) d[at + k] += amp * Math.exp(-k / decay) * (k % 2 ? -1 : 1);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(hp).connect(g).connect(dest);
  src.start(0);
};

/** Tape wow (slow) + flutter (fast) + optional tape-stop, in cents, at absolute song time */
export const wowCents = (sec: number, tapeStopAt = Infinity, tapeStopLen = 2): number => {
  let c = 7 * Math.sin(2 * Math.PI * 0.53 * sec) + 3 * Math.sin(2 * Math.PI * 0.21 * sec + 1.3) + 1.6 * Math.sin(2 * Math.PI * 6.1 * sec + 0.4);
  if (sec > tapeStopAt) {
    const x = Math.min(1, (sec - tapeStopAt) / tapeStopLen);
    c -= 2400 * x * x;
  }
  return c;
};
