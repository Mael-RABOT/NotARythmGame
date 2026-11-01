import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import {
  EVENT_TYPES,
  FORMAT_VERSION,
  NOTE_TYPES,
  SPAN_TYPES,
  compareNotes,
  newId,
  type Chart,
  type ChartEvent,
  type Difficulty,
  type Note,
} from './types';

export class ChartError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const parseNote = (v: unknown): Note | null => {
  if (!isObj(v)) return null;
  const type = NOTE_TYPES.includes(v.type as Note['type']) ? (v.type as Note['type']) : null;
  if (!type) return null;
  const note: Note = { t: Math.round(num(v.t, -1)), lane: v.lane === 1 ? 1 : 0, type };
  if (note.t < 0) return null;
  if (SPAN_TYPES.has(type)) note.dur = Math.max(1, Math.round(num(v.dur, 48)));
  if (type === 'mash') note.hits = Math.max(1, Math.round(num(v.hits, 10)));
  return note;
};

const parseEvent = (v: unknown): ChartEvent | null => {
  if (!isObj(v) || !EVENT_TYPES.includes(v.type as ChartEvent['type'])) return null;
  const e: ChartEvent = { t: Math.max(0, Math.round(num(v.t, 0))), type: v.type as ChartEvent['type'] };
  if (typeof v.label === 'string') e.label = v.label.slice(0, 64);
  if (v.lane === 0 || v.lane === 1) e.lane = v.lane;
  if (typeof v.dur === 'number') e.dur = Math.max(0, Math.round(v.dur));
  return e;
};

/** Validates untrusted JSON into a Chart (migrating old format versions). Throws ChartError. */
export const parseChart = (raw: unknown): Chart => {
  if (!isObj(raw)) throw new ChartError('chart.json is not an object');
  const version = num(raw.formatVersion, 1);
  if (version > FORMAT_VERSION) throw new ChartError(`Chart format v${version} is newer than this app (v${FORMAT_VERSION}). Update the game.`);
  // (future migrations go here: if (version < 2) raw = migrate1to2(raw) ...)

  const meta = isObj(raw.meta) ? raw.meta : {};
  const audio = isObj(raw.audio) ? raw.audio : {};
  const timing = isObj(raw.timing) ? raw.timing : {};

  const bpm = arr(timing.bpm)
    .filter(isObj)
    .map((p) => ({ t: Math.max(0, Math.round(num(p.t, 0))), bpm: Math.min(2000, Math.max(1, num(p.bpm, 120))) }))
    .sort((a, b) => a.t - b.t);
  if (!bpm.length || bpm[0].t !== 0) bpm.unshift({ t: 0, bpm: bpm[0]?.bpm ?? 120 });

  const signatures = arr(timing.signatures)
    .filter(isObj)
    .map((p) => ({ t: Math.max(0, Math.round(num(p.t, 0))), num: Math.min(32, Math.max(1, Math.round(num(p.num, 4)))), den: [1, 2, 4, 8, 16].includes(num(p.den, 4)) ? num(p.den, 4) : 4 }))
    .sort((a, b) => a.t - b.t);
  if (!signatures.length || signatures[0].t !== 0) signatures.unshift({ t: 0, num: 4, den: 4 });

  const speed = arr(timing.speed)
    .filter(isObj)
    .map((p) => ({ t: Math.max(0, Math.round(num(p.t, 0))), mult: Math.min(20, Math.max(0.05, num(p.mult, 1))), ...(p.ease === 'linear' ? { ease: 'linear' as const } : {}) }))
    .sort((a, b) => a.t - b.t);
  if (!speed.length || speed[0].t !== 0) speed.unshift({ t: 0, mult: 1 });

  const difficulties: Difficulty[] = arr(raw.difficulties)
    .filter(isObj)
    .map((d) => ({
      id: str(d.id, newId()),
      name: str(d.name, 'Normal').slice(0, 32),
      level: Math.min(20, Math.max(1, Math.round(num(d.level, 5)))),
      notes: arr(d.notes).map(parseNote).filter((n): n is Note => n !== null).sort(compareNotes),
      events: arr(d.events).map(parseEvent).filter((e): e is ChartEvent => e !== null).sort((a, b) => a.t - b.t),
    }));
  if (!difficulties.length) throw new ChartError('The chart has no difficulty');

  return {
    formatVersion: FORMAT_VERSION,
    id: str(raw.id, newId()),
    meta: {
      title: str(meta.title, 'Untitled').slice(0, 120),
      artist: str(meta.artist, 'Unknown').slice(0, 120),
      charter: str(meta.charter, 'Unknown').slice(0, 60),
      source: typeof meta.source === 'string' ? meta.source.slice(0, 120) : undefined,
      tags: arr(meta.tags).filter((t): t is string => typeof t === 'string').slice(0, 16),
      previewStartMs: Math.max(0, num(meta.previewStartMs, 0)),
      coverFile: typeof meta.coverFile === 'string' ? meta.coverFile : undefined,
    },
    audio: { file: str(audio.file, 'audio'), offsetMs: num(audio.offsetMs, 0) },
    timing: { bpm, signatures, speed },
    difficulties,
  };
};

export interface NargPackage {
  chart: Chart;
  audio: { name: string; data: Uint8Array };
  cover?: { name: string; data: Uint8Array };
}

const safeName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'audio';

/** Builds a .narg file (zip). Audio is stored, not re-compressed (it already is). */
export const packNarg = (pkg: NargPackage): Uint8Array => {
  const audioName = `audio_${safeName(pkg.audio.name)}`;
  const chart: Chart = { ...pkg.chart, audio: { ...pkg.chart.audio, file: audioName } };
  const files: Zippable = {
    'chart.json': strToU8(JSON.stringify(chart)),
    [audioName]: [pkg.audio.data, { level: 0 }],
  };
  if (pkg.cover) {
    const coverName = `cover_${safeName(pkg.cover.name)}`;
    chart.meta = { ...chart.meta, coverFile: coverName };
    files['chart.json'] = strToU8(JSON.stringify(chart));
    files[coverName] = [pkg.cover.data, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
};

export const unpackNarg = (data: Uint8Array): NargPackage => {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new ChartError('Not a valid .narg file (bad zip)');
  }
  const json = files['chart.json'];
  if (!json) throw new ChartError('The package has no chart.json');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(json));
  } catch {
    throw new ChartError('chart.json is not valid JSON');
  }
  const chart = parseChart(raw);
  const audio = files[chart.audio.file] ?? Object.entries(files).find(([n]) => n.startsWith('audio'))?.[1];
  if (!audio) throw new ChartError('The package has no audio file');
  const cover = chart.meta.coverFile ? files[chart.meta.coverFile] : undefined;
  return {
    chart,
    audio: { name: chart.audio.file.replace(/^audio_/, ''), data: audio },
    cover: cover && chart.meta.coverFile ? { name: chart.meta.coverFile, data: cover } : undefined,
  };
};
