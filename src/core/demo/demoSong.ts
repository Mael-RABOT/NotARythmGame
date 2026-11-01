import { dustySnare, ePiano, lofiHat, prng, rim, softKick, softLead, subBass, vinyl, wowCents, type Rig } from '../audio/lofi';
import { FORMAT_VERSION, PPQ, SPAN_TYPES, compareNotes, noteEnd, type Chart, type ChartEvent, type Lane, type Note } from '../chart/types';

/**
 * Built-in demo "Warmup Protocol": a lo-fi groove at 86 BPM, written out by hand
 * (progression, comping, bass line, melody) and synthesized at load time.
 *
 * One event table drives both the audio and the charts, so every charted note
 * sits on something you can hear. Charted parts stay on the straight grid;
 * swing and looser timing only touch the ghost notes and hats nobody has to hit.
 */
export const DEMO_ID = 'builtin-warmup';
const BPM = 86;
const BEAT = PPQ;
const BAR = PPQ * 4;
const S16 = PPQ / 4;
const BARS = 32;
const LEAD_MS = 1500; // silence before bar 1
const SEC_PER_TICK = 60 / (BPM * PPQ);
const BAR_SEC = BAR * SEC_PER_TICK;
const SWING_SEC = 0.18 * S16 * SEC_PER_TICK; // odd 16ths land ~30 ms late

// ---------------------------------------------------------------- harmony
// Dm9 → G13 → Cmaj9 → A7♭9, rootless voicings that move by step
const CHORDS = [
  { keys: [53, 57, 60, 64], root: 38, fifth: 45, approach: 42 }, // Dm9  (F A C E), F# leads to G
  { keys: [53, 57, 59, 64], root: 43, fifth: 50, approach: 37 }, // G13  (F A B E), C# leads to C
  { keys: [52, 55, 59, 62], root: 36, fifth: 43, approach: 34 }, // Cmaj9(E G B D), B♭ leads to A
  { keys: [52, 55, 58, 61], root: 33, fifth: 40, approach: 37 }, // A7♭9 (E G B♭ C#), C# leads to D
];
const chordOf = (bar: number) => CHORDS[bar % 4];

type Section = 'intro' | 'groove' | 'theme' | 'break' | 'reprise' | 'outro';
const sectionOf = (bar: number): Section =>
  bar < 4 ? 'intro' : bar < 12 ? 'groove' : bar < 20 ? 'theme' : bar < 24 ? 'break' : bar < 30 ? 'reprise' : 'outro';
const SECTIONS: [number, string][] = [[0, 'Intro'], [4, 'Groove'], [12, 'Theme'], [20, 'Break'], [24, 'Reprise'], [30, 'Outro']];

// ---------------------------------------------------------------- melody
/** [beat in bar, length in beats, midi] for the 8-bar theme: a 2-bar call, its answer, then a varied repeat */
const THEME: [number, number, number][][] = [
  [[1.5, 0.5, 69], [2, 0.5, 72], [2.5, 1.5, 76]],
  [[0, 0.5, 74], [0.5, 0.5, 72], [1, 1.5, 71], [3, 0.5, 67], [3.5, 0.5, 69]],
  [[0, 1.5, 71], [1.5, 0.5, 72], [2, 1, 74], [3, 1, 71]],
  [[0, 0.5, 70], [0.5, 0.5, 69], [1, 2, 73], [3.5, 0.5, 69]],
  [[0, 1, 74], [1.5, 0.5, 69], [2, 0.5, 72], [2.5, 1, 77], [3.5, 0.5, 76]],
  [[0, 0.5, 74], [0.5, 0.5, 72], [1, 1, 71], [2, 0.5, 72], [2.5, 0.5, 71], [3, 1, 67]],
  [[0, 0.5, 64], [0.5, 0.5, 67], [1, 0.5, 71], [1.5, 1.5, 74], [3.5, 0.5, 72]],
  [[0, 1, 73], [1, 0.5, 70], [1.5, 0.5, 69], [2, 1.5, 67]],
];
const BREAK_FRAGMENTS: Record<number, [number, number, number][]> = {
  20: [[1.5, 0.5, 69], [2, 0.5, 72], [2.5, 1.5, 76]],
  22: [[1.5, 0.5, 71], [2, 0.5, 72], [2.5, 1.5, 74]],
};

