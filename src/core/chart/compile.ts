import { TimingMap } from './TimingMap';
import { compareNotes, NoteKind, type Chart, type Difficulty, type Note } from './types';

/**
 * Struct-of-arrays view of one difficulty, sorted by hit time.
 * The game loop and renderer only read these typed arrays: no object iteration,
 * no allocation per frame.
 */
export interface CompiledChart {
  count: number;
  tick: Int32Array;
  time: Float64Array;    // ms of the head
  end: Float64Array;     // ms of the tail (== time for instant notes)
  pos: Float64Array;     // scroll position of the head
  posEnd: Float64Array;  // scroll position of the tail
  lane: Uint8Array;
  kind: Uint8Array;      // NoteKind
  hits: Uint16Array;     // mash: hits required
  sync: Uint8Array;      // 1 when another note shares the same tick in the other lane
  /** Longest span in scroll units, so culling can start early enough for long holds */
  maxSpanPos: number;
  firstMs: number;
  lastMs: number;
  timing: TimingMap;
  /** Original notes, same order as the arrays (editor ↔ game mapping) */
  notes: Note[];
}

export const compileDifficulty = (chart: Chart, diff: Difficulty, timing = new TimingMap(chart.timing, chart.audio.offsetMs)): CompiledChart => {
  const notes = [...diff.notes].sort(compareNotes);
  const n = notes.length;
  const c: CompiledChart = {
    count: n,
    tick: new Int32Array(n),
    time: new Float64Array(n),
    end: new Float64Array(n),
    pos: new Float64Array(n),
    posEnd: new Float64Array(n),
    lane: new Uint8Array(n),
    kind: new Uint8Array(n),
    hits: new Uint16Array(n),
    sync: new Uint8Array(n),
    maxSpanPos: 0,
    firstMs: 0,
    lastMs: 0,
    timing,
    notes,
  };
  for (let i = 0; i < n; i++) {
    const note = notes[i];
    c.tick[i] = note.t;
    c.time[i] = timing.tickToMs(note.t);
    c.end[i] = note.dur ? timing.tickToMs(note.t + note.dur) : c.time[i];
    c.pos[i] = timing.msToPos(c.time[i]);
    c.posEnd[i] = timing.msToPos(c.end[i]);
    c.lane[i] = note.lane;
    c.kind[i] = NoteKind[note.type];
    c.hits[i] = note.type === 'mash' ? Math.max(1, note.hits ?? 10) : 0;
    c.maxSpanPos = Math.max(c.maxSpanPos, c.posEnd[i] - c.pos[i]);
  }
  // sync flags: taps/bigs/holds sharing a tick across both lanes
  for (let i = 0; i + 1 < n; i++) {
    if (c.tick[i] === c.tick[i + 1] && c.lane[i] !== c.lane[i + 1] && isHittable(c.kind[i]) && isHittable(c.kind[i + 1])) {
      c.sync[i] = 1;
      c.sync[i + 1] = 1;
    }
  }
  c.firstMs = n ? c.time[0] : 0;
  let last = 0;
  for (let i = 0; i < n; i++) last = Math.max(last, c.end[i]);
  c.lastMs = last;
  return c;
};

const isHittable = (k: number) => k === NoteKind.tap || k === NoteKind.big || k === NoteKind.hold;

/** First index whose value is >= target (arr sorted ascending) */
export const lowerBound = (arr: Float64Array, target: number, count = arr.length): number => {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};
