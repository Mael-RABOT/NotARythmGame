import { create } from 'zustand';
import type { Peaks, TempoResult } from '../../core/audio/analysis';
import { TimingMap } from '../../core/chart/TimingMap';
import type { Chart, Difficulty, Note, NoteType } from '../../core/chart/types';
import type { AutosaveRecord } from '../../storage/db';
import type { Remap, Snap } from '../../core/editor/ops';

export type Tool = 'select' | NoteType | 'erase';

export const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: 'select', key: '1', label: 'Select', hint: 'Click to select, drag to move, drag empty space to box-select' },
  { id: 'tap', key: '2', label: 'Tap', hint: 'Click a lane to place a tap note' },
  { id: 'big', key: '3', label: 'Big', hint: 'Needs both keys of the lane' },
  { id: 'hold', key: '4', label: 'Hold', hint: 'Click-drag to set the length' },
  { id: 'mash', key: '5', label: 'Mash', hint: 'Any key, many times. Drag for length' },
  { id: 'roll', key: '6', label: 'Roll', hint: 'Bonus hits during a span. Drag for length' },
  { id: 'mine', key: '7', label: 'Mine', hint: 'Player must not press that lane' },
  { id: 'collect', key: '8', label: 'Collect', hint: 'Hold the lane as it passes for a bonus' },
  { id: 'erase', key: '9', label: 'Erase', hint: 'Click or drag over notes to delete (right-click works with any tool)' },
];

export type InspectorTab = 'note' | 'timing' | 'chart' | 'lint' | 'patterns';

interface HistoryEntry {
  chart: Chart;
  label: string;
  diffIndex: number;
}

const HISTORY_LIMIT = 300;

export interface EditorState {
  // document
  songId: string | null;
  chart: Chart | null;
  diffIndex: number;
  audioName: string;
  audioData: ArrayBuffer | null;
  buffer: AudioBuffer | null;
  peaks: Peaks | null;
  timing: TimingMap | null;
  dirty: boolean;
  savedAt: number;
  /** the song is in the library (Save updates it) */
  inLibrary: boolean;

  past: HistoryEntry[];
  future: HistoryEntry[];

  // editing
  tool: Tool;
  snap: Snap;
  selection: Set<Note>;
  clipboard: Note[];
  stamp: Note[] | null;

  // view & transport
  zoom: number;      // px per ms
  viewMs: number;    // song ms at the left edge
  follow: boolean;
  cursorMs: number;  // playhead when stopped
  playing: boolean;
  rate: number;
  metronome: boolean;
  hitsounds: boolean;
  recording: boolean;
  recordQuantize: boolean;
  recordOverwrite: boolean;

  tempo: TempoResult | null;
  tempoBusy: boolean;
  inspector: InspectorTab;
  palette: boolean;
  shortcuts: boolean;
  tour: boolean;
  hover: { tick: number; lane: number } | null;
  pendingRestore: AutosaveRecord | null;
  /** tap-tempo timestamps (performance.now) */
  taps: number[];
  /** BPM edits move notes with the beat grid (false) or keep their time (true) */
  keepTime: boolean;
  /** inspector row to highlight briefly, e.g. "speed:384" */
  flash: string | null;
}