// ---------------------------------------------------------------- arrangement
type Role = 'kick' | 'snare' | 'ghost' | 'hat' | 'ohat' | 'rim' | 'fill' | 'keys' | 'bass' | 'lead';
interface Ev {
  t: number; // tick on the straight grid (what charts use)
  role: Role;
  vol: number;
  /** extra seconds: swing + humanizing (audio only) */
  nudge: number;
  dur?: number; // ticks
  midi?: number;
  chord?: number[];
  from?: number; // bass glide source
  /** keys hit placed before the bar line, belongs to the next chord */
  anticipation?: boolean;
}

const KEYS_PATTERNS: Record<'groove' | 'theme', [number, number, boolean?][][]> = {
  // [beat, length, anticipates next bar]
  groove: [
    [[0, 1.3], [1.5, 0.4], [2.5, 1.2]],
    [[0, 2], [3.5, 1.25, true]],
    [[0, 1.3], [1.5, 0.4], [2.5, 0.4], [3, 1]],
    [[0, 1.3], [2.5, 0.4], [3.5, 1.25, true]],
  ],
  theme: [
    [[0, 2.5], [3, 0.4]],
    [[0, 2.5], [3, 0.4]],
    [[0, 2.5], [3, 0.4]],
    [[0, 2], [3.5, 1.25, true]],
  ],
};

