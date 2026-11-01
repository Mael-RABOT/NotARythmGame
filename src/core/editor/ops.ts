import { TimingMap } from '../chart/TimingMap';
import { PPQ, SPAN_TYPES, compareNotes, noteEnd, type Chart, type Difficulty, type Lane, type Note, type NoteType } from '../chart/types';

/**
 * Pure, immutable chart edits. Notes are plain objects: unchanged notes keep
 * their identity (so selections survive), changed notes are new objects and
 * every function returns the replacement map so callers can remap a selection.
 */

/** Snap divisors per beat offered by the editor (1/1 … 1/16 plus triplets) */
export const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16] as const;
export type Snap = (typeof SNAPS)[number];

export const snapTicks = (div: number): number => PPQ / div;
export const quantize = (tick: number, div: number): number => {
  const step = snapTicks(div);
  return Math.round(tick / step) * step;
};
export const floorSnap = (tick: number, div: number): number => {
  const step = snapTicks(div);
  return Math.floor(tick / step) * step;
};

/** Colour used for a snap's grid lines (classic rhythm-game convention) */
export const snapColor = (tick: number): 'measure' | 'beat' | 'half' | 'quarter' | 'triplet' | 'fine' => {
  if (tick % PPQ === 0) return 'beat';
  if (tick % (PPQ / 2) === 0) return 'half';
  if (tick % (PPQ / 4) === 0) return 'quarter';
  if (tick % (PPQ / 3) === 0 || tick % (PPQ / 6) === 0) return 'triplet';
  return 'fine';
};

export type Remap = Map<Note, Note>;

const sorted = (notes: Note[]) => notes.sort(compareNotes);

/** Adds notes; a new note replaces any existing note on the same tick and lane */
export const addNotes = (notes: Note[], add: Note[]): Note[] => {
  const occupied = new Set(add.map((n) => `${n.t}:${n.lane}`));
  return sorted([...notes.filter((n) => !occupied.has(`${n.t}:${n.lane}`) || n.type === 'mash' || n.type === 'roll'), ...add]);
};

export const removeNotes = (notes: Note[], remove: ReadonlySet<Note>): Note[] => notes.filter((n) => !remove.has(n));

const mapSelected = (notes: Note[], sel: ReadonlySet<Note>, fn: (n: Note) => Note): { notes: Note[]; remap: Remap } => {
  const remap: Remap = new Map();
  const out = notes.map((n) => {
    if (!sel.has(n)) return n;
    const m = fn(n);
    remap.set(n, m);
    return m;
  });
  // moved notes replace whatever unselected note sat on their new tick+lane
  const changed = new Set(remap.values());
  const taken = new Set([...changed].map((n) => `${n.t}:${n.lane}`));
  const kept = out.filter((n) => changed.has(n) || !taken.has(`${n.t}:${n.lane}`) || SPAN_TYPES.has(n.type));
  return { notes: sorted(kept), remap };
};

export const moveNotes = (notes: Note[], sel: ReadonlySet<Note>, dTick: number, dLane: number): { notes: Note[]; remap: Remap } => {
  let minT = Infinity;
  for (const n of sel) minT = Math.min(minT, n.t);
  const shift = Math.max(dTick, -minT); // never before tick 0
  return mapSelected(notes, sel, (n) => ({ ...n, t: n.t + shift, lane: (dLane % 2 ? 1 - n.lane : n.lane) as Lane }));
};

export const mirrorNotes = (notes: Note[], sel: ReadonlySet<Note>) => mapSelected(notes, sel, (n) => ({ ...n, lane: (1 - n.lane) as Lane }));

/** Reverses the selection in time (keeps its span) */
export const reverseNotes = (notes: Note[], sel: ReadonlySet<Note>) => {
  let a = Infinity;
  let b = -Infinity;
  for (const n of sel) {
    a = Math.min(a, n.t);
    b = Math.max(b, noteEnd(n));
  }
  return mapSelected(notes, sel, (n) => ({ ...n, t: a + b - noteEnd(n) }));
};

