/** Pure analysis functions (run in the worker, unit-testable in Node) */

export interface PeakLevel {
  bucket: number;     // samples per bucket
  min: Float32Array;
  max: Float32Array;
}

export interface Peaks {
  sampleRate: number;
  length: number;
  levels: PeakLevel[]; // finest first
}

const BASE_BUCKET = 32;

export const computePeaks = (samples: Float32Array, sampleRate: number): Peaks => {
  const levels: PeakLevel[] = [];
  let n = Math.ceil(samples.length / BASE_BUCKET);
  let min = new Float32Array(n);
  let max = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    let lo = 1;
    let hi = -1;
    const end = Math.min(samples.length, (b + 1) * BASE_BUCKET);
    for (let i = b * BASE_BUCKET; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo;
    max[b] = hi;
  }
  let bucket = BASE_BUCKET;
  levels.push({ bucket, min, max });
  while (n > 64) {
    const m = Math.ceil(n / 2);
    const nmin = new Float32Array(m);
    const nmax = new Float32Array(m);
    for (let b = 0; b < m; b++) {
      const a = b * 2;
      const c = Math.min(n - 1, a + 1);
      nmin[b] = Math.min(min[a], min[c]);
      nmax[b] = Math.max(max[a], max[c]);
    }
    bucket *= 2;
    levels.push({ bucket, min: nmin, max: nmax });
    min = nmin;
    max = nmax;
    n = m;
  }
  return { sampleRate, length: samples.length, levels };
};

export interface TempoResult {
  bpm: number;
  offsetMs: number;    // ms of the first beat (downbeat guess) in the file
  confidence: number;  // 0..1
}

const HOP = 441; // ~10 ms at 44.1 kHz (scaled for other rates)

/** Spectral-flux-like onset envelope from band energies (cheap: no FFT) */
const onsetEnvelope = (samples: Float32Array, sampleRate: number): { env: Float32Array; hopSec: number } => {
  const hop = Math.round((HOP * sampleRate) / 44100);
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(frames);
  // two one-pole filters split low (kick) and high (hats/snare) energy
  let low = 0;
  let prevLow = 0;
  let prevHigh = 0;
  const aLow = Math.exp((-2 * Math.PI * 150) / sampleRate);
  for (let f = 0; f < frames; f++) {
    let eLow = 0;
    let eHigh = 0;
    const end = (f + 1) * hop;
    for (let i = f * hop; i < end; i++) {
      const x = samples[i];
      low = aLow * low + (1 - aLow) * x;
      const high = x - low;
      eLow += low * low;
      eHigh += high * high;
    }
    eLow = Math.log1p(eLow * 100);
    eHigh = Math.log1p(eHigh * 100);
    env[f] = Math.max(0, eLow - prevLow) * 1.5 + Math.max(0, eHigh - prevHigh);
    prevLow = eLow;
    prevHigh = eHigh;
  }
  // remove the local mean so sustained loud parts don't dominate
  const win = 30;
  const out = new Float32Array(frames);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    acc += env[f];
    if (f >= win) acc -= env[f - win];
    out[f] = Math.max(0, env[f] - acc / Math.min(win, f + 1));
  }
  return { env: out, hopSec: hop / sampleRate };
};

export const detectTempo = (samples: Float32Array, sampleRate: number): TempoResult => {
  const { env, hopSec } = onsetEnvelope(samples, sampleRate);
  const n = env.length;
  if (n < 400) return { bpm: 120, offsetMs: 0, confidence: 0 };

  // autocorrelation over lags for 60..220 BPM, weighted toward ~120 BPM (perceptual prior)
  const minLag = Math.floor(60 / 220 / hopSec);
  const maxLag = Math.ceil(60 / 60 / hopSec);
  let bestLag = minLag;
  let best = -Infinity;
  const scores = new Float32Array(maxLag + 1);
  const raw = new Float32Array(maxLag + 1);
  // light smoothing so beats that fall between two frames still correlate at integer lags
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = 0.25 * (env[i - 1] ?? 0) + 0.5 * env[i] + 0.25 * (env[i + 1] ?? 0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += sm[i] * sm[i + lag];
    raw[lag] = s / (n - lag);
    const bpm = 60 / (lag * hopSec);
    // perceptual prior: most charted music sits around 100–180 BPM
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 132) / 0.8, 2));
    scores[lag] = raw[lag] * prior;
    if (scores[lag] > best) {
      best = scores[lag];
      bestLag = lag;
    }
  }
  // parabolic refinement of the peak
  const y0 = scores[bestLag - 1] ?? best;
  const y2 = scores[bestLag + 1] ?? best;
  const denom = y0 - 2 * best + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  let bpm = 60 / ((bestLag + Math.max(-0.5, Math.min(0.5, shift))) * hopSec);
  // fold into a comfortable charting range
  while (bpm < 80) bpm *= 2;
  while (bpm > 200) bpm /= 2;
  // snap near-integers (most produced music is on integer BPM)
  if (Math.abs(bpm - Math.round(bpm)) < 0.15) bpm = Math.round(bpm);

  // phase: which offset puts beats on the strongest onsets
  const period = 60 / bpm / hopSec;
  const steps = Math.max(8, Math.round(period));
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let k = 0; k < steps; k++) {
    const phase = (k / steps) * period;
    let s = 0;
    for (let t = phase; t < n; t += period) {
      const i = Math.round(t);
      s += env[i] + 0.5 * ((env[i - 1] ?? 0) + (env[i + 1] ?? 0));
    }
    if (s > bestPhaseScore) {
      bestPhaseScore = s;
      bestPhase = phase;
    }
  }
  // first strong beat: skip leading silence
  let first = bestPhase;
  const threshold = 0.15 * Math.max(...env.subarray(0, Math.min(n, 3000)));
  while (first + period < n && Math.max(env[Math.round(first)] ?? 0, env[Math.round(first) + 1] ?? 0) < threshold) first += period;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const confidence = Math.max(0, Math.min(1, (bestPhaseScore / Math.max(1, n / period) / Math.max(1e-6, mean) - 1) / 4));
  return { bpm, offsetMs: first * hopSec * 1000, confidence };
};