const buildArrangement = (): Ev[] => {
  const ev: Ev[] = [];
  const r = prng(86);
  const jit = (ms: number) => ((r() * 2 - 1) * ms) / 1000;
  const vary = (v: number, amount = 0.12) => v * (1 - amount / 2 + r() * amount);
  const swing = (pos16: number) => (pos16 % 2 ? SWING_SEC : 0);
  let anticipated = false;
  let lastApproach: number | undefined;

  for (let bar = 0; bar < BARS; bar++) {
    const s = sectionOf(bar);
    const t0 = bar * BAR;
    const ch = chordOf(bar);
    const next = chordOf(bar + 1);
    const at16 = (p: number) => t0 + p * S16;
    const drum = (role: Role, p: number, vol: number, loose = false) =>
      ev.push({ t: at16(p), role, vol: vary(vol), nudge: swing(p) * (loose ? 1 : 0) + jit(loose ? 9 : 3) + (role === 'snare' ? 0.005 : 0) });
    const keysHit = (beat: number, len: number, vol: number, antic = false) => {
      ev.push({ t: t0 + beat * BEAT, role: 'keys', vol: vary(vol, 0.1), nudge: jit(3), dur: len * BEAT, chord: antic ? next.keys : ch.keys, anticipation: antic });
    };

    // ---- keys
    if (s === 'intro') {
      if (!anticipated) keysHit(0, 3.3, 0.85);
      if (bar === 3) keysHit(3.5, 1.25, 0.8, true);
    } else if (s === 'groove' || s === 'reprise' || s === 'theme') {
      for (const [beat, len, antic] of KEYS_PATTERNS[s === 'theme' ? 'theme' : 'groove'][bar % 4]) {
        if (beat === 0 && anticipated) continue;
        if (antic && bar === 29) continue; // the outro chord lands on its own
        keysHit(beat, len, s === 'theme' ? 0.7 : 0.85, antic);
      }
    } else if (s === 'break') {
      if (bar === 23) keysHit(0, 2, 0.75);
      else keysHit(0, 3.8, 0.75);
    } else if (bar === 30) {
      ev.push({ t: t0, role: 'keys', vol: 0.9, nudge: 0, dur: 7.5 * BEAT, chord: [50, 53, 57, 60, 64, 69] });
    }
    const last = ev.filter((e) => e.role === 'keys' && e.t >= t0).at(-1);
    anticipated = !!last?.anticipation;

    // ---- bass
    if (s === 'groove' || s === 'theme' || s === 'reprise' || (s === 'break' && bar !== 23)) {
      const half = s === 'break';
      ev.push({ t: t0, role: 'bass', vol: vary(1, 0.08), nudge: jit(3), dur: (half ? 3 : 1.4) * BEAT, midi: ch.root, from: lastApproach });
      lastApproach = undefined;
      if (!half) {
        if (s === 'theme') ev.push({ t: t0 + 1.5 * BEAT, role: 'bass', vol: 0.55, nudge: jit(6), dur: 0.35 * BEAT, midi: ch.root + 12 });
        ev.push({ t: t0 + 2.5 * BEAT, role: 'bass', vol: vary(0.9, 0.08), nudge: jit(4), dur: 0.9 * BEAT, midi: ch.fifth });
        if (bar !== 29 && bar !== 19 && bar !== 11) {
          ev.push({ t: t0 + 3.5 * BEAT, role: 'bass', vol: 0.75, nudge: jit(4), dur: 0.45 * BEAT, midi: ch.approach });
          lastApproach = ch.approach;
        }
      }
    } else if (bar === 30) {
      ev.push({ t: t0, role: 'bass', vol: 1, nudge: 0, dur: 6 * BEAT, midi: 38 });
    }

    // ---- drums
    if (s === 'intro' && bar === 3) {
      for (const p of [12, 13, 14, 15]) drum('hat', p, 0.35 + (p - 12) * 0.12, true);
    }
    if (s === 'groove' || s === 'theme' || s === 'reprise') {
      const fillBar = bar === 11 || bar === 19;
      for (const p of bar % 2 ? [0, 6, 10] : [0, 7, 10]) drum('kick', p, p ? 0.85 : 1);
      drum('snare', 4, 0.9);
      if (!fillBar) drum('snare', 12, 0.9);
      for (const p of [3, 9, 15]) if (!(fillBar && p === 15)) drum('ghost', p, 0.18, true);
      for (let p = 0; p < 16; p += 2) {
        if (fillBar && p >= 8) continue;
        if (p === 14 && bar % 4 === 3) drum('ohat', p, 0.5, true);
        else drum('hat', p, p % 4 ? 0.38 : 0.55, true);
      }
      for (const p of s === 'theme' ? [7, 11, 15] : [11]) if (!(fillBar && p > 8)) drum('hat', p, 0.2, true);
      if (fillBar) for (let p = 8; p < 16; p++) drum('fill', p, 0.3 + (p - 8) * 0.08);
      if (bar === 29) for (const p of [12, 13, 14, 15]) drum('fill', p, 0.45 + (p - 12) * 0.12);
    }
    if (s === 'break') {
      drum('kick', 0, 0.9);
      if (bar === 22) drum('kick', 10, 0.75);
      if (bar !== 23) drum('rim', 8, 0.8);
      for (const p of bar === 23 ? [0, 4] : [0, 4, 8, 12]) drum('hat', p, 0.3, true);
      if (bar === 23) for (let p = 8; p < 16; p++) drum('fill', p, 0.25 + (p - 8) * 0.09);
    }
    if (bar === 30) {
      drum('kick', 0, 1);
      drum('ohat', 0, 0.5, true);
    }

    // ---- lead
    const line = s === 'theme' ? THEME[bar - 12] : s === 'break' ? BREAK_FRAGMENTS[bar] : s === 'reprise' ? THEME[(bar - 24 + 4) % 8] : undefined;
    if (line) {
      const shift = s === 'reprise' && bar < 28 ? -12 : 0;
      for (const [beat, len, midi] of line) {
        ev.push({ t: t0 + beat * BEAT, role: 'lead', vol: vary(s === 'reprise' ? 0.85 : 1, 0.1), nudge: jit(4), dur: len * BEAT, midi: midi + shift });
      }
    }
  }
  return ev.sort((a, b) => a.t - b.t);
};

let arrangement: Ev[] | null = null;
const getArrangement = () => (arrangement ??= buildArrangement());

