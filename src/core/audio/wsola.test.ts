import { describe, expect, it } from 'vitest';
import { WsolaStretcher } from './wsola';

const SR = 44100;

const render = (src: Float32Array, rate: number, q0: number, frames: number): Float32Array => {
  const st = new WsolaStretcher([src]);
  st.seek(q0, rate);
  const out = new Float32Array(frames);
  // feed in 128-frame render quanta like an AudioWorklet
  for (let i = 0; i < frames; i += 128) {
    const n = Math.min(128, frames - i);
    st.process([out], n, i);
  }
  return out;
};

const zeroCrossingHz = (x: Float32Array, from: number, to: number) => {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return (n / 2) * (SR / (to - from));
};

describe('WSOLA time-stretch', () => {
  it('keeps the pitch of a sine at 0.25×', () => {
    const src = new Float32Array(SR * 2).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / SR) * 0.8);
    const out = render(src, 0.25, 0, SR * 4);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(Math.abs(zeroCrossingHz(out, SR, SR * 3) - 440)).toBeLessThan(6);
    // still sounding through the whole stretched length (2 s → 8 s; we checked 1..3 s)
    let energy = 0;
    for (let i = SR * 3; i < SR * 4; i++) energy += out[i] * out[i];
    expect(energy / SR).toBeGreaterThan(0.1);
  });

  for (const rate of [0.1, 0.25, 0.5, 0.75]) {
    it(`keeps clicks in sync with the song clock at ${rate}×`, () => {
      // a click every 0.5 s of source
      const src = new Float32Array(SR * 6);
      for (let t = 0.25; t < 6; t += 0.5) for (let i = 0; i < 60; i++) src[Math.round(t * SR) + i] = Math.exp(-i / 12) * (i % 2 ? -1 : 1);
      const q0 = Math.round(1.1 * SR);
      const seconds = 1.2 / rate;
      const out = render(src, rate, q0, Math.round(seconds * SR));
      // expected output time of the click at source 1.25 s and 1.75 s
      for (const click of [1.25, 1.75]) {
        const expected = ((click * SR - q0) / rate);
        if (expected > out.length - 4000) continue;
        let peak = 0;
        let at = 0;
        const lo = Math.max(0, Math.round(expected - 0.06 * SR));
        const hi = Math.min(out.length, Math.round(expected + 0.06 * SR));
        for (let i = lo; i < hi; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); at = i; }
        expect(peak).toBeGreaterThan(0.2);
        expect(Math.abs(at - expected) / SR * 1000).toBeLessThan(25);
      }
    });
  }
});
