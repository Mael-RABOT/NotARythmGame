import { PPQ, type Chart, type SignaturePoint, type SpeedPoint } from './types';

/**
 * Converts between ticks, song milliseconds and scroll position.
 *
 * - ms: audio time in milliseconds (includes the chart offset, so ms 0 = start of the file)
 * - pos: scroll distance in "ms at speed ×1". Notes are drawn at
 *   (pos(note) - pos(now)) * pxPerMs, so speed changes stretch the field without
 *   changing when notes must be hit. pos is strictly increasing (speeds are > 0).
 *
 * All lookups are binary searches over precomputed segment arrays (no allocation).
 */
export class TimingMap {
  // BPM segments
  private readonly bTick: Float64Array;
  private readonly bMs: Float64Array;
  private readonly bMsPerTick: Float64Array;
  // Speed segments (in ms space)
  private readonly sMs: Float64Array;
  private readonly sPos: Float64Array;
  private readonly sMult: Float64Array;     // speed at segment start
  private readonly sMultEnd: Float64Array;  // speed at segment end (== start unless the next point ramps)
  private readonly signatures: SignaturePoint[];

  readonly offsetMs: number;

  constructor(timing: Chart['timing'], offsetMs: number) {
    this.offsetMs = offsetMs;
    const bpm = [...timing.bpm].sort((a, b) => a.t - b.t);
    if (bpm.length === 0 || bpm[0].t !== 0) bpm.unshift({ t: 0, bpm: bpm[0]?.bpm ?? 120 });
    const n = bpm.length;
    this.bTick = new Float64Array(n);
    this.bMs = new Float64Array(n);
    this.bMsPerTick = new Float64Array(n);
    let ms = offsetMs;
    for (let i = 0; i < n; i++) {
      if (i > 0) ms += (bpm[i].t - bpm[i - 1].t) * this.bMsPerTick[i - 1];
      this.bTick[i] = bpm[i].t;
      this.bMs[i] = ms;
      this.bMsPerTick[i] = 60000 / (Math.max(1, bpm[i].bpm) * PPQ);
    }

    const speed: SpeedPoint[] = [...timing.speed].sort((a, b) => a.t - b.t);
    if (speed.length === 0 || speed[0].t !== 0) speed.unshift({ t: 0, mult: speed[0]?.mult ?? 1 });
    const m = speed.length;
    this.sMs = new Float64Array(m);
    this.sPos = new Float64Array(m);
    this.sMult = new Float64Array(m);
    this.sMultEnd = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      this.sMs[i] = this.tickToMs(speed[i].t);
      this.sMult[i] = Math.max(0.05, speed[i].mult);
    }
    // a speed point before the first BPM-derived ms (negative ticks) is clamped by tickToMs already
    for (let i = 0; i < m; i++) {
      const next = speed[i + 1];
      this.sMultEnd[i] = next && next.ease === 'linear' ? Math.max(0.05, next.mult) : this.sMult[i];
    }
    // linear points ramp *into* themselves: the segment ending there carries the ramp,
    // so the point's own segment starts at its target speed (already set above)
    for (let i = 1; i < m; i++) {
      this.sPos[i] = this.sPos[i - 1] + this.segmentArea(i - 1, this.sMs[i] - this.sMs[i - 1]);
    }