// ---------------------------------------------------------------- audio
const TAPE_STOP_SEC = LEAD_MS / 1000 + (31 * BAR + 2 * BEAT) * SEC_PER_TICK;
const INTRO_END = LEAD_MS / 1000 + 4 * BAR_SEC;
const OUTRO_START = LEAD_MS / 1000 + 30 * BAR_SEC;
const SONG_END = LEAD_MS / 1000 + BARS * BAR_SEC;

/** Master low-pass cutoff at absolute time: muffled intro, opens on the groove, closes at the end */
const CUTOFF: [number, number][] = [[0, 650], [INTRO_END - 0.02, 2600], [INTRO_END, 8000], [OUTRO_START, 8000], [SONG_END + 1, 1200]];
const cutoffAt = (sec: number): number => {
  for (let i = 1; i < CUTOFF.length; i++) {
    const [t1, v1] = CUTOFF[i];
    const [t0, v0] = CUTOFF[i - 1];
    if (sec <= t1) return v0 * Math.pow(v1 / v0, Math.max(0, (sec - t0) / Math.max(1e-6, t1 - t0)));
  }
  return CUTOFF[CUTOFF.length - 1][1];
};

const saturation = (() => {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(1.6 * x) / Math.tanh(1.6);
  }
  return curve;
})();

interface Chain {
  rig: Rig;
  duck: GainNode;
  mix: AudioNode;
}

/** One render context's signal chain. Time 0 of the context is song time `shift` (s). */
const buildChain = (ctx: OfflineAudioContext, shift: number, lengthSec: number): Chain => {
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  comp.connect(ctx.destination);
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturation;
  shaper.oversample = 'none';
  const out = ctx.createGain();
  out.gain.value = 0.9;
  shaper.connect(out).connect(comp);
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.Q.value = 0.5;
  lpf.frequency.setValueAtTime(cutoffAt(shift), 0);
  for (let i = 1; i < CUTOFF.length; i++) {
    const [t, v] = CUTOFF[i];
    if (t <= shift || t - shift > lengthSec) continue;
    if (CUTOFF[i - 1][1] === v || v > CUTOFF[i - 1][1] * 2) lpf.frequency.setValueAtTime(v, t - shift);
    else lpf.frequency.exponentialRampToValueAtTime(v, t - shift);
  }
  lpf.connect(shaper);
  const mix = ctx.createGain();
  mix.connect(lpf);

  const drums = ctx.createGain();
  drums.gain.value = 0.85;
  drums.connect(mix);
  const duck = ctx.createGain();
  duck.connect(mix);
  // keys: gentle tremolo
  const keys = ctx.createGain();
  keys.gain.value = 0.9;
  const trem = ctx.createOscillator();
  trem.frequency.value = 4.3;
  const tremDepth = ctx.createGain();
  tremDepth.gain.value = 0.1;
  trem.connect(tremDepth).connect(keys.gain);
  trem.start(0);
  keys.connect(duck);
  const bass = ctx.createGain();
  bass.gain.value = 0.9;
  bass.connect(duck);
  const lead = ctx.createGain();
  lead.gain.value = 0.85;
  lead.connect(duck);
  // dotted-8th echo on keys and lead
  const delay = ctx.createDelay(1);
  delay.delayTime.value = (60 / BPM) * 0.75;
  const fb = ctx.createGain();
  fb.gain.value = 0.3;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 1800;
  const wet = ctx.createGain();
  wet.gain.value = 0.2;
  delay.connect(tone).connect(fb).connect(delay);
  tone.connect(wet).connect(mix);
  const send = ctx.createGain();
  send.gain.value = 0.6;
  send.connect(delay);
  lead.connect(send);
  keys.connect(send);
  // tape wow/flutter (+ tape stop), from absolute song time
  const wow = ctx.createConstantSource();
  wow.offset.value = 0;
  const RES = 60;
  const curve = new Float32Array(Math.max(2, Math.ceil(lengthSec * RES)));
  for (let i = 0; i < curve.length; i++) curve[i] = wowCents(shift + i / RES, TAPE_STOP_SEC, 2.2);
  wow.offset.setValueCurveAtTime(curve, 0, curve.length / RES);
  wow.start(0);
  return { rig: { ctx, drums, keys, bass, lead, wow }, duck, mix };
};

