import { audio } from '../../core/audio/AudioEngine';
import { computePeaksAsync, detectTempoAsync } from '../../core/audio/analysis';
import { parseChart, unpackNarg } from '../../core/chart/serialize';
import { createEmptyChart, newId, type Chart } from '../../core/chart/types';
import { settings } from '../../storage/settings';
import { applyTiming } from '../../core/editor/ops';
import { autosaveDb, songsDb, type AutosaveRecord } from '../../storage/db';
import { toast } from '../components/overlays';
import { go } from '../store/app';
import { buildNarg, downloadBlob, getSongAudioBytes, getSongBuffer, saveSong, slug, useLibrary } from '../store/library';
import { currentDiff, editor } from './store';

const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|aac|opus|webm)$/i;
export const isAudioFile = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
export const isNargFile = (f: File) => /\.narg$/i.test(f.name) || f.type === 'application/zip';

const titleFromFile = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled';

const afterLoad = (buffer: AudioBuffer) => {
  computePeaksAsync(buffer)
    .then((p) => {
      if (editor().buffer === buffer) editor().setPeaks(p);
    })
    .catch(() => undefined);
};

/** Starts a brand new chart from an audio file (or opens a dropped .narg) */
export const openFile = async (file: File): Promise<void> => {
  if (isNargFile(file)) {
    const pkg = unpackNarg(new Uint8Array(await file.arrayBuffer()));
    const data = pkg.audio.data.slice().buffer as ArrayBuffer;
    const buffer = await audio.decode(data.slice(0));
    const inLibrary = !!(await songsDb.get(pkg.chart.id).catch(() => undefined));
    editor().load({ songId: pkg.chart.id, chart: pkg.chart, audioName: pkg.audio.name, audioData: data, buffer, inLibrary });
    afterLoad(buffer);
    toast(`Opened “${pkg.chart.meta.title}”`, 'success');
    return;
  }
  if (!isAudioFile(file)) throw new Error('Not an audio file');
  const data = await file.arrayBuffer();
  const buffer = await audio.decode(data.slice(0));
  const chart = createEmptyChart(titleFromFile(file.name), file.name);
  const dash = chart.meta.title.indexOf(' - ');
  if (dash > 0) {
    chart.meta.artist = chart.meta.title.slice(0, dash).trim();
    chart.meta.title = chart.meta.title.slice(dash + 3).trim();
  }
  chart.meta.previewStartMs = Math.round(buffer.duration * 1000 * 0.35);
  editor().load({ songId: null, chart, audioName: file.name, audioData: data, buffer, inLibrary: false });
  afterLoad(buffer);
  detectTempo(true);
};

/** Opens a library song (built-in songs open as an editable copy) */
export const openSong = async (songId: string): Promise<void> => {
  const entry = useLibrary.getState().songs.find((s) => s.id === songId);
  const rec = entry?.builtin ? undefined : await songsDb.get(songId);
  if (!entry && !rec) throw new Error('Song not found');
  const chart = structuredClone(rec?.chart ?? entry!.chart);
  const [{ name, data }, buffer] = await Promise.all([getSongAudioBytes(songId), getSongBuffer(songId)]);
  if (entry?.builtin) {
    chart.id = newId();
    chart.meta.title = `${chart.meta.title} (copy)`;
    chart.meta.charter = 'You';
  }
  editor().load({ songId: chart.id, chart, audioName: name, audioData: data, buffer, inLibrary: !entry?.builtin });
  afterLoad(buffer);
  // newer unsaved work for this song?
  const auto = await autosaveDb.get(chart.id).catch(() => undefined);
  if (auto && rec && auto.at > rec.updatedAt + 1000) editor().set({ pendingRestore: auto });
};

export const restoreAutosave = async (rec: AutosaveRecord): Promise<void> => {
  const chart = parseChart(rec.chart);
  const buffer = await audio.decode(rec.audio.slice(0));
  const inLibrary = !!(await songsDb.get(chart.id).catch(() => undefined));
  editor().load({ songId: chart.id, chart, audioName: rec.audioName, audioData: rec.audio, buffer, inLibrary });
  editor().set({ dirty: true });
  afterLoad(buffer);
  toast('Restored your unsaved session', 'success');
};

// ---------------------------------------------------------------- tempo
export const detectTempo = async (auto = false): Promise<void> => {
  const s = editor();
  if (!s.buffer || s.tempoBusy) return;
  s.set({ tempoBusy: true });
  try {
    const result = await detectTempoAsync(s.buffer);
    if (editor().buffer !== s.buffer) return;
    editor().set({ tempo: result });
    if (auto) toast(`Detected ~${result.bpm} BPM. Check the Timing panel to apply it`, 'info', 4000);
  } catch {
    toast('Tempo detection failed', 'error');
  } finally {
    editor().set({ tempoBusy: false });
  }
};