interface EditorActions {
  load: (p: { songId: string | null; chart: Chart; audioName: string; audioData: ArrayBuffer; buffer: AudioBuffer; inLibrary: boolean }) => void;
  setPeaks: (p: Peaks) => void;
  /** Records an undoable change. `remap` carries moved notes into the selection. */
  commit: (label: string, chart: Chart, opts?: { selection?: Set<Note>; remap?: Remap; keepSelection?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  set: (patch: Partial<EditorState>) => void;
  setDiff: (index: number) => void;
  markSaved: (songId: string) => void;
}

export const useEditor = create<EditorState & EditorActions>((set, get) => ({
  songId: null,
  chart: null,
  diffIndex: 0,
  audioName: '',
  audioData: null,
  buffer: null,
  peaks: null,
  timing: null,
  dirty: false,
  savedAt: 0,
  inLibrary: false,
  past: [],
  future: [],
  tool: 'tap',
  snap: 4,
  selection: new Set(),
  clipboard: [],
  stamp: null,
  zoom: 0.25,
  viewMs: -500,
  follow: true,
  cursorMs: 0,
  playing: false,
  rate: 1,
  metronome: false,
  hitsounds: true,
  recording: false,
  recordQuantize: true,
  recordOverwrite: false,
  tempo: null,
  tempoBusy: false,
  inspector: 'timing',
  palette: false,
  shortcuts: false,
  tour: false,
  hover: null,
  pendingRestore: null,
  taps: [],
  keepTime: false,
  flash: null,

  load: ({ songId, chart, audioName, audioData, buffer, inLibrary }) =>
    set({
      songId,
      chart,
      diffIndex: 0,
      audioName,
      audioData,
      buffer,
      inLibrary,
      peaks: null,
      timing: new TimingMap(chart.timing, chart.audio.offsetMs),
      dirty: false,
      savedAt: Date.now(),
      past: [],
      future: [],
      selection: new Set(),
      stamp: null,
      cursorMs: 0,
      viewMs: -500,
      playing: false,
      recording: false,
      tempo: null,
      hover: null,
      pendingRestore: null,
      taps: [],
      inspector: chart.difficulties.some((d) => d.notes.length) ? 'note' : 'timing',
    }),

  setPeaks: (peaks) => set({ peaks }),

  commit: (label, chart, opts) => {
    const s = get();
    if (!s.chart || chart === s.chart) return;
    let selection = opts?.selection ?? (opts?.keepSelection ? s.selection : new Set<Note>());
    if (opts?.remap) {
      selection = new Set([...s.selection].map((n) => opts.remap!.get(n) ?? n));
      for (const v of opts.remap.values()) selection.add(v);
    }
    const timingChanged = chart.timing !== s.chart.timing || chart.audio.offsetMs !== s.chart.audio.offsetMs;
    set({
      chart,
      past: [...s.past.slice(-HISTORY_LIMIT + 1), { chart: s.chart, label, diffIndex: s.diffIndex }],
      future: [],
      dirty: true,
      selection,
      ...(timingChanged ? { timing: new TimingMap(chart.timing, chart.audio.offsetMs) } : {}),
    });
  },

  undo: () => {
    const s = get();
    const prev = s.past.at(-1);
    if (!prev || !s.chart) return;
    set({
      chart: prev.chart,
      diffIndex: Math.min(prev.diffIndex, prev.chart.difficulties.length - 1),
      past: s.past.slice(0, -1),
      future: [...s.future, { chart: s.chart, label: prev.label, diffIndex: s.diffIndex }],
      timing: new TimingMap(prev.chart.timing, prev.chart.audio.offsetMs),
      selection: new Set(),
      dirty: true,
    });
  },

  redo: () => {
    const s = get();
    const next = s.future.at(-1);
    if (!next || !s.chart) return;
    set({
      chart: next.chart,
      diffIndex: Math.min(next.diffIndex, next.chart.difficulties.length - 1),
      future: s.future.slice(0, -1),
      past: [...s.past, { chart: s.chart, label: next.label, diffIndex: s.diffIndex }],
      timing: new TimingMap(next.chart.timing, next.chart.audio.offsetMs),
      selection: new Set(),
      dirty: true,
    });
  },

  set: (patch) => set(patch),

  setDiff: (index) => set({ diffIndex: index, selection: new Set() }),

  markSaved: (songId) => set({ dirty: false, savedAt: Date.now(), songId, inLibrary: true }),
}));

export const editor = () => useEditor.getState();

export const currentDiff = (s: Pick<EditorState, 'chart' | 'diffIndex'> = editor()): Difficulty | null =>
  s.chart ? s.chart.difficulties[Math.min(s.diffIndex, s.chart.difficulties.length - 1)] : null;