/** Schedules the events of bars [from, to) into a chain whose time 0 is song time `shift` */
const scheduleBars = (c: Chain, from: number, to: number, shift: number): void => {
  const { rig } = c;
  const lead = LEAD_MS / 1000;
  const at = (e: Ev) => Math.max(0, lead + e.t * SEC_PER_TICK + e.nudge - shift);
  const kicks: number[] = [];
  for (const e of getArrangement()) {
    const bar = Math.floor(e.t / BAR);
    if (bar < from || bar >= to) continue;
    const t = at(e);
    const sec = (e.dur ?? 0) * SEC_PER_TICK;
    switch (e.role) {
      case 'kick':
        softKick(rig, t, e.vol);
        kicks.push(t);
        break;
      case 'snare':
      case 'ghost':
      case 'fill':
        dustySnare(rig, t, e.vol);
        break;
      case 'rim':
        rim(rig, t, e.vol);
        break;
      case 'hat':
      case 'ohat':
        lofiHat(rig, t, e.vol, e.role === 'ohat');
        break;
      case 'keys': {
        const notes = e.chord ?? [];
        const roll = sec > 2 ? 0.014 : 0.005; // long chords are strummed a little
        notes.forEach((m, i) => ePiano(rig, t + i * roll, sec, m, e.vol * (i === notes.length - 1 ? 1.15 : 1)));
        break;
      }
      case 'bass':
        subBass(rig, t, sec, e.midi!, e.vol, e.from);
        break;
      case 'lead':
        softLead(rig, t, sec, e.midi!, e.vol);
        break;
    }
  }
  // sidechain-style duck of the music under every kick
  const g = c.duck.gain;
  g.setValueAtTime(1, 0);
  for (const t of kicks.sort((a, b) => a - b)) {
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0.72, t + 0.012);
    g.linearRampToValueAtTime(1, t + 0.22);
  }
};

const CHUNK_BARS = 4;
const TAIL_SEC = 3;

/**
 * Renders the track in 4-bar chunks on parallel OfflineAudioContexts (each
 * renders on its own thread), then sums them. Several times faster than one
 * long render.
 */
export const renderDemoAudio = async (sampleRate = 44100): Promise<AudioBuffer> => {
  const lead = LEAD_MS / 1000;
  const totalSec = SONG_END + 1.5;
  const total = Math.ceil(totalSec * sampleRate);
  const chunks: { from: number; to: number; shift: number }[] = [];
  for (let b = 0; b < BARS; b += CHUNK_BARS) chunks.push({ from: b, to: Math.min(BARS, b + CHUNK_BARS), shift: b === 0 ? 0 : lead + b * BAR_SEC });
  const rendered = await Promise.all(
    chunks.map(({ from, to, shift }, i) => {
      const endSec = Math.min(totalSec, lead + to * BAR_SEC + TAIL_SEC);
      const lengthSec = endSec - shift;
      const ctx = new OfflineAudioContext(2, Math.ceil(lengthSec * sampleRate), sampleRate);
      const chain = buildChain(ctx, shift, lengthSec);
      // vinyl bed covers this chunk's own span only (chunks overlap in their tails)
      const own = (to === BARS ? totalSec : lead + to * BAR_SEC) - shift;
      vinyl(ctx, chain.mix, own, 1000 + i, 0.9);
      scheduleBars(chain, from, to, shift);
      return ctx.startRendering().then((buf) => ({ buf, offset: Math.round(shift * sampleRate) }));
    }),
  );
  const out = new AudioBuffer({ numberOfChannels: 2, length: total, sampleRate });
  for (let ch = 0; ch < 2; ch++) {
    const dst = out.getChannelData(ch);
    for (const { buf, offset } of rendered) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      const n = Math.min(src.length, total - offset);
      for (let i = 0; i < n; i++) dst[offset + i] += src[i];
    }
  }
  // gentle fade at the very end
  const fade = Math.round(0.8 * sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < fade; i++) d[total - 1 - i] *= i / fade;
  }
  return out;
};

