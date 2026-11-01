import { PPQ, SPAN_TYPES, compareNotes, noteEnd, type Chart, type ChartEvent, type Lane, type Note, type NoteType } from '../../core/chart/types';
import {
  SNAPS,
  addNotes,
  convertNotes,
  fromRelative,
  mirrorNotes,
  moveNotes,
  quantizeNotes,
  removeNotes,
  reverseNotes,
  snapTicks,
  stretchNotes,
  toRelative,
  withDifficulty,
} from '../../core/editor/ops';
import { audio } from '../../core/audio/AudioEngine';
import { toast } from '../components/overlays';
import type { Timeline } from './Timeline';
import { TOOLS, currentDiff, editor, type Tool } from './store';

// ---------------------------------------------------------------- timeline handle
let tl: Timeline | null = null;
export const setTimeline = (t: Timeline | null) => {
  tl = t;
};
export const timeline = () => tl;

const sel = () => editor().selection;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Runs a note transform on the selection of the current difficulty */
const transform = (label: string, fn: (notes: Note[], s: ReadonlySet<Note>) => { notes: Note[]; remap: Map<Note, Note> }) => {
  const s = editor();
  const diff = currentDiff();
  if (!s.chart || !diff || !s.selection.size) {
    toast('Select some notes first', 'info', 1600);
    return;
  }
  const { notes, remap } = fn(diff.notes, s.selection);
  s.commit(`${label} ${plural(s.selection.size, 'note')}`, withDifficulty(s.chart, s.diffIndex, { notes }), { selection: new Set(remap.values()) });
};

const setNotes = (label: string, notes: Note[], selection?: Set<Note>) => {
  const s = editor();
  if (!s.chart) return;
  s.commit(label, withDifficulty(s.chart, s.diffIndex, { notes }), { selection });
};

export const playheadTick = () => tl?.playheadTick() ?? 0;

// ---------------------------------------------------------------- note edits
export const deleteSelection = () => {
  const diff = currentDiff();
  const n = sel().size;
  if (!diff || !n) return;
  setNotes(`Delete ${plural(n, 'note')}`, removeNotes(diff.notes, sel()));
};

export const copySelection = (cut = false) => {
  const s = editor();
  if (!s.selection.size) return;
  const rel = toRelative(s.selection);
  s.set({ clipboard: rel });
  if (cut) deleteSelection();
  toast(`${cut ? 'Cut' : 'Copied'} ${plural(rel.length, 'note')}`, 'info', 1200);
};

export const pasteAtPlayhead = () => {
  const s = editor();
  const diff = currentDiff();
  if (!diff || !s.clipboard.length) return;
  const add = fromRelative(s.clipboard, playheadTick());
  setNotes(`Paste ${plural(add.length, 'note')}`, addNotes(diff.notes, add), new Set(add));
};

export const duplicateSelection = () => {
  const diff = currentDiff();
  const s = sel();
  if (!diff || !s.size) return;
  let a = Infinity;
  let b = -Infinity;
  for (const n of s) {
    a = Math.min(a, n.t);
    b = Math.max(b, noteEnd(n));
  }
  const step = snapTicks(editor().snap);
  const len = Math.max(step, Math.ceil((b - a + 1) / step) * step);
  const add = fromRelative(toRelative(s), a + len);
  setNotes(`Duplicate ${plural(add.length, 'note')}`, addNotes(diff.notes, add), new Set(add));
};

export const nudge = (dSteps: number, dLane = 0) => {
  const s = editor();
  const diff = currentDiff();
  if (!s.chart || !diff || !s.selection.size) return false;
  const { notes, remap } = moveNotes(diff.notes, s.selection, dSteps * snapTicks(s.snap), dLane);
  s.commit(dLane ? 'Swap lane' : 'Nudge', withDifficulty(s.chart, s.diffIndex, { notes }), { remap });
  return true;
};

