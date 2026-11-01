/**
 * Streaming WSOLA time-stretcher (Waveform Similarity Overlap-Add).
 *
 * Plays `channels` at `rate` × speed (0 < rate ≤ 1) without changing the pitch.
 * Hann frames of N samples are overlap-added every Hs = N/2 output samples; each
 * frame is read from the source near its nominal position (advancing by Hs·rate),
 * shifted by up to ±TOL samples to best continue the previous frame's waveform.
 *
 * Sync: after `seek(q0)`, output sample j carries source position ≈ q0 + j·rate,
 * so a song clock that advances at `rate` stays aligned (verified by tests).
 * Pure TypeScript: runs in an AudioWorklet and in Node tests. No allocation per call.
 */
export const WSOLA_FRAME = 2048;
const HOP = WSOLA_FRAME / 2;
const TOL = 512;
const CORR_STEP = 4;   // decimation of the similarity measure (cheap and good enough)
const SEARCH_STEP = 2;

export class WsolaStretcher {
  private window = new Float32Array(WSOLA_FRAME);
  private ola: Float32Array[];
  private out: Float32Array[];
  private outLen = 0;     // samples ready in `out`
  private outRead = 0;
  private nominal = 0;    // nominal source start of the next frame
  private prevStart = 0;  // actual source start of the previous frame
  private hasPrev = false;
  private rate = 1;

  constructor(private channels: Float32Array[]) {
    for (let i = 0; i < WSOLA_FRAME; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WSOLA_FRAME);
    this.ola = channels.map(() => new Float32Array(WSOLA_FRAME));
    this.out = channels.map(() => new Float32Array(HOP));
  }

  get length(): number {
    return this.channels[0]?.length ?? 0;
  }

  /** Approximate source position (samples) of the next output sample */
  position = 0;

  /** Restarts output so that the next output sample carries source position `q0` */
  seek(q0: number, rate: number): void {
    this.rate = Math.min(1, Math.max(0.05, rate));
    const r = this.rate;
    for (const b of this.ola) b.fill(0);
    this.outLen = 0;
    this.outRead = 0;
    this.hasPrev = false;
    // frame centres map linearly: o = (q - P)/r - (N/2)(1/r - 1). One primed hop is discarded.
    this.nominal = q0 - (WSOLA_FRAME / 2) * (1 - r) - HOP * r;
    this.position = q0;
    this.synthesize();
    this.outRead = this.outLen; // discard the fade-in hop
  }

  private sample(ch: Float32Array, i: number): number {
    return i >= 0 && i < ch.length ? ch[i] : 0;
  }

  private mono(i: number): number {
    const ch = this.channels;
    let v = 0;
    for (let c = 0; c < ch.length; c++) v += this.sample(ch[c], i);
    return v;
  }

  /** Picks the best frame start near the nominal position and overlap-adds it */
  private synthesize(): void {
    let start = Math.round(this.nominal);
    if (this.hasPrev) {
      // natural continuation of the previous frame starts at prevStart + HOP: match its first half
      const target = this.prevStart + HOP;
      let best = -Infinity;
      let bestK = start;
      for (let k = start - TOL; k <= start + TOL; k += SEARCH_STEP) {
        let s = 0;
        for (let m = 0; m < HOP; m += CORR_STEP) s += this.mono(target + m) * this.mono(k + m);
        if (s > best) {
          best = s;
          bestK = k;
        }
      }
      start = best > 0 ? bestK : start;
    }
    const w = this.window;
    for (let c = 0; c < this.channels.length; c++) {
      const src = this.channels[c];
      const ola = this.ola[c];
      for (let m = 0; m < WSOLA_FRAME; m++) ola[m] += w[m] * this.sample(src, start + m);
      // first HOP samples are complete: move them out, shift the rest
      this.out[c].set(ola.subarray(0, HOP));
      ola.copyWithin(0, HOP);
      ola.fill(0, HOP);
    }
    this.outLen = HOP;
    this.outRead = 0;
    this.prevStart = start;
    this.hasPrev = true;
    this.nominal += HOP * this.rate;
  }

  /** Fills `frames` samples of each output channel starting at `offset` */
  process(out: Float32Array[], frames: number, offset = 0): void {
    let written = 0;
    while (written < frames) {
      if (this.outRead >= this.outLen) this.synthesize();
      const n = Math.min(frames - written, this.outLen - this.outRead);
      for (let c = 0; c < out.length; c++) {
        const src = this.out[Math.min(c, this.out.length - 1)];
        out[c].set(src.subarray(this.outRead, this.outRead + n), offset + written);
      }
      this.outRead += n;
      written += n;
    }
    this.position += frames * this.rate;
  }
}
