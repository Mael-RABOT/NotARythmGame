/// <reference lib="webworker" />
/**
 * Audio analysis off the main thread:
 *  - peaks: min/max mipmaps of the mono mix for an O(visible pixels) waveform at any zoom
 *  - tempo: onset-strength envelope → autocorrelation → BPM, then phase fit → offset
 */
import { computePeaks, detectTempo } from './analysisCore';

export type AnalysisRequest =
  | { id: number; type: 'peaks'; samples: Float32Array; sampleRate: number }
  | { id: number; type: 'tempo'; samples: Float32Array; sampleRate: number };

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const req = e.data;
  if (req.type === 'peaks') {
    const peaks = computePeaks(req.samples, req.sampleRate);
    const transfer = peaks.levels.flatMap((l) => [l.min.buffer, l.max.buffer]) as ArrayBuffer[];
    (self as unknown as Worker).postMessage({ id: req.id, result: peaks }, transfer);
  } else if (req.type === 'tempo') {
    (self as unknown as Worker).postMessage({ id: req.id, result: detectTempo(req.samples, req.sampleRate) });
  }
};
