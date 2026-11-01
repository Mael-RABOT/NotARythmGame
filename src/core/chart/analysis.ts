import { TimingMap } from './TimingMap';
import { NoteKind, noteEnd, type Chart, type Difficulty, type Note } from './types';

// ============================================================================
// Lint: problems the editor shows in its Lint tab (click = jump)
// ============================================================================
export type LintLevel = 'error' | 'warning' | 'info';

export interface LintIssue {
  level: LintLevel;
  tick: number;
  message: string;
  noteIndices: number[];
}

const MIN_GAP_MS = 25;      // two notes in a lane closer than this cannot be split by a human
const DENSE_NPS = 22;       // notes per second over one second
const LONG_GAP_MS = 12000;

/** `notes` must be sorted (compareNotes) */
export const lintDifficulty = (chart: Chart, diff: Difficulty): LintIssue[] => {
  const issues: LintIssue[] = [];
  const timing = new TimingMap(chart.timing, chart.audio.offsetMs);
  const notes = diff.notes;
  const ms = notes.map((n) => timing.tickToMs(n.t));

  // per-lane overlaps
  const lastInLane: (number | null)[] = [null, null];
  let lastSpanEnd = -1;
  let lastSpanIndex = -1;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.type === 'mash' || n.type === 'roll') {
      if (n.t < lastSpanEnd) issues.push({ level: 'error', tick: n.t, message: `${n.type} overlaps another mash/roll`, noteIndices: [lastSpanIndex, i] });
      lastSpanEnd = Math.max(lastSpanEnd, noteEnd(n));
      lastSpanIndex = i;
      continue;
    }
    if (n.t < lastSpanEnd && n.type !== 'collect') {
      issues.push({ level: 'warning', tick: n.t, message: `${n.type} inside a mash/roll: presses there count for the span first`, noteIndices: [i, lastSpanIndex] });
    }
    const prev = lastInLane[n.lane];
    if (prev !== null) {
      const p = notes[prev];
      if (p.t === n.t) {
        issues.push({ level: 'error', tick: n.t, message: `Two notes on the same tick in the ${n.lane ? 'down' : 'up'} lane`, noteIndices: [prev, i] });
      } else if (p.type === 'hold' && n.t <= noteEnd(p)) {
        issues.push({ level: 'error', tick: n.t, message: `Note inside a hold in the ${n.lane ? 'down' : 'up'} lane`, noteIndices: [prev, i] });
      } else if (ms[i] - ms[prev] < MIN_GAP_MS && n.type !== 'collect' && p.type !== 'collect') {
        issues.push({ level: 'warning', tick: n.t, message: `Notes ${Math.round(ms[i] - ms[prev])} ms apart: too close to tell apart`, noteIndices: [prev, i] });
      }
    }
    lastInLane[n.lane] = i;
    if (n.type === 'mine') {
      const other = notes.find((o) => o.t === n.t && o.lane !== n.lane && o.type !== 'mine' && o.type !== 'collect');
      if (other) issues.push({ level: 'info', tick: n.t, message: 'Mine paired with a note: fine, but make sure it reads clearly', noteIndices: [i] });
    }
    if (n.t % 12 !== 0 && n.t % 8 !== 0) {
      issues.push({ level: 'info', tick: n.t, message: 'Note is off every standard snap (unquantized)', noteIndices: [i] });
    }
  }

  // density
  let lo = 0;
  for (let i = 0; i < notes.length; i++) {
    while (ms[i] - ms[lo] > 1000) lo++;
    if (i - lo + 1 > DENSE_NPS) {
      issues.push({ level: 'warning', tick: notes[lo].t, message: `Very dense: ${i - lo + 1} notes in one second`, noteIndices: [lo, i] });
      lo = i; // report once per burst
    }
  }

  // long gaps
  for (let i = 1; i < notes.length; i++) {
    if (ms[i] - Math.max(ms[i - 1], timing.tickToMs(noteEnd(notes[i - 1]))) > LONG_GAP_MS) {
      issues.push({ level: 'info', tick: notes[i - 1].t, message: `${Math.round((ms[i] - ms[i - 1]) / 1000)} s without notes`, noteIndices: [i - 1, i] });
    }
  }

  if (notes.length === 0) issues.push({ level: 'info', tick: 0, message: 'No notes yet: pick a tool (1–8) and click a lane, or press R to record', noteIndices: [] });
  return issues.sort((a, b) => a.tick - b.tick);
};