export const mirror = () => transform('Mirror', mirrorNotes);
export const reverse = () => transform('Reverse', reverseNotes);
export const stretch = (f: number) => transform(f > 1 ? 'Stretch' : 'Compress', (n, s) => stretchNotes(n, s, f));
export const quantizeSel = () => transform('Quantize', (n, s) => quantizeNotes(n, s, editor().snap));
export const convertSel = (type: NoteType) => transform(`Convert to ${type}`, (n, s) => convertNotes(n, s, type, snapTicks(editor().snap) * 4));

export const selectAll = () => {
  const diff = currentDiff();
  if (diff) editor().set({ selection: new Set(diff.notes), inspector: 'note' });
};
export const selectWhere = (pred: (n: Note) => boolean) => {
  const diff = currentDiff();
  if (!diff) return;
  const base = sel().size ? [...sel()] : diff.notes;
  const s = new Set(base.filter(pred));
  editor().set({ selection: s, inspector: 'note' });
  toast(`${plural(s.size, 'note')} selected`, 'info', 1200);
};
/** Selects every note from the playhead to the end of the current measure range */
export const selectAfterPlayhead = () => {
  const diff = currentDiff();
  if (!diff) return;
  const t = playheadTick();
  editor().set({ selection: new Set(diff.notes.filter((n) => n.t >= t)), inspector: 'note' });
};

// ---------------------------------------------------------------- tools / snap / view
export const setTool = (tool: Tool) => editor().set({ tool, stamp: null });
export const snapBy = (d: number) => {
  const s = editor();
  const i = SNAPS.indexOf(s.snap);
  s.set({ snap: SNAPS[Math.max(0, Math.min(SNAPS.length - 1, i + d))] });
};
export const zoomBy = (f: number) => tl?.zoomBy(f);
export const EDITOR_RATES = [0.1, 0.25, 0.5, 0.75, 1] as const;

/** Changes the editor playback speed; below 100 % the audio is time-stretched (pitch kept) */
export const setRate = async (rate: number) => {
  const s = editor();
  if (rate < 1) {
    const ok = await audio.prepareStretch();
    if (!ok) toast('Pitch-preserving slow-down is not supported here: the pitch will drop', 'info', 3000);
  }
  const was = editor().playing;
  if (was) tl?.pause();
  s.set({ rate });
  if (was) tl?.play();
};

export const stepRate = (d: number) => {
  const i = EDITOR_RATES.indexOf(editor().rate as (typeof EDITOR_RATES)[number]);
  const next = EDITOR_RATES[Math.max(0, Math.min(EDITOR_RATES.length - 1, (i < 0 ? EDITOR_RATES.length - 1 : i) + d))];
  void setRate(next);
  toast(`Playback ${Math.round(next * 100)}%`, 'info', 900);
};

// ---------------------------------------------------------------- transport
export const togglePlay = () => tl?.toggle();
export const seekTick = (tick: number) => {
  const s = editor();
  if (!s.timing || !tl) return;
  tl.seek(s.timing.tickToMs(Math.max(0, tick)));
};
export const seekBySteps = (d: number) => seekTick(playheadTick() + d * snapTicks(editor().snap));
export const seekByMeasures = (d: number) => {
  const s = editor();
  if (!s.timing) return;
  const t = playheadTick();
  const sig = s.timing.signatureAt(t);
  const mt = (PPQ * 4 * sig.num) / sig.den;
  const base = Math.floor((t - sig.t) / mt) * mt + sig.t;
  seekTick(d > 0 ? base + mt * d : t > base ? base + mt * (d + 1) : base + mt * d);
};
export const seekStart = () => tl?.seek(0);
export const seekEnd = () => {
  const diff = currentDiff();
  const last = diff?.notes.at(-1);
  if (last) seekTick(noteEnd(last));
  else tl?.seek((editor().buffer?.duration ?? 0) * 1000);
};

export const toggleRecord = () => {
  const s = editor();
  const next = !s.recording;
  if (s.playing) {
    if (next) {
      s.set({ recording: true });
      tl?.beginRecordPass();
    } else {
      tl?.endRecordPass();
      s.set({ recording: false });
    }
  } else s.set({ recording: next });
  toast(next ? 'Record mode: play the song and hit your lane keys' : 'Record mode off', next ? 'info' : 'info', 2200);
};

