import { create } from 'zustand';
import bundled from 'virtual:bundled-charts';
import { audio } from '../../core/audio/AudioEngine';
import { packNarg, parseChart, unpackNarg } from '../../core/chart/serialize';
import type { Chart } from '../../core/chart/types';
import { songsDb } from '../../storage/db';

export interface SongEntry {
  id: string;
  chart: Chart;
  builtin: boolean;
  updatedAt: number;
}

interface LibraryStore {
  songs: SongEntry[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

// ---------------------------------------------------------------- built-in songs
/** The built-in chart listed first in song select */
const FIRST_FILE = 'fearless-pt2.narg';

/** Every charts/*.narg shipped with the app (see the bundled-charts plugin in vite.config.ts) */
const BUILTINS = bundled
  .flatMap(({ file, url, chart }) => {
    try {
      return [{ file, url, chart: parseChart(chart) }];
    } catch (e) {
      console.error(`Skipping bundled chart ${file}:`, e);
      return [];
    }
  })
  .sort((a, b) => Number(b.file === FIRST_FILE) - Number(a.file === FIRST_FILE));

const builtinById = new Map(BUILTINS.map((b) => [b.chart.id, b]));
export const isBuiltinSong = (id: string): boolean => builtinById.has(id);

const builtinEntries = (): SongEntry[] =>
  BUILTINS.map((b): SongEntry => ({ id: b.chart.id, chart: b.chart, builtin: true, updatedAt: 0 }));

/** Raw audio of a built-in song: the .narg is fetched once, on first use */
const builtinAudio = new Map<string, Promise<{ name: string; data: ArrayBuffer }>>();
const getBuiltinAudio = (id: string) => {
  let p = builtinAudio.get(id);
  if (!p) {
    const b = builtinById.get(id)!;
    p = fetch(b.url)
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load ${b.file} (${res.status})`);
        return res.arrayBuffer();
      })
      .then((bytes) => {
        const pkg = unpackNarg(new Uint8Array(bytes));
        return { name: pkg.audio.name, data: pkg.audio.data.slice().buffer as ArrayBuffer };
      });
    p.catch(() => builtinAudio.delete(id));
    builtinAudio.set(id, p);
  }
  return p;
};

export const useLibrary = create<LibraryStore>((set) => ({
  songs: builtinEntries(),
  loaded: false,
  refresh: async () => {
    const records = await songsDb.all().catch(() => []);
    const user = records
      .filter((r) => !builtinById.has(r.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r): SongEntry => ({ id: r.id, chart: r.chart, builtin: false, updatedAt: r.updatedAt }));
    set({ songs: [...builtinEntries(), ...user], loaded: true });
  },
}));

// ---------------------------------------------------------------- audio cache
const bufferCache = new Map<string, Promise<AudioBuffer>>();
const CACHE_SIZE = 4;

export const getSongBuffer = (id: string): Promise<AudioBuffer> => {
  let p = bufferCache.get(id);
  if (!p) {
    p = getSongAudioBytes(id).then((a) => audio.decode(a.data));
    p.catch(() => bufferCache.delete(id));
    bufferCache.set(id, p);
    if (bufferCache.size > CACHE_SIZE) bufferCache.delete(bufferCache.keys().next().value!);
  }
  return p;
};

export const invalidateSongBuffer = (id: string) => bufferCache.delete(id);

/** Raw audio bytes (for the editor / export) */
export const getSongAudioBytes = async (id: string): Promise<{ name: string; data: ArrayBuffer }> => {
  if (builtinById.has(id)) return getBuiltinAudio(id);
  const rec = await songsDb.get(id);
  if (!rec) throw new Error('Song not found');
  return { name: rec.audioName, data: rec.audio };
};

// ---------------------------------------------------------------- mutations
export const saveSong = async (chart: Chart, audioName: string, audioData: ArrayBuffer): Promise<void> => {
  const prev = await songsDb.get(chart.id);
  await songsDb.put({
    id: chart.id,
    chart,
    audioName,
    audio: audioData,
    createdAt: prev?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  });
  if (prev && prev.audio.byteLength !== audioData.byteLength) invalidateSongBuffer(chart.id);
  await useLibrary.getState().refresh();
};

export const deleteSong = async (id: string): Promise<void> => {
  await songsDb.remove(id);
  invalidateSongBuffer(id);
  await useLibrary.getState().refresh();
};

export const importNargFile = async (file: File): Promise<Chart> => {
  const pkg = unpackNarg(new Uint8Array(await file.arrayBuffer()));
  // importing a built-in song (or an export of one) makes its own copy instead of shadowing it
  if (builtinById.has(pkg.chart.id)) pkg.chart.id = `${pkg.chart.id}-copy-${Date.now().toString(36)}`;
  const data = pkg.audio.data.slice().buffer as ArrayBuffer;
  await audio.decode(data); // fail early on undecodable audio
  await saveSong(pkg.chart, pkg.audio.name, data);
  return pkg.chart;
};

export const buildNarg = async (chart: Chart, audioName: string, audioData: ArrayBuffer): Promise<Blob> => {
  const bytes = packNarg({ chart, audio: { name: audioName, data: new Uint8Array(audioData) } });
  return new Blob([bytes as BlobPart], { type: 'application/zip' });
};

export const exportSong = async (id: string): Promise<void> => {
  const entry = useLibrary.getState().songs.find((s) => s.id === id);
  if (!entry) return;
  const { name, data } = await getSongAudioBytes(id);
  downloadBlob(await buildNarg(entry.chart, name, data), `${slug(entry.chart.meta.artist)}-${slug(entry.chart.meta.title)}.narg`);
};

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chart';

export const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};