// ============================================================================
// Difficulty estimate: strain model, mapped to a 1..15 level
// ============================================================================
export interface DifficultyStats {
  noteCount: number;
  durationMs: number;
  avgNps: number;
  peakNps: number;
  level: number;
  /** strain per bucket (for the density graph), normalised 0..1 */
  density: Float32Array;
}

const KIND_COST: Record<number, number> = {
  [NoteKind.tap]: 1,
  [NoteKind.big]: 1.3,
  [NoteKind.hold]: 1.2,
  [NoteKind.mash]: 1.5,
  [NoteKind.roll]: 0.8,
  [NoteKind.mine]: 0.6,
  [NoteKind.collect]: 0.2,
};

export const analyzeDifficulty = (chart: Chart, diff: Difficulty, buckets = 160, durationHintMs = 0): DifficultyStats => {
  const timing = new TimingMap(chart.timing, chart.audio.offsetMs);
  const notes: Note[] = diff.notes;
  const ms = notes.map((n) => timing.tickToMs(n.t));
  const first = ms[0] ?? 0;
  const last = notes.length ? Math.max(...notes.map((n) => timing.tickToMs(noteEnd(n)))) : 0;
  const duration = Math.max(durationHintMs, last);

  // strain: decays exponentially, each note adds cost scaled by how fast it follows the previous one
  let strain = 0;
  let peak = 0;
  let prevMs = -Infinity;
  const lanePrev = [-Infinity, -Infinity];
  const strains = new Float32Array(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const t = ms[i];
    const dt = Math.max(30, t - prevMs);
    strain *= Math.pow(0.5, dt / 400);
    const n = notes[i];
    const sameLane = t - lanePrev[n.lane];
    const jackBonus = sameLane < 200 ? 1.25 : 1; // repeated same-lane presses (jacks) are harder
    strain += (KIND_COST[NoteKind[n.type]] ?? 1) * jackBonus * (1000 / Math.max(dt, 60)) * 0.12;
    strains[i] = strain;
    peak = Math.max(peak, strain);
    prevMs = t;
    lanePrev[n.lane] = t;
  }

  // peak NPS over a sliding second
  let peakNps = 0;
  let lo = 0;
  for (let i = 0; i < ms.length; i++) {
    while (ms[i] - ms[lo] > 1000) lo++;
    peakNps = Math.max(peakNps, i - lo + 1);
  }

  const density = new Float32Array(buckets);
  if (duration > 0) {
    for (let i = 0; i < notes.length; i++) {
      const b = Math.min(buckets - 1, Math.floor((ms[i] / duration) * buckets));
      density[b] += KIND_COST[NoteKind[notes[i].type]] ?? 1;
    }
    let max = 0;
    for (let b = 0; b < buckets; b++) max = Math.max(max, density[b]);
    if (max > 0) for (let b = 0; b < buckets; b++) density[b] /= max;
  }

  // top-weighted average of strains (like a "hardest 10%" measure) blended with peak
  const sorted = Array.from(strains).sort((a, b) => b - a);
  const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)));
  const topAvg = top.reduce((s, v) => s + v, 0) / top.length || 0;
  const raw = topAvg * 0.7 + peak * 0.3;
  const level = notes.length ? Math.min(15, Math.max(1, Math.round(1 + raw * 2.2))) : 1;

  const span = Math.max(1, last - first);
  return {
    noteCount: notes.length,
    durationMs: duration,
    avgNps: notes.length > 1 ? (notes.length / span) * 1000 : 0,
    peakNps,
    level,
    density,
  };
};