// ---------------------------------------------------------------- events (sections / bookmarks)
const setEvents = (label: string, events: ChartEvent[]) => {
  const s = editor();
  if (!s.chart) return;
  s.commit(label, withDifficulty(s.chart, s.diffIndex, { events: [...events].sort((a, b) => a.t - b.t) }), { keepSelection: true });
};

export const addEvent = (type: ChartEvent['type'], label?: string) => {
  const diff = currentDiff();
  if (!diff) return;
  const t = playheadTick();
  const existing = diff.events.filter((e) => !(e.t === t && e.type === type));
  const ev: ChartEvent = { t, type };
  if (label !== undefined) ev.label = label;
  if (type === 'section') ev.label = label ?? `Section ${diff.events.filter((e) => e.type === 'section').length + 1}`;
  if (type === 'hideLane') {
    ev.lane = 0;
    ev.dur = PPQ * 4;
  }
  setEvents(`Add ${type}`, [...existing, ev]);
};

export const updateEvent = (ev: ChartEvent, patch: Partial<ChartEvent>) => {
  const diff = currentDiff();
  if (!diff) return;
  setEvents(`Edit ${ev.type}`, diff.events.map((e) => (e === ev ? { ...e, ...patch } : e)));
};

export const removeEvent = (ev: ChartEvent) => {
  const diff = currentDiff();
  if (!diff) return;
  setEvents(`Remove ${ev.type}`, diff.events.filter((e) => e !== ev));
};

export const jumpMarker = (dir: 1 | -1) => {
  const diff = currentDiff();
  if (!diff) return;
  const t = playheadTick();
  const marks = diff.events.filter((e) => e.type === 'section' || e.type === 'bookmark').map((e) => e.t);
  const target = dir > 0 ? marks.find((m) => m > t) : [...marks].reverse().find((m) => m < t);
  if (target !== undefined) seekTick(target);
  else toast(dir > 0 ? 'No marker after the playhead' : 'No marker before the playhead', 'info', 1200);
};

// ---------------------------------------------------------------- timing points
let flashTimer = 0;
export const flashRow = (key: string) => {
  clearTimeout(flashTimer);
  editor().set({ flash: key, inspector: 'timing' });
  flashTimer = window.setTimeout(() => editor().set({ flash: null }), 1400);
};

/** Start of the measure containing `tick` */
export const measureStartAt = (tick: number): number => {
  const tm = editor().timing;
  if (!tm) return 0;
  const sig = tm.signatureAt(tick);
  const mt = (PPQ * 4 * sig.num) / sig.den;
  return sig.t + Math.floor((tick - sig.t) / mt) * mt;
};

export const addSpeedPoint = (tick: number, mult?: number): boolean => {
  const s = editor();
  if (!s.chart || !s.timing) return false;
  const t = s.chart.timing;
  if (t.speed.some((p) => p.t === tick)) {
    flashRow(`speed:${tick}`);
    toast(`A speed point already sits at ${s.timing.beatLabel(tick)}. Edit it in the list, or move the playhead (click the ruler)`, 'info', 3600);
    return false;
  }
  const m = mult ?? Math.round(s.timing.speedAtMs(s.timing.tickToMs(tick)) * 100) / 100;
  s.commit('Add speed point', { ...s.chart, timing: { ...t, speed: [...t.speed, { t: tick, mult: m }].sort((a, b) => a.t - b.t) } }, { keepSelection: true });
  flashRow(`speed:${tick}`);
  return true;
};

export const addBpmPoint = (tick: number, apply: (timing: Chart['timing']) => void): boolean => {
  const s = editor();
  if (!s.chart || !s.timing) return false;
  const t = s.chart.timing;
  if (t.bpm.some((p) => p.t === tick)) {
    flashRow(`bpm:${tick}`);
    toast(`A BPM point already sits at ${s.timing.beatLabel(tick)}. Edit it in the list, or move the playhead (click the ruler)`, 'info', 3600);
    return false;
  }
  apply({ ...t, bpm: [...t.bpm, { t: tick, bpm: s.timing.bpmAt(tick) }].sort((a, b) => a.t - b.t) });
  flashRow(`bpm:${tick}`);
  return true;
};

