import { describe, expect, it } from 'vitest';
import { compileDifficulty } from '../chart/compile';
import { createEmptyChart, PPQ, type Note } from '../chart/types';
import { GameEvent, GameSession, Judgement } from './GameSession';

// 60 BPM, offset 0: one beat (PPQ ticks) = 1000 ms
const session = (notes: Note[], autoplay = false) => {
  const chart = createEmptyChart();
  chart.timing.bpm = [{ t: 0, bpm: 60 }];
  chart.difficulties[0].notes = notes;
  return new GameSession(compileDifficulty(chart, chart.difficulties[0]), undefined, autoplay);
};

const events = (s: GameSession) => {
  const out: number[] = [];
  for (let i = 0; i < s.evWrite; i++) out.push(s.evType[i]);
  return out;
};

describe('GameSession', () => {
  it('judges taps by offset windows', () => {
    const s = session([
      { t: PPQ, lane: 0, type: 'tap' },
      { t: PPQ * 2, lane: 0, type: 'tap' },
      { t: PPQ * 3, lane: 1, type: 'tap' },
      { t: PPQ * 4, lane: 1, type: 'tap' },
    ]);
    s.press(0, 1010);
    s.press(1, 2060);
    s.press(2, 2900); // good (-100)
    s.update(4200);   // last one missed
    expect(Array.from(s.result)).toEqual([Judgement.perfect, Judgement.great, Judgement.good, Judgement.miss]);
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(3);
  });

  it('ignores presses outside the good window', () => {
    const s = session([{ t: PPQ, lane: 0, type: 'tap' }]);
    s.press(0, 800);
    expect(s.result[0]).toBe(-1);
  });

  it('needs both keys for a full big note', () => {
    const s = session([{ t: PPQ, lane: 0, type: 'big' }, { t: PPQ * 2, lane: 0, type: 'big' }]);
    s.press(0, 1000);
    s.press(1, 1015);
    s.press(0, 2000);
    s.update(2100); // second key never came
    expect(s.result[0]).toBe(Judgement.perfect);
    expect(s.result[1]).toBe(Judgement.good);
  });

  it('judges holds at head and tail, breaks on early release', () => {
    const s = session([
      { t: PPQ, lane: 1, type: 'hold', dur: PPQ },
      { t: PPQ * 3, lane: 1, type: 'hold', dur: PPQ },
    ]);
    s.press(2, 1000);
    s.update(1500);
    s.update(2001);
    expect(s.tailResult[0]).toBe(Judgement.perfect);
    s.release(2, 2001);
    s.press(3, 3000);
    s.release(3, 3300);
    expect(s.tailResult[1]).toBe(Judgement.miss);
    expect(events(s)).toContain(GameEvent.holdBreak);
  });

  it('counts mash hits from any key and grades partial completion', () => {
    const s = session([{ t: PPQ, lane: 0, type: 'mash', dur: PPQ, hits: 4 }]);
    s.update(1000);
    s.press(2, 1100);
    s.press(3, 1200);
    s.press(0, 1300);
    s.update(2100);
    expect(s.mashCount[0]).toBe(3);
    expect(s.result[0]).toBe(Judgement.great);
  });

  it('punishes mines and keeps collects off the combo', () => {
    const s = session([
      { t: PPQ, lane: 0, type: 'mine' },
      { t: PPQ * 2, lane: 1, type: 'collect' },
      { t: PPQ * 3, lane: 1, type: 'tap' },
    ]);
    s.press(0, 1010);
    expect(s.minesHit).toBe(1);
    s.press(2, 1990); // collect
    s.press(2, 3000);
    expect(s.collected).toBe(1);
    expect(s.combo).toBe(1);
  });

  it('autoplay gets a perfect score', () => {
    const notes: Note[] = [];
    for (let b = 1; b < 20; b++) notes.push({ t: b * PPQ, lane: (b % 2) as 0 | 1, type: b % 5 === 0 ? 'big' : 'tap' });
    notes.push({ t: 21 * PPQ, lane: 0, type: 'hold', dur: PPQ * 2 });
    notes.push({ t: 25 * PPQ, lane: 1, type: 'mash', dur: PPQ * 2, hits: 8 });
    notes.push({ t: 28 * PPQ, lane: 1, type: 'mine' });
    const s = session(notes, true);
    for (let ms = 0; ms < 30000; ms += 4) s.update(ms);
    expect(s.score).toBe(1_000_000);
    expect(s.minesHit).toBe(0);
    expect(s.fullCombo).toBe(true);
  });
});
