import { create } from 'zustand';
import { audio } from '../../core/audio/AudioEngine';
import { encodeWav } from '../../core/audio/synth';
import { packNarg, unpackNarg } from '../../core/chart/serialize';
import type { Chart } from '../../core/chart/types';
import { DEMO_ID, buildDemoChart, renderDemoAudio } from '../../core/demo/demoSong';
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

const demoEntry = (): SongEntry => ({ id: DEMO_ID, chart: buildDemoChart(), builtin: true, updatedAt: 0 });

export const useLibrary = create<LibraryStore>((set) => ({
  songs: [demoEntry()],
  loaded: false,
  refresh: async () => {
    const records = await songsDb.all().catch(() => []);
    const user = records
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r): SongEntry => ({ id: r.id, chart: r.chart, builtin: false, updatedAt: r.updatedAt }));
    set({ songs: [demoEntry(), ...user], loaded: true });
  },
}));

// ---------------------------------------------------------------- audio cache
const bufferCache = new Map<string, Promise<AudioBuffer>>();
const CACHE_SIZE = 4;

let demoBuffer: Promise<AudioBuffer> | null = null;
const getDemoBuffer = () => (demoBuffer ??= renderDemoAudio(audio.context.sampleRate));

export const getSongBuffer = (id: string): Promise<AudioBuffer> => {
  if (id === DEMO_ID) return getDemoBuffer();
  let p = bufferCache.get(id);
  if (!p) {
    p = songsDb.get(id).then((rec) => {
      if (!rec) throw new Error('Song not found');
      return audio.decode(rec.audio);
    });
    p.catch(() => bufferCache.delete(id));
    bufferCache.set(id, p);
    if (bufferCache.size > CACHE_SIZE) bufferCache.delete(bufferCache.keys().next().value!);
  }
  return p;
};

export const invalidateSongBuffer = (id: string) => bufferCache.delete(id);

/** Raw audio bytes (for the editor / export). The demo is encoded to WAV on demand. */
export const getSongAudioBytes = async (id: string): Promise<{ name: string; data: ArrayBuffer }> => {
  if (id === DEMO_ID) {
    const wav = encodeWav(await getDemoBuffer(), 1);
    return { name: 'warmup.wav', data: wav.buffer as ArrayBuffer };
  }
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
  // a re-import of the demo or of an existing id becomes its own copy only if ids clash with built-ins
  if (pkg.chart.id === DEMO_ID) pkg.chart.id = `${DEMO_ID}-copy-${Date.now().toString(36)}`;
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