export const addSignaturePoint = (tick: number, apply: (timing: Chart['timing']) => void): boolean => {
  const s = editor();
  if (!s.chart || !s.timing) return false;
  const t = s.chart.timing;
  const at = measureStartAt(tick);
  if (t.signatures.some((p) => p.t === at)) {
    flashRow(`sig:${at}`);
    toast(
      at === 0
        ? 'Measure 1 already has a signature: edit it in the list, or move the playhead into a later measure'
        : `Measure ${s.timing.beatLabel(at).split('.')[0]} already has a signature: edit it in the list`,
      'info',
      3600,
    );
    return false;
  }
  const cur = s.timing.signatureAt(at);
  apply({ ...t, signatures: [...t.signatures, { t: at, num: cur.num === 3 ? 4 : 3, den: cur.den }].sort((a, b) => a.t - b.t) });
  flashRow(`sig:${at}`);
  return true;
};

// ---------------------------------------------------------------- patterns
export const stampPattern = (notes: Note[]) => {
  if (!notes.length) return;
  editor().set({ stamp: notes, tool: 'select' });
  toast('Click to stamp · Shift+click keeps stamping · right-click cancels', 'info', 2600);
};

export const selectionAsPattern = (): Note[] => toRelative([...sel()].sort(compareNotes));

// ---------------------------------------------------------------- command registry
export interface Command {
  id: string;
  label: string;
  group: 'Transport' | 'Edit' | 'Tools' | 'Selection' | 'Transform' | 'View' | 'Markers' | 'Chart';
  keys?: string[];   // display + matching, e.g. 'Ctrl+Z', 'Shift+R', 'Space'
  run: () => void;
  /** keep the key working while typing in no input (always) */
  repeat?: boolean;
}

/** Registered by the screen (needs React-side callbacks: save, test play…) */
export interface ScreenHooks {
  save: () => void;
  exportNarg: () => void;
  testPlay: (autoplay: boolean, fromSelection?: boolean) => void;
  palette: () => void;
  shortcuts: () => void;
  tour: () => void;
  back: () => void;
  tapTempo: () => void;
}

