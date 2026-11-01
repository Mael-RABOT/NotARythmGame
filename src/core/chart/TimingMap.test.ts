import { describe, expect, it } from 'vitest';
import { TimingMap } from './TimingMap';
import { PPQ } from './types';

const timing = (bpm: { t: number; bpm: number }[], speed = [{ t: 0, mult: 1 }]) => ({
  bpm,
  signatures: [{ t: 0, num: 4, den: 4 }],
  speed,
});

describe('TimingMap', () => {
  it('converts ticks to ms at constant BPM with offset', () => {
    const m = new TimingMap(timing([{ t: 0, bpm: 120 }]), 100);
    expect(m.tickToMs(0)).toBe(100);
    expect(m.tickToMs(PPQ)).toBeCloseTo(600);
    expect(m.msToTick(600)).toBeCloseTo(PPQ);
  });

  it('handles BPM changes and round-trips', () => {
    const m = new TimingMap(timing([{ t: 0, bpm: 120 }, { t: PPQ * 4, bpm: 240 }]), 0);
    expect(m.tickToMs(PPQ * 4)).toBeCloseTo(2000);
    expect(m.tickToMs(PPQ * 5)).toBeCloseTo(2250);
    for (const t of [0, 37, PPQ * 3.5, PPQ * 4, PPQ * 9.25]) {
      expect(m.msToTick(m.tickToMs(t))).toBeCloseTo(t, 6);
    }
    expect(m.bpmAt(PPQ * 6)).toBeCloseTo(240);
  });

  it('integrates step and linear scroll speed', () => {
    const m = new TimingMap(timing([{ t: 0, bpm: 60 }], [
      { t: 0, mult: 1 },
      { t: PPQ, mult: 2 },               // step to 2x at 1000 ms
      { t: PPQ * 2, mult: 4, ease: 'linear' } as never, // ramps 2x → 4x over 1000..2000 ms
    ]), 0);
    expect(m.msToPos(1000)).toBeCloseTo(1000);
    expect(m.msToPos(1500)).toBeCloseTo(1000 + (2 + 3) / 2 * 500);
    expect(m.msToPos(2000)).toBeCloseTo(1000 + 3 * 1000);
    expect(m.msToPos(2500)).toBeCloseTo(4000 + 4 * 500);
    expect(m.speedAtMs(1500)).toBeCloseTo(3);
  });

  it('labels beats and walks beat lines', () => {
    const m = new TimingMap(timing([{ t: 0, bpm: 120 }]), 0);
    expect(m.beatLabel(0)).toBe('1.1');
    expect(m.beatLabel(PPQ * 5)).toBe('2.2');
    const lines: [number, boolean][] = [];
    m.forEachBeat(0, PPQ * 4, (t, measure) => lines.push([t, measure]));
    expect(lines.length).toBe(5);
    expect(lines[0][1]).toBe(true);
    expect(lines[1][1]).toBe(false);
    expect(lines[4][1]).toBe(true);
  });
});