// ---------------------------------------------------------------- charts
const UP: Lane = 0;
const DOWN: Lane = 1;
const tap = (t: number, lane: Lane): Note => ({ t, lane, type: 'tap' });
const pos16 = (e: Ev) => (e.t % BAR) / S16;
const barOf = (e: Ev) => Math.floor(e.t / BAR);

/** Resolves collisions: one note per lane and tick, nothing inside a same-lane hold or any mash/roll */
const clean = (notes: Note[]): Note[] => {
  const sorted = [...notes].sort((a, b) => a.t - b.t || (SPAN_TYPES.has(b.type) ? 1 : 0) - (SPAN_TYPES.has(a.type) ? 1 : 0));
  const out: Note[] = [];
  const busy: [number, number] = [-1, -1]; // per lane: end of the current hold
  let spanEnd = -1;
  const taken = new Set<string>();
  for (const n of sorted) {
    const isSpan = n.type === 'mash' || n.type === 'roll';
    if (!isSpan && n.t < spanEnd) continue;
    if (isSpan && n.t < spanEnd) continue;
    if (n.t < busy[n.lane]) continue;
    const key = `${n.lane}:${n.t}`;
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(n);
    if (n.type === 'hold') busy[n.lane] = noteEnd(n) + 1;
    if (isSpan) spanEnd = noteEnd(n) + 1;
  }
  return out.sort(compareNotes);
};

const leadNote = (e: Ev, minHold: number): Note =>
  (e.dur ?? 0) >= minHold * BEAT ? { t: e.t, lane: UP, type: 'hold', dur: (e.dur ?? 0) - BEAT / 2 } : tap(e.t, UP);

const normalChart = (): Note[] => {
  const n: Note[] = [];
  const ev = getArrangement();
  for (const e of ev) {
    const bar = barOf(e);
    const s = sectionOf(bar);
    const p = pos16(e);
    switch (s) {
      case 'intro':
        if (e.role === 'keys' && bar >= 1) n.push(e.anticipation ? { t: e.t, lane: UP, type: 'collect' } : tap(e.t, DOWN));
        break;
      case 'groove':
      case 'reprise':
        if (e.role === 'kick' && (p === 0 || (p === 10 && bar % 2 === 1))) n.push((bar === 24 || bar === 28) && p === 0 ? { t: e.t, lane: DOWN, type: 'big' } : tap(e.t, DOWN));
        if (e.role === 'snare') n.push(tap(e.t, UP));
        if (e.role === 'fill' && bar === 11 && p === 8) n.push({ t: e.t, lane: UP, type: 'roll', dur: 2 * BEAT - S16 });
        if (s === 'reprise' && e.role === 'lead' && (e.dur ?? 0) >= 2 * BEAT) n.push(leadNote(e, 2));
        break;
      case 'theme':
        if (e.role === 'kick' && p === 0) n.push(tap(e.t, DOWN));
        if (e.role === 'lead' && (e.dur ?? 0) >= BEAT) n.push(leadNote(e, 1.5));
        if (e.role === 'fill' && bar === 19 && p === 8) n.push({ t: e.t, lane: UP, type: 'roll', dur: 2 * BEAT - S16 });
        break;
      case 'break':
        if (e.role === 'lead') n.push(leadNote(e, 1.5));
        if (e.role === 'keys' && (bar === 21 || bar === 23)) n.push(bar === 21 ? { t: e.t, lane: DOWN, type: 'hold', dur: 3 * BEAT } : tap(e.t, DOWN));
        if (e.role === 'fill' && p === 8) n.push({ t: e.t, lane: UP, type: 'mash', dur: 2 * BEAT - S16, hits: 6 });
        break;
      case 'outro':
        if (e.role === 'kick') n.push({ t: e.t, lane: DOWN, type: 'big' });
        break;
    }
  }
  return clean(n);
};