export const buildCommands = (h: ScreenHooks): Command[] => [
  // transport
  { id: 'play', label: 'Play / pause', group: 'Transport', keys: ['Space'], run: togglePlay },
  { id: 'test', label: 'Test play from the playhead (▶ TEST flag)', group: 'Transport', keys: ['F5'], run: () => h.testPlay(false) },
  { id: 'testsel', label: 'Test play from the selection', group: 'Transport', keys: ['Ctrl+F5'], run: () => h.testPlay(false, true) },
  { id: 'autoplay', label: 'Autoplay preview from the playhead', group: 'Transport', keys: ['Shift+F5'], run: () => h.testPlay(true) },
  { id: 'record', label: 'Toggle record mode (play with your lane keys)', group: 'Transport', keys: ['R'], run: toggleRecord },
  { id: 'start', label: 'Go to start', group: 'Transport', keys: ['Home'], run: seekStart },
  { id: 'end', label: 'Go to last note', group: 'Transport', keys: ['End'], run: seekEnd },
  { id: 'prevm', label: 'Previous measure', group: 'Transport', keys: ['PageUp'], run: () => seekByMeasures(-1), repeat: true },
  { id: 'nextm', label: 'Next measure', group: 'Transport', keys: ['PageDown'], run: () => seekByMeasures(1), repeat: true },
  { id: 'metro', label: 'Toggle metronome', group: 'Transport', keys: ['N'], run: () => editor().set({ metronome: !editor().metronome }) },
  { id: 'hits', label: 'Toggle hitsounds', group: 'Transport', keys: ['H'], run: () => editor().set({ hitsounds: !editor().hitsounds }) },
  { id: 'slower', label: 'Slower playback (pitch kept)', group: 'Transport', keys: ['Shift+['], run: () => stepRate(-1) },
  { id: 'faster', label: 'Faster playback', group: 'Transport', keys: ['Shift+]'], run: () => stepRate(1) },
  ...EDITOR_RATES.map((r): Command => ({ id: `rate${r}`, label: `Playback rate ${Math.round(r * 100)}%`, group: 'Transport', run: () => void setRate(r) })),
  { id: 'tap', label: 'Tap tempo', group: 'Chart', keys: ['T'], run: h.tapTempo },

  // edit
  { id: 'undo', label: 'Undo', group: 'Edit', keys: ['Ctrl+Z'], run: () => editor().undo(), repeat: true },
  { id: 'redo', label: 'Redo', group: 'Edit', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], run: () => editor().redo(), repeat: true },
  { id: 'copy', label: 'Copy', group: 'Edit', keys: ['Ctrl+C'], run: () => copySelection() },
  { id: 'cut', label: 'Cut', group: 'Edit', keys: ['Ctrl+X'], run: () => copySelection(true) },
  { id: 'paste', label: 'Paste at the playhead', group: 'Edit', keys: ['Ctrl+V'], run: pasteAtPlayhead },
  { id: 'dup', label: 'Duplicate selection after itself', group: 'Edit', keys: ['Ctrl+D'], run: duplicateSelection },
  { id: 'del', label: 'Delete selection', group: 'Edit', keys: ['Delete', 'Backspace'], run: deleteSelection },
  { id: 'save', label: 'Save to library', group: 'Chart', keys: ['Ctrl+S'], run: h.save },
  { id: 'export', label: 'Export .narg file', group: 'Chart', keys: ['Ctrl+E'], run: h.exportNarg },

  // tools
  ...TOOLS.map((t): Command => ({ id: `tool-${t.id}`, label: `Tool: ${t.label}`, group: 'Tools', keys: [t.key], run: () => setTool(t.id) })),
  { id: 'finer', label: 'Finer snap', group: 'Tools', keys: [']'], run: () => snapBy(1) },
  { id: 'coarser', label: 'Coarser snap', group: 'Tools', keys: ['['], run: () => snapBy(-1) },

  // selection
  { id: 'all', label: 'Select all', group: 'Selection', keys: ['Ctrl+A'], run: selectAll },
  { id: 'none', label: 'Clear selection / cancel stamp', group: 'Selection', keys: ['Escape'], run: () => editor().set({ selection: new Set(), stamp: null }) },
  { id: 'after', label: 'Select everything after the playhead', group: 'Selection', run: selectAfterPlayhead },
  { id: 'up', label: 'Keep only up-lane notes in selection', group: 'Selection', run: () => selectWhere((n) => n.lane === 0) },
  { id: 'down', label: 'Keep only down-lane notes in selection', group: 'Selection', run: () => selectWhere((n) => n.lane === 1) },
  ...(['tap', 'big', 'hold', 'mash', 'roll', 'mine', 'collect'] as NoteType[]).map((t): Command => ({
    id: `only-${t}`, label: `Keep only ${t} notes in selection`, group: 'Selection', run: () => selectWhere((n) => n.type === t),
  })),
  { id: 'left', label: 'Nudge earlier (or move the playhead)', group: 'Selection', keys: ['ArrowLeft'], run: () => nudge(-1) || seekBySteps(-1), repeat: true },
  { id: 'right', label: 'Nudge later (or move the playhead)', group: 'Selection', keys: ['ArrowRight'], run: () => nudge(1) || seekBySteps(1), repeat: true },
  { id: 'lane', label: 'Swap lane of selection', group: 'Selection', keys: ['ArrowUp', 'ArrowDown'], run: () => nudge(0, 1) },

  // transforms
  { id: 'mirror', label: 'Mirror lanes', group: 'Transform', keys: ['M'], run: mirror },
  { id: 'reverse', label: 'Reverse in time', group: 'Transform', keys: ['Shift+R'], run: reverse },
  { id: 'x2', label: 'Stretch ×2', group: 'Transform', keys: ['Shift+.'], run: () => stretch(2) },
  { id: 'x05', label: 'Compress ×½', group: 'Transform', keys: ['Shift+,'], run: () => stretch(0.5) },
  { id: 'x15', label: 'Stretch ×1.5', group: 'Transform', run: () => stretch(1.5) },
  { id: 'quant', label: 'Quantize to snap', group: 'Transform', keys: ['Q'], run: quantizeSel },
  ...TOOLS.filter((t) => t.id !== 'select' && t.id !== 'erase').map((t): Command => ({
    id: `conv-${t.id}`, label: `Convert selection to ${t.label}`, group: 'Transform', keys: [`Shift+${t.key}`], run: () => convertSel(t.id as NoteType),
  })),

  // markers
  { id: 'bookmark', label: 'Add bookmark at playhead', group: 'Markers', keys: ['B'], run: () => addEvent('bookmark') },
  { id: 'section', label: 'Add section marker at playhead', group: 'Markers', keys: ['Shift+B'], run: () => addEvent('section') },
  { id: 'flash', label: 'Add flash event at playhead', group: 'Markers', run: () => addEvent('flash') },
  { id: 'hide', label: 'Add hide-lane event at playhead', group: 'Markers', run: () => addEvent('hideLane') },
  { id: 'nextmark', label: 'Jump to next marker', group: 'Markers', keys: ['Alt+ArrowRight'], run: () => jumpMarker(1) },
  { id: 'prevmark', label: 'Jump to previous marker', group: 'Markers', keys: ['Alt+ArrowLeft'], run: () => jumpMarker(-1) },

  // view
  { id: 'zin', label: 'Zoom in', group: 'View', keys: ['='], run: () => zoomBy(1.25), repeat: true },
  { id: 'zout', label: 'Zoom out', group: 'View', keys: ['-'], run: () => zoomBy(0.8), repeat: true },
  { id: 'follow', label: 'Toggle follow playhead', group: 'View', keys: ['Shift+F'], run: () => editor().set({ follow: !editor().follow }) },
  { id: 'palette', label: 'Command palette', group: 'View', keys: ['Ctrl+K'], run: h.palette },
  { id: 'keys', label: 'Keyboard shortcuts', group: 'View', keys: ['?'], run: h.shortcuts },
  { id: 'tour', label: 'Replay the editor tour', group: 'View', run: h.tour },
  { id: 'inspNote', label: 'Panel: Note', group: 'View', run: () => editor().set({ inspector: 'note' }) },
  { id: 'inspTiming', label: 'Panel: Timing', group: 'View', run: () => editor().set({ inspector: 'timing' }) },
  { id: 'inspChart', label: 'Panel: Chart & difficulties', group: 'View', run: () => editor().set({ inspector: 'chart' }) },
  { id: 'inspLint', label: 'Panel: Lint', group: 'View', run: () => editor().set({ inspector: 'lint' }) },
  { id: 'inspPat', label: 'Panel: Patterns', group: 'View', run: () => editor().set({ inspector: 'patterns' }) },
  { id: 'back', label: 'Leave the editor', group: 'Chart', run: h.back },
];

