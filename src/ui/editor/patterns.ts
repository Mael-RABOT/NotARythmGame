import { create } from 'zustand';
import { PPQ, type Lane, type Note, type NoteType } from '../../core/chart/types';

export interface Pattern {
  id: string;
  name: string;
  notes: Note[]; // relative to tick 0
  builtin?: boolean;
}

const s16 = PPQ / 4;
const s8 = PPQ / 2;
const s12 = PPQ / 3;
const n = (t: number, lane: Lane, type: NoteType = 'tap', dur?: number, hits?: number): Note => {
  const note: Note = { t, lane, type };
  if (dur) note.dur = dur;
  if (hits) note.hits = hits;
  return note;
};
const seq = (count: number, step: number, lane: (i: number) => Lane, type: NoteType = 'tap') =>
  Array.from({ length: count }, (_, i) => n(i * step, lane(i), type));

export const STARTER_PATTERNS: Pattern[] = [
  { id: 'b-stream', name: 'Stream 1/4 (alternating)', notes: seq(8, s8, (i) => (i % 2) as Lane) },
  { id: 'b-stream16', name: 'Burst 1/16 ×5', notes: seq(5, s16, (i) => (i % 2) as Lane) },
  { id: 'b-trill', name: 'Trill 1/8 down-up', notes: seq(8, s16 * 2, (i) => (1 - (i % 2)) as Lane) },
  { id: 'b-jack', name: 'Jack ×4 (one lane)', notes: seq(4, s8, () => 0) },
  { id: 'b-triplet', name: 'Triplet roll', notes: seq(6, s12, (i) => (i < 3 ? 0 : 1)) },
  { id: 'b-sync', name: 'Sync hits on beats', notes: [0, PPQ, PPQ * 2, PPQ * 3].flatMap((t) => [n(t, 0), n(t, 1)]) },
  { id: 'b-gallop', name: 'Gallop', notes: [n(0, 1), n(s16 * 3, 0), n(PPQ, 1), n(PPQ + s16 * 3, 0), n(PPQ * 2, 1, 'big')] },
  { id: 'b-holdtap', name: 'Hold + taps on the other lane', notes: [n(0, 1, 'hold', PPQ * 2), ...seq(4, s8, () => 0).map((x) => ({ ...x, t: x.t + s8 }))] },
  { id: 'b-bigs', name: 'Big hits on the downbeats', notes: [n(0, 1, 'big'), n(PPQ * 2, 0, 'big'), n(PPQ * 4, 1, 'big')] },
  { id: 'b-mash', name: 'Mash break (2 beats, 10 hits)', notes: [n(0, 0, 'mash', PPQ * 2, 10)] },
  { id: 'b-dodge', name: 'Dodge: mines + collects', notes: [n(0, 0, 'mine'), n(0, 1, 'collect'), n(s8, 1, 'mine'), n(s8, 0, 'collect'), n(PPQ, 0, 'mine'), n(PPQ, 1, 'collect')] },
  { id: 'b-fill', name: 'Drum fill into crash', notes: [...seq(6, s16, (i) => (i % 2) as Lane), n(s16 * 6, 0, 'roll', PPQ), n(PPQ * 2 + s8, 1, 'big')] },
];

const KEY = 'narg.patterns.v1';

const load = (): Pattern[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pattern[];
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.name === 'string' && Array.isArray(p.notes)) : [];
  } catch {
    return [];
  }
};

const persist = (list: Pattern[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full / blocked: patterns stay in memory */
  }
};

interface PatternStore {
  user: Pattern[];
  add: (name: string, notes: Note[]) => void;
  remove: (id: string) => void;
}

export const usePatterns = create<PatternStore>((set, get) => ({
  user: load(),
  add: (name, notes) => {
    const user = [{ id: `u-${Date.now().toString(36)}`, name, notes }, ...get().user];
    persist(user);
    set({ user });
  },
  remove: (id) => {
    const user = get().user.filter((p) => p.id !== id);
    persist(user);
    set({ user });
  },
}));

/** Pattern length in ticks (for previews) */
export const patternSpan = (p: Pattern) => p.notes.reduce((m, x) => Math.max(m, x.t + (x.dur ?? 0)), 0);
