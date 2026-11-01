import { describe, expect, it } from 'vitest';
import { computePeaks, detectTempo } from './analysisCore';

const SR = 44100;

/** Kick-like thump on every beat + softer hat on off-beats */
const clickTrack = (bpm: number, firstBeatSec: number, seconds: number): Float32Array => {
  const out = new Float32Array(SR * seconds);
  const beat = 60 / bpm;
  let seed = 7;
  for (let t = firstBeatSec, k = 0; t < seconds; t += beat / 2, k++) {
    const start = Math.round(t * SR);
    const strong = k % 2 === 0;
    for (let i = 0; i < SR * 0.08 && start + i < out.length; i++) {
      const env = Math.exp(-i / (SR * (strong ? 0.03 : 0.008)));
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 2147483648 - 1;
      out[start + i] += strong ? Math.sin((2 * Math.PI * 60 * i) / SR) * env * 0.9 : noise * env * 0.25;
    }
  }
  return out;
};

describe('analysis', () => {
  it('builds peak mipmaps', () => {
    const s = new Float32Array(SR).map((_, i) => Math.sin(i / 10));
    const p = computePeaks(s, SR);
    expect(p.levels[0].bucket).toBe(32);
    expect(p.levels.length).toBeGreaterThan(3);
    expect(p.levels[0].max[10]).toBeGreaterThan(0.9);
    expect(p.levels.at(-1)!.min[0]).toBeLessThan(-0.9);
  });

  for (const [bpm, first] of [[128, 1.5], [95, 0.4], [174, 2.0]] as const) {
    it(`detects ${bpm} BPM with first beat at ${first}s`, () => {
      const r = detectTempo(clickTrack(bpm, first, 30), SR);
      expect(Math.abs(r.bpm - bpm)).toBeLessThan(0.6);
      const beatMs = 60000 / bpm;
      // offset may land on any beat: compare phase
      const phaseErr = Math.abs(((r.offsetMs - first * 1000) % beatMs + beatMs + beatMs / 2) % beatMs - beatMs / 2);
      expect(phaseErr).toBeLessThan(25);
    });
  }
});
