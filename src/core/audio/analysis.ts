import type { AnalysisRequest } from '../workers/analysis.worker';
import type { Peaks, TempoResult } from '../workers/analysisCore';

/** Promise wrapper around the analysis worker (one shared worker, request ids) */
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();

const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result: unknown }>) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
  }
  return worker;
};

const mono = (buffer: AudioBuffer): Float32Array => {
  const out = new Float32Array(buffer.length);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / ch;
  }
  return out;
};

const request = <T>(type: AnalysisRequest['type'], buffer: AudioBuffer): Promise<T> => {
  const id = nextId++;
  const samples = mono(buffer);
  return new Promise<T>((resolve) => {
    pending.set(id, resolve as (v: unknown) => void);
    getWorker().postMessage({ id, type, samples, sampleRate: buffer.sampleRate } satisfies AnalysisRequest, [samples.buffer]);
  });
};

export const computePeaksAsync = (buffer: AudioBuffer) => request<Peaks>('peaks', buffer);
export const detectTempoAsync = (buffer: AudioBuffer) => request<TempoResult>('tempo', buffer);
export type { Peaks, TempoResult };
