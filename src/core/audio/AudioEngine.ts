import { renderSfxBank, type SfxName } from './synth';
import stretchWorkletUrl from './stretch.worklet.ts?worker&url';

/**
 * Web Audio wrapper and master clock.
 *
 * Song time is derived from the audio *output* clock, not from frames:
 *   songMs(perf) = anchorSongMs + (ctxTimeAt(perf) - anchorCtx) * 1000 * rate
 * ctxTimeAt() maps performance.now() (and input event timestamps) onto the audio
 * clock using AudioContext.getOutputTimestamp(), smoothed with an EMA so the
 * mapping is jitter-free. That way a key press is judged at its real timestamp
 * and the notes are drawn where the music *sounds*, including output latency.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private sfx: Partial<Record<SfxName, AudioBuffer>> = {};
  private sfxReady: Promise<void> | null = null;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private sourceGain: GainNode | null = null;
  private anchorCtx = 0;
  private anchorSongMs = 0;
  private rate = 1;
  private _playing = false;
  private pausedAt = 0;
  private endedCb: (() => void) | null = null;

  // pitch-preserving slow playback (AudioWorklet + WSOLA)
  private stretchNode: AudioWorkletNode | null = null;
  private stretchReady: Promise<boolean> | null = null;
  private stretchBuffer: AudioBuffer | null = null;
  private stretching = false;

  /** ctxTime ≈ perf/1000 + mapOffset (smoothed) */
  private mapOffset = 0;
  private mapReady = false;

  private lastUiSound = 0;

  get context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.musicBus = this.ctx.createGain();
      this.sfxBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
      this.sfxBus.connect(this.master);
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture once (browsers keep audio locked until then) */
  async unlock(): Promise<void> {
    const ctx = this.context;
    if (ctx.state !== 'running') await ctx.resume();
    await this.loadSfx();
  }

  loadSfx(): Promise<void> {
    if (!this.sfxReady) {
      this.sfxReady = renderSfxBank(this.context.sampleRate).then((bank) => {
        this.sfx = bank;
      });
    }
    return this.sfxReady;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    void this.context; // ensures the graph exists
    this.master.gain.value = master;
    this.musicBus.gain.value = music;
    this.sfxBus.gain.value = sfx;
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    // decodeAudioData detaches the buffer: give it a copy so callers can keep theirs
    return this.context.decodeAudioData(data.slice(0));
  }

  // ---------------------------------------------------------------- clock
  private refreshMap(): void {
    const ctx = this.context;
    const perf = performance.now();
    let ctxNow: number;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime && ts.contextTime !== undefined && ts.performanceTime > 0) {
      ctxNow = ts.contextTime + (perf - ts.performanceTime) / 1000;
    } else {
      ctxNow = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    }
    const sample = ctxNow - perf / 1000;
    if (!this.mapReady || Math.abs(sample - this.mapOffset) > 0.03) {
      this.mapOffset = sample;
      this.mapReady = true;
    } else {
      this.mapOffset += (sample - this.mapOffset) * 0.04;
    }
  }

  /** Audio-clock time (seconds) that is *audible* at the given performance.now() */
  ctxTimeAt(perfMs: number): number {
    return perfMs / 1000 + this.mapOffset;
  }

  /** Call once per frame before reading the song position */
  tick(): void {
    if (this.ctx) this.refreshMap();
  }

  /** Song position (ms, may be negative during lead-in) heard at a performance timestamp */
  songMsAt(perfMs: number): number {
    if (!this._playing) return this.pausedAt;
    return this.anchorSongMs + (this.ctxTimeAt(perfMs) - this.anchorCtx) * 1000 * this.rate;
  }

  get positionMs(): number {
    return this.songMsAt(performance.now());
  }

  get playing(): boolean {
    return this._playing;
  }

  get playbackRate(): number {
    return this.rate;
  }

  get durationMs(): number {
    return this.buffer ? this.buffer.duration * 1000 : 0;
  }

  get currentBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  // ---------------------------------------------------------------- music
  load(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
    this.pausedAt = 0;
  }

  /** Loads the time-stretch worklet once. Resolves false when unsupported. */
  prepareStretch(): Promise<boolean> {
    if (!this.stretchReady) {
      const ctx = this.context;
      this.stretchReady = (async () => {
        if (!ctx.audioWorklet) return false;
        try {
          await ctx.audioWorklet.addModule(stretchWorkletUrl);
          const node = new AudioWorkletNode(ctx, 'narg-stretch', { numberOfInputs: 0, outputChannelCount: [2] });
          const gain = ctx.createGain();
          node.connect(gain).connect(this.musicBus);
          node.port.onmessage = (e: MessageEvent<{ type: string }>) => {
            if (e.data.type === 'ended' && this.stretching) {
              this.stretching = false;
              this._playing = false;
              this.pausedAt = this.durationMs;
              this.endedCb?.();
            }
          };
          this.stretchNode = node;
          return true;
        } catch (e) {
          console.warn('time-stretch unavailable', e);
          return false;
        }
      })();
    }
    return this.stretchReady;
  }

  /**
   * Starts playback so that song time `fromMs` is heard `delaySec` from now.
   * Negative `fromMs` gives a silent lead-in before the file starts.
   * With `keepPitch` and rate < 1 (worklet prepared), the audio is time-stretched.
   */
  play(fromMs: number, rate = 1, delaySec = 0.06, fadeInSec = 0, opts: { keepPitch?: boolean } = {}): void {
    if (!this.buffer) return;
    const ctx = this.context;
    this.stopSource();
    this.refreshMap();
    this.rate = rate;
    const when = ctx.currentTime + delaySec;
    if (opts.keepPitch && rate < 0.999 && this.stretchNode) {
      const node = this.stretchNode;
      if (this.stretchBuffer !== this.buffer) {
        const channels: Float32Array[] = [];
        for (let c = 0; c < this.buffer.numberOfChannels; c++) channels.push(this.buffer.getChannelData(c).slice());
        node.port.postMessage({ type: 'load', channels }, channels.map((c) => c.buffer));
        this.stretchBuffer = this.buffer;
      }
      node.port.postMessage({
        type: 'play',
        startFrame: Math.round(when * ctx.sampleRate),
        srcSample: (fromMs / 1000) * this.buffer.sampleRate,
        rate,
      });
      this.stretching = true;
      this.anchorCtx = when;
      this.anchorSongMs = fromMs;
      this._playing = true;
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    src.connect(gain).connect(this.musicBus);
    if (fadeInSec > 0) {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fadeInSec);
    }
    if (fromMs >= 0) {
      src.start(when, fromMs / 1000);
    } else {
      src.start(when + -fromMs / 1000 / rate, 0);
    }
    src.onended = () => {
      if (this.source === src) {
        this._playing = false;
        this.pausedAt = this.durationMs;
        this.endedCb?.();
      }
    };
    // the output clock lags ctx.currentTime by the output latency: the anchor is on the ctx clock,
    // ctxTimeAt() is on the output clock, so the first sample is heard exactly at song time fromMs
    this.anchorCtx = when;
    this.anchorSongMs = fromMs;
    this.source = src;
    this.sourceGain = gain;
    this._playing = true;
  }

  onEnded(cb: (() => void) | null): void {
    this.endedCb = cb;
  }

  pause(): number {
    if (this._playing) {
      this.pausedAt = this.positionMs;
      this.stopSource();
      this._playing = false;
    }
    return this.pausedAt;
  }

  seek(ms: number): void {
    if (this._playing) this.play(ms, this.rate, 0.03, 0, { keepPitch: this.stretching });
    else this.pausedAt = ms;
  }

  stop(): void {
    this.stopSource();
    this._playing = false;
    this.pausedAt = 0;
  }

  /** Fades the music out, then stops it */
  fadeOut(sec = 0.4): void {
    if (!this.source || !this.sourceGain || !this.ctx) return;
    const g = this.sourceGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + sec);
    const src = this.source;
    src.stop(now + sec + 0.02);
    this.pausedAt = this.positionMs;
    this.source = null;
    this.sourceGain = null;
    this._playing = false;
  }

  private stopSource(): void {
    if (this.stretching) {
      this.stretchNode?.port.postMessage({ type: 'stop' });
      this.stretching = false;
    }
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* never started */
      }
      this.source.disconnect();
      this.source = null;
      this.sourceGain = null;
    }
  }

  // ---------------------------------------------------------------- sfx
  /** Plays a synthesized sound now, or at a given audio-clock time */
  playSfx(name: SfxName, volume = 1, atCtxTime = 0, detune = 0): void {
    const buf = this.sfx[name];
    if (!buf || !this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (detune) src.detune.value = detune;
    if (volume !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = volume;
      src.connect(g).connect(this.sfxBus);
    } else {
      src.connect(this.sfxBus);
    }
    src.start(atCtxTime);
  }

  /**
   * Scheduling time for a sound that must line up with song time `songMs`
   * (metronome, editor hitsounds). Both live on the same ctx clock as the music.
   */
  ctxTimeForSong(songMs: number): number {
    return this.anchorCtx + (songMs - this.anchorSongMs) / 1000 / this.rate;
  }

  /** Current scheduling-clock time (seconds) */
  get now(): number {
    return this.context.currentTime;
  }

  /** Small UI blips, throttled so fast hovering doesn't machine-gun */
  ui(name: 'uiHover' | 'uiConfirm' | 'uiBack' | 'uiToggle'): void {
    const now = performance.now();
    if (name === 'uiHover' && now - this.lastUiSound < 45) return;
    this.lastUiSound = now;
    this.playSfx(name, name === 'uiHover' ? 0.35 : 0.7);
  }

  get outputLatencyMs(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
  }
}

export const audio = new AudioEngine();
export type { SfxName };
