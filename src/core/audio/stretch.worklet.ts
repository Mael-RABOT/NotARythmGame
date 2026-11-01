/**
 * AudioWorklet: pitch-preserving slow playback (editor 10–75 %).
 * Messages:
 *   { type: 'load', channels: Float32Array[] }
 *   { type: 'play', startFrame, srcSample, rate }   start is sample-accurate on the ctx clock
 *   { type: 'stop' }
 * Posts { type: 'ended' } once the source is exhausted.
 */
import { WsolaStretcher } from './wsola';

declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Msg =
  | { type: 'load'; channels: Float32Array[] }
  | { type: 'play'; startFrame: number; srcSample: number; rate: number }
  | { type: 'stop' };

class StretchProcessor extends AudioWorkletProcessor {
  private st: WsolaStretcher | null = null;
  private playing = false;
  private startFrame = 0;
  private ended = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Msg>) => {
      const m = e.data;
      if (m.type === 'load') {
        this.st = new WsolaStretcher(m.channels);
        this.playing = false;
      } else if (m.type === 'play' && this.st) {
        this.st.seek(m.srcSample, m.rate);
        this.startFrame = m.startFrame;
        this.playing = true;
        this.ended = false;
      } else if (m.type === 'stop') {
        this.playing = false;
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out?.length) return true;
    const frames = out[0].length;
    if (!this.playing || !this.st) return true; // outputs are pre-zeroed
    const skip = Math.min(frames, Math.max(0, this.startFrame - currentFrame));
    if (skip < frames) this.st.process(out, frames - skip, skip);
    if (!this.ended && this.st.position > this.st.length + 2048) {
      this.ended = true;
      this.playing = false;
      this.port.postMessage({ type: 'ended' });
    }
    return true;
  }
}

registerProcessor('narg-stretch', StretchProcessor);