    this.signatures = [...timing.signatures].sort((a, b) => a.t - b.t);
    if (this.signatures.length === 0 || this.signatures[0].t !== 0) {
      this.signatures.unshift({ t: 0, num: 4, den: 4 });
    }
  }

  /** Integral of the speed over the first `dt` ms of segment i */
  private segmentArea(i: number, dt: number): number {
    const a = this.sMult[i];
    const b = this.sMultEnd[i];
    if (a === b) return a * dt;
    const len = (i + 1 < this.sMs.length ? this.sMs[i + 1] : Infinity) - this.sMs[i];
    if (!isFinite(len) || len <= 0) return a * dt;
    const slope = (b - a) / len;
    return dt * (a + (slope * dt) / 2);
  }

  /** Index of the last element <= value (0 when value is before the first) */
  private static floorIndex(arr: Float64Array, value: number): number {
    let lo = 0;
    let hi = arr.length - 1;
    if (value <= arr[0]) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid] <= value) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  tickToMs(tick: number): number {
    const i = TimingMap.floorIndex(this.bTick, tick);
    return this.bMs[i] + (tick - this.bTick[i]) * this.bMsPerTick[i];
  }

  msToTick(ms: number): number {
    const i = TimingMap.floorIndex(this.bMs, ms);
    return this.bTick[i] + (ms - this.bMs[i]) / this.bMsPerTick[i];
  }

  /** BPM in effect at `tick` */
  bpmAt(tick: number): number {
    return 60000 / (this.bMsPerTick[TimingMap.floorIndex(this.bTick, tick)] * PPQ);
  }

  msPerBeatAt(tick: number): number {
    return this.bMsPerTick[TimingMap.floorIndex(this.bTick, tick)] * PPQ;
  }

  msToPos(ms: number): number {
    const i = TimingMap.floorIndex(this.sMs, ms);
    const dt = ms - this.sMs[i];
    // before the first point: extrapolate at the initial speed
    if (dt < 0) return this.sPos[0] + dt * this.sMult[0];
    return this.sPos[i] + this.segmentArea(i, dt);
  }

  speedAtMs(ms: number): number {
    const i = TimingMap.floorIndex(this.sMs, ms);
    const a = this.sMult[i];
    const b = this.sMultEnd[i];
    if (a === b || i + 1 >= this.sMs.length) return a;
    const k = Math.min(1, Math.max(0, (ms - this.sMs[i]) / (this.sMs[i + 1] - this.sMs[i])));
    return a + (b - a) * k;
  }

  /** Maximum speed multiplier anywhere (used to size the culling window) */
  get maxSpeed(): number {
    let max = 0;
    for (let i = 0; i < this.sMult.length; i++) max = Math.max(max, this.sMult[i], this.sMultEnd[i]);
    return max;
  }

  get minSpeed(): number {
    let min = Infinity;
    for (let i = 0; i < this.sMult.length; i++) min = Math.min(min, this.sMult[i], this.sMultEnd[i]);
    return min;
  }

  signatureAt(tick: number): SignaturePoint {
    let s = this.signatures[0];
    for (const sig of this.signatures) {
      if (sig.t <= tick) s = sig;
      else break;
    }
    return s;
  }

  /** Ticks per measure for a signature */
  static measureTicks(sig: SignaturePoint): number {
    return (sig.num * PPQ * 4) / sig.den;
  }

  /**
   * Calls `cb` for every beat line between two ticks (inclusive start).
   * `isMeasure` is true on the first beat of a measure. No allocation per line.
   */
  forEachBeat(fromTick: number, toTick: number, cb: (tick: number, isMeasure: boolean) => void): void {
    const sigs = this.signatures;
    for (let s = 0; s < sigs.length; s++) {
      const sig = sigs[s];
      const end = s + 1 < sigs.length ? sigs[s + 1].t : Infinity;
      if (end <= fromTick) continue;
      if (sig.t > toTick) break;
      const beat = (PPQ * 4) / sig.den;
      const measure = beat * sig.num;
      const first = Math.max(sig.t, sig.t + Math.ceil((fromTick - sig.t) / beat) * beat);
      for (let t = first; t <= toTick && t < end; t += beat) {
        cb(t, (t - sig.t) % measure === 0);
      }
    }
  }

  /** "measure.beat" label for a tick (1-based), e.g. "12.3" */
  beatLabel(tick: number): string {
    let measureIndex = 0;
    const sigs = this.signatures;
    for (let s = 0; s < sigs.length; s++) {
      const sig = sigs[s];
      const end = s + 1 < sigs.length ? sigs[s + 1].t : Infinity;
      const mt = TimingMap.measureTicks(sig);
      if (tick < end) {
        const local = Math.max(0, tick - sig.t);
        const m = Math.floor(local / mt);
        const beatTicks = (PPQ * 4) / sig.den;
        const inMeasure = local - m * mt;
        const beat = Math.floor(inMeasure / beatTicks);
        const label = `${measureIndex + m + 1}.${beat + 1}`;
        const rest = Math.round(inMeasure - beat * beatTicks);
        if (!rest) return label;
        // off-beat: add the fraction of a beat, e.g. 3.2+1/2
        const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
        const g = gcd(rest, beatTicks);
        const den = beatTicks / g;
        // musical subdivisions only; an unsnapped position just shows its beat
        return den <= 16 ? `${label}+${rest / g}/${den}` : label;
      }
      measureIndex += Math.round((end - sig.t) / mt);
    }
    return '1.1';
  }
}
