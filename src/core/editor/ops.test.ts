import { describe, expect, it } from 'vitest';
import { packNarg, parseChart, unpackNarg } from '../chart/serialize';
import { TimingMap } from '../chart/TimingMap';
import { createEmptyChart, PPQ, type Note } from '../chart/types';
import { addNotes, applyTiming, mirrorNotes, moveNotes, quantize, reverseNotes, stretchNotes } from './ops';

const n = (t: number, lane: 0 | 1 = 0, type: Note['type'] = 'tap'): Note => ({ t, lane, type });

describe('editor ops', () => {
  it('adds notes replacing same tick+lane', () => {
    const a = n(0);
    const out = addNotes([a, n(PPQ)], [n(0, 0, 'big')]);
    expect(out.length).toBe(2);
    expect(out[0].type).toBe('big');
  });

  it('moves a selection and keeps untouched notes by identity', () => {
    const a = n(0);
    const b = n(PPQ, 1);
    const { notes, remap } = moveNotes([a, b], new Set([a]), PPQ * 2, 1);
    expect(notes.includes(b)).toBe(true);
    const moved = remap.get(a)!;
    expect(moved.t).toBe(PPQ * 2);
    expect(moved.lane).toBe(1);
  });

  it('never moves before tick 0', () => {
    const a = n(PPQ);
    const { remap } = moveNotes([a], new Set([a]), -PPQ * 5, 0);
    expect(remap.get(a)!.t).toBe(0);
  });

  it('mirrors, reverses and stretches', () => {
    const a = n(0, 0);
    const b = n(PPQ, 1);
    const sel = new Set([a, b]);
    expect(mirrorNotes([a, b], sel).notes.map((x) => x.lane)).toEqual([1, 0]);
    expect(reverseNotes([a, b], sel).notes.map((x) => [x.t, x.lane])).toEqual([[0, 1], [PPQ, 0]]);
    expect(stretchNotes([a, b], sel, 2).notes.map((x) => x.t)).toEqual([0, PPQ * 2]);
  });

  it('quantizes to snaps including triplets', () => {
    expect(quantize(70, 3)).toBe(64);
    expect(quantize(70, 4)).toBe(48);
  });

  it('keeps notes in place (ms) when the BPM is corrected', () => {
    const chart = createEmptyChart();
    chart.difficulties[0].notes = [n(PPQ * 4), n(PPQ * 8, 1)];
    const before = new TimingMap(chart.timing, 0);
    const msBefore = chart.difficulties[0].notes.map((x) => before.tickToMs(x.t));
    const fixed = applyTiming(chart, { ...chart.timing, bpm: [{ t: 0, bpm: 150 }] }, 0, true);
    const after = new TimingMap(fixed.timing, 0);
    fixed.difficulties[0].notes.forEach((x, i) => expect(Math.abs(after.tickToMs(x.t) - msBefore[i])).toBeLessThan(2));
  });
});

describe('serialize', () => {
  it('round-trips a .narg package', () => {
    const chart = createEmptyChart('Round trip');
    chart.difficulties[0].notes = [n(0), { t: PPQ, lane: 1, type: 'hold', dur: PPQ }, { t: PPQ * 3, lane: 0, type: 'mash', dur: PPQ, hits: 8 }];
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const pkg = unpackNarg(packNarg({ chart, audio: { name: 'song.ogg', data: audio } }));
    expect(pkg.chart.meta.title).toBe('Round trip');
    expect(pkg.chart.difficulties[0].notes).toEqual(chart.difficulties[0].notes);
    expect(Array.from(pkg.audio.data)).toEqual([1, 2, 3, 4, 5]);
  });

  it('sanitises hostile JSON', () => {
    const c = parseChart({ difficulties: [{ notes: [{ t: -5, type: 'tap' }, { t: 10, type: 'nope' }, { t: 3, type: 'hold' }] }], timing: { bpm: [{ t: 0, bpm: 1e9 }] } });
    expect(c.difficulties[0].notes).toEqual([{ t: 3, lane: 0, type: 'hold', dur: 48 }]);
    expect(c.timing.bpm[0].bpm).toBe(2000);
    expect(() => parseChart({ formatVersion: 99, difficulties: [{}] })).toThrow();
  });
});
