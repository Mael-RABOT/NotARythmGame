/**
 * Chart data model (what is saved in chart.json inside a .narg package).
 *
 * Time is expressed in ticks at PPQ ticks per beat. 192 = 64 × 3, so every
 * snap the editor offers (1/1 … 1/16 and the triplet snaps) lands on an
 * integer tick, and BPM changes never move notes.
 */
export const PPQ = 192;
export const FORMAT_VERSION = 1;

/** 0 = up lane (air), 1 = down lane (ground) */
export type Lane = 0 | 1;

export const NOTE_TYPES = ['tap', 'big', 'hold', 'mash', 'roll', 'mine', 'collect'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Numeric ids used by the compiled (typed-array) chart */
export const NoteKind = {
  tap: 0,
  big: 1,
  hold: 2,
  mash: 3,
  roll: 4,
  mine: 5,
  collect: 6,
} as const satisfies Record<NoteType, number>;

/** Types that span a duration (`dur` is required and > 0) */
export const SPAN_TYPES: ReadonlySet<NoteType> = new Set(['hold', 'mash', 'roll']);
/** Types any key can hit, whatever their lane */
export const ANY_LANE_TYPES: ReadonlySet<NoteType> = new Set(['mash', 'roll']);

export interface Note {
  t: number;      // tick
  lane: Lane;
  type: NoteType;
  dur?: number;   // ticks, span types only
  hits?: number;  // mash only: hits required
}

export interface BpmPoint {
  t: number;
  bpm: number;
}

export interface SignaturePoint {
  t: number;  // must start a measure
  num: number;
  den: number;
}

export type SpeedEase = 'step' | 'linear';

export interface SpeedPoint {
  t: number;
  mult: number;     // scroll speed multiplier (> 0)
  ease?: SpeedEase; // 'linear' ramps from the previous point's speed to this one
}

export const EVENT_TYPES = ['section', 'bookmark', 'flash', 'hideLane'] as const;
export type ChartEventType = (typeof EVENT_TYPES)[number];

export interface ChartEvent {
  t: number;
  type: ChartEventType;
  label?: string;
  lane?: Lane;
  dur?: number;
}

export interface Difficulty {
  id: string;
  name: string;   // "Easy", "Hard", "Chaos"...
  level: number;  // 1..15
  notes: Note[];
  events: ChartEvent[];
}

export interface ChartMeta {
  title: string;
  artist: string;
  charter: string;
  source?: string;
  tags: string[];
  previewStartMs: number;
  coverFile?: string;
}

export interface Chart {
  formatVersion: number;
  id: string;
  meta: ChartMeta;
  audio: {
    file: string;     // name of the audio file inside the package
    offsetMs: number; // audio time (ms) of tick 0
  };
  timing: {
    bpm: BpmPoint[];
    signatures: SignaturePoint[];
    speed: SpeedPoint[];
  };
  difficulties: Difficulty[];
}

export const newId = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export const createEmptyChart = (title = 'Untitled', audioFile = 'audio'): Chart => ({
  formatVersion: FORMAT_VERSION,
  id: newId(),
  meta: { title, artist: 'Unknown', charter: 'You', tags: [], previewStartMs: 0 },
  audio: { file: audioFile, offsetMs: 0 },
  timing: {
    bpm: [{ t: 0, bpm: 120 }],
    signatures: [{ t: 0, num: 4, den: 4 }],
    speed: [{ t: 0, mult: 1 }],
  },
  difficulties: [{ id: newId(), name: 'Normal', level: 5, notes: [], events: [] }],
});

/** Total order used everywhere: by tick, then lane, then type */
export const compareNotes = (a: Note, b: Note): number =>
  a.t - b.t || a.lane - b.lane || NoteKind[a.type] - NoteKind[b.type];

export const noteEnd = (n: Note): number => n.t + (n.dur ?? 0);