/** Stretches (factor > 1) or compresses the selection around its first note */
export const stretchNotes = (notes: Note[], sel: ReadonlySet<Note>, factor: number) => {
  let a = Infinity;
  for (const n of sel) a = Math.min(a, n.t);
  return mapSelected(notes, sel, (n) => ({
    ...n,
    t: Math.round(a + (n.t - a) * factor),
    ...(n.dur ? { dur: Math.max(1, Math.round(n.dur * factor)) } : {}),
  }));
};

export const quantizeNotes = (notes: Note[], sel: ReadonlySet<Note>, div: number) =>
  mapSelected(notes, sel, (n) => ({
    ...n,
    t: quantize(n.t, div),
    ...(n.dur ? { dur: Math.max(snapTicks(div), quantize(n.dur, div)) } : {}),
  }));

export const convertNotes = (notes: Note[], sel: ReadonlySet<Note>, type: NoteType, defaultDur = PPQ) =>
  mapSelected(notes, sel, (n) => {
    const m: Note = { t: n.t, lane: n.lane, type };
    if (SPAN_TYPES.has(type)) m.dur = n.dur ?? defaultDur;
    if (type === 'mash') m.hits = n.hits ?? Math.max(4, Math.round(((m.dur ?? PPQ) / PPQ) * 4));
    return m;
  });

export const setNoteProps = (notes: Note[], sel: ReadonlySet<Note>, props: Partial<Pick<Note, 'dur' | 'hits' | 'lane'>>) =>
  mapSelected(notes, sel, (n) => {
    const m = { ...n };
    if (props.dur !== undefined && SPAN_TYPES.has(n.type)) m.dur = Math.max(1, Math.round(props.dur));
    if (props.hits !== undefined && n.type === 'mash') m.hits = Math.max(1, Math.round(props.hits));
    if (props.lane !== undefined) m.lane = props.lane;
    return m;
  });

/** Copies notes relative to the first one (clipboard / patterns) */
export const toRelative = (sel: Iterable<Note>): Note[] => {
  const list = [...sel].sort(compareNotes);
  const base = list[0]?.t ?? 0;
  return list.map((n) => ({ ...n, t: n.t - base }));
};

export const fromRelative = (rel: Note[], at: number, flip = false): Note[] =>
  rel.map((n) => ({ ...n, t: n.t + at, lane: (flip ? 1 - n.lane : n.lane) as Lane }));

export const notesInRange = (notes: Note[], fromTick: number, toTick: number, lane?: Lane): Note[] =>
  notes.filter((n) => n.t >= fromTick && n.t < toTick && (lane === undefined || n.lane === lane));

// ---------------------------------------------------------------- chart-level
export const withDifficulty = (chart: Chart, diffIndex: number, patch: Partial<Difficulty>): Chart => ({
  ...chart,
  difficulties: chart.difficulties.map((d, i) => (i === diffIndex ? { ...d, ...patch } : d)),
});

/**
 * Applies new timing. With `keepTime`, every note, event and timing point is
 * re-ticked so it stays at the same *millisecond* (fixing a wrong BPM after
 * charting); otherwise notes keep their beat position.
 */
export const applyTiming = (chart: Chart, timing: Chart['timing'], offsetMs: number, keepTime: boolean): Chart => {
  if (!keepTime) return { ...chart, timing, audio: { ...chart.audio, offsetMs } };
  const before = new TimingMap(chart.timing, chart.audio.offsetMs);
  const after = new TimingMap(timing, offsetMs);
  const re = (t: number) => Math.max(0, Math.round(after.msToTick(before.tickToMs(t))));
  const reDur = (t: number, dur: number) => Math.max(1, re(t + dur) - re(t));
  return {
    ...chart,
    audio: { ...chart.audio, offsetMs },
    timing: {
      ...timing,
      speed: timing.speed.map((p) => (p.t === 0 ? p : { ...p, t: re(p.t) })),
    },
    difficulties: chart.difficulties.map((d) => ({
      ...d,
      notes: sorted(d.notes.map((n) => ({ ...n, t: re(n.t), ...(n.dur ? { dur: reDur(n.t, n.dur) } : {}) }))),
      events: d.events.map((e) => ({ ...e, t: re(e.t) })),
    })),
  };
};