/** Applies a BPM/offset guess: single BPM point, offset on the first beat */
export const applyTempo = (bpm: number, offsetMs: number) => {
  const s = editor();
  if (!s.chart) return;
  // tick 0 = the detected downbeat, pulled back by whole measures so the intro stays chartable
  const sig = s.chart.timing.signatures[0];
  const measure = (60000 / bpm) * sig.num * (4 / sig.den);
  let off = offsetMs % measure;
  if (off < 0) off += measure;
  const timing = { ...s.chart.timing, bpm: [{ t: 0, bpm }] };
  const hasNotes = s.chart.difficulties.some((d) => d.notes.length);
  s.commit('Apply detected tempo', applyTiming(s.chart, timing, Math.round(off * 10) / 10, hasNotes), { keepSelection: false });
  s.set({ tempo: null });
};

// ---------------------------------------------------------------- persistence
let lastAutosaved: Chart | null = null;

export const autosaveNow = async (): Promise<void> => {
  const s = editor();
  if (!s.chart || !s.audioData || !s.dirty || s.chart === lastAutosaved) return;
  lastAutosaved = s.chart;
  await autosaveDb.put({ id: s.chart.id, chart: s.chart, audioName: s.audioName, audio: s.audioData, at: Date.now() }).catch(() => undefined);
};

export const save = async (): Promise<boolean> => {
  const s = editor();
  if (!s.chart || !s.audioData) return false;
  try {
    // keep difficulty notes sorted & sane before writing
    const chart = parseChart(s.chart);
    await saveSong(chart, s.audioName, s.audioData);
    editor().markSaved(chart.id);
    await autosaveDb.remove(chart.id).catch(() => undefined);
    lastAutosaved = null;
    toast(`Saved “${chart.meta.title}” to your library`, 'success');
    return true;
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${(e as Error).message}`, 'error');
    return false;
  }
};

export const exportNarg = async (): Promise<void> => {
  const s = editor();
  if (!s.chart || !s.audioData) return;
  const chart = parseChart(s.chart);
  downloadBlob(await buildNarg(chart, s.audioName, s.audioData), `${slug(chart.meta.artist)}-${slug(chart.meta.title)}.narg`);
  toast('Exported .narg: share it, anyone can drop it into the game', 'success', 3200);
};

// ---------------------------------------------------------------- test play
/**
 * Where test play starts: the playhead (live while playing) snapped down to the beat,
 * or the first selected note's beat with `fromSelection`. Shown on the ruler as "▶ TEST".
 */
/** Where a test play starts (ms): exactly the playhead (live while playing), or the first selected note */
const testStartMs = (fromSelection: boolean): number => {
  const s = editor();
  if (!s.timing) return 0;
  if (fromSelection && s.selection.size) return s.timing.tickToMs(Math.min(...[...s.selection].map((n) => n.t)));
  return s.playing ? audio.songMsAt(performance.now()) - settings().audioOffsetMs : s.cursorMs;
};

export const testPlay = (autoplay: boolean, fromSelection = false) => {
  const s = editor();
  const diff = currentDiff();
  if (!s.chart || !diff || !s.buffer || !s.timing) return;
  if (!diff.notes.length) {
    toast('Place a few notes first', 'info');
    return;
  }
  if (fromSelection && !s.selection.size) {
    toast('Select a note to test from it', 'info');
    return;
  }
  const startMs = Math.max(0, testStartMs(fromSelection));
  if (!diff.notes.some((n) => s.timing!.tickToMs(n.t) >= startMs)) {
    toast('No notes after the test start. Move the playhead back (Home)', 'info');
    return;
  }
  if (s.playing) audio.pause();
  // the editor comes back with its cursor at the test start: F5 again = same test
  s.set({ playing: false, cursorMs: startMs });
  let rate = s.rate;
  if (rate < 0.5) {
    rate = 1;
    toast('Test play runs at 100% below 50% editor speed', 'info', 2400);
  }
  let chart: Chart;
  try {
    chart = parseChart(s.chart);
  } catch (e) {
    toast(`Chart error: ${(e as Error).message}`, 'error');
    return;
  }
  go({
    name: 'play',
    request: { songId: chart.id, chart, diffId: diff.id, buffer: s.buffer, options: { fromEditor: true, autoplay, startMs, rate } },
  });
};