const hardChart = (): Note[] => {
  const n: Note[] = [];
  const ev = getArrangement();
  for (const e of ev) {
    const bar = barOf(e);
    const s = sectionOf(bar);
    const p = pos16(e);
    switch (s) {
      case 'intro':
        if (e.role === 'keys') n.push(e.anticipation ? { t: e.t, lane: UP, type: 'collect' } : tap(e.t, DOWN));
        if (e.role === 'hat') n.push(tap(e.t, UP));
        break;
      case 'groove':
      case 'reprise': {
        if (e.role === 'kick') {
          const big = p === 0 && (bar === 4 || bar === 8 || bar === 24 || bar === 28);
          n.push(big ? { t: e.t, lane: DOWN, type: 'big' } : tap(e.t, DOWN));
          if (big && bar >= 24) n.push({ t: e.t, lane: UP, type: 'big' });
        }
        if (e.role === 'snare') n.push(tap(e.t, UP));
        if (e.role === 'keys' && e.t % BEAT !== 0) {
          if (e.anticipation && bar % 4 === 1 && bar !== 29) n.push(tap(e.t, UP), { t: e.t, lane: DOWN, type: 'mine' });
          else n.push({ t: e.t, lane: UP, type: 'collect' });
        }
        if (e.role === 'fill' && bar === 11 && p === 8) n.push({ t: e.t, lane: DOWN, type: 'roll', dur: 2 * BEAT - S16 });
        if (e.role === 'fill' && bar === 29 && p === 12) n.push({ t: e.t, lane: UP, type: 'roll', dur: BEAT - S16 });
        if (s === 'reprise' && e.role === 'lead' && (e.dur ?? 0) >= BEAT) n.push(leadNote(e, 1.5));
        break;
      }
      case 'theme':
        if (e.role === 'kick') n.push(p === 0 && bar === 12 ? { t: e.t, lane: DOWN, type: 'big' } : tap(e.t, DOWN));
        if (e.role === 'lead') n.push(leadNote(e, 1.5));
        if (e.role === 'fill' && bar === 19 && p === 8) n.push({ t: e.t, lane: DOWN, type: 'roll', dur: 2 * BEAT - S16 });
        break;
      case 'break':
        if (e.role === 'lead') n.push(leadNote(e, 1.5));
        if (e.role === 'keys') n.push(bar === 23 ? tap(e.t, DOWN) : { t: e.t, lane: DOWN, type: 'hold', dur: 3 * BEAT });
        if (e.role === 'rim') n.push(tap(e.t, UP));
        if (e.role === 'kick' && p === 10) n.push(tap(e.t, UP));
        if (e.role === 'fill' && p === 8) n.push({ t: e.t, lane: DOWN, type: 'mash', dur: 2 * BEAT - S16, hits: 14 });
        break;
      case 'outro':
        if (e.role === 'kick') n.push({ t: e.t, lane: DOWN, type: 'big' }, { t: e.t, lane: UP, type: 'big' });
        break;
    }
  }
  return clean(n);
};

export const buildDemoChart = (): Chart => {
  const events: ChartEvent[] = SECTIONS.map(([bar, label]) => ({ t: bar * BAR, type: 'section', label }));
  return {
    formatVersion: FORMAT_VERSION,
    id: DEMO_ID,
    meta: {
      title: 'Warmup Protocol',
      artist: 'NARG Synth Unit',
      charter: 'NARG',
      tags: ['tutorial', 'built-in', 'lo-fi'],
      previewStartMs: LEAD_MS + 12 * BAR_SEC * 1000,
    },
    audio: { file: 'warmup.wav', offsetMs: LEAD_MS },
    timing: {
      bpm: [{ t: 0, bpm: BPM }],
      signatures: [{ t: 0, num: 4, den: 4 }],
      speed: [
        { t: 0, mult: 0.9 },
        { t: 4 * BAR, mult: 1 },
        { t: 20 * BAR, mult: 0.8 },
        { t: 23 * BAR, mult: 0.8 },
        { t: 24 * BAR, mult: 1.1, ease: 'linear' },
        { t: 30 * BAR, mult: 0.9 },
      ],
    },
    difficulties: [
      { id: 'lofi-normal', name: 'Normal', level: 3, notes: normalChart(), events },
      { id: 'lofi-hard', name: 'Hard', level: 7, notes: hardChart(), events },
    ],
  };
};