// ---------------------------------------------------------------- key matching
const KEY_NAMES: Record<string, string> = {
  Space: 'Space', Escape: 'Escape', Delete: 'Delete', Backspace: 'Backspace', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-', Comma: ',', Period: '.', Slash: '/',
  F5: 'F5',
};

/** Normalises a keydown to the strings used in `keys` (layout-independent for letters/digits) */
export const comboOf = (e: KeyboardEvent): string[] => {
  let base: string | undefined;
  if (e.code.startsWith('Key')) base = e.code.slice(3);
  else if (e.code.startsWith('Digit')) base = e.code.slice(5);
  else if (e.code.startsWith('Numpad') && /\d$/.test(e.code)) base = e.code.slice(6);
  else base = KEY_NAMES[e.code];
  if (!base) return [];
  const mods = `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}`;
  const out = [`${mods}${base}`];
  // '?' is Shift+/ on most layouts: accept the printed character too
  if (e.key === '?') out.push('?');
  return out;
};

/** Display form of a key string */
export const prettyKey = (k: string) =>
  k.replace('Arrow', '').replace('Left', '←').replace('Right', '→').replace('Up', '↑').replace('Down', '↓').replace('Escape', 'Esc').replace('Delete', 'Del');

export const isSpanType = (t: Tool) => SPAN_TYPES.has(t as NoteType);
export type { Lane };
