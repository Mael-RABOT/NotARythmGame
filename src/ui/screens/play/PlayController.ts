import type { Application } from 'pixi.js';
import { audio } from '../../../core/audio/AudioEngine';
import { compileDifficulty, type CompiledChart } from '../../../core/chart/compile';
import { PPQ } from '../../../core/chart/types';
import { GameEvent, GameSession, gradeFor, keyLane } from '../../../core/game/GameSession';
import { Playfield } from '../../../core/render/Playfield';
import { attachPixi, detachPixi } from '../../../core/render/pixiApp';
import { bestsDb } from '../../../storage/db';
import { settings } from '../../../storage/settings';
import { pulseGrid, prefersReducedMotion } from '../../components/decor';
import { palette } from '../../theme/tokens';
import type { PlayRequest, RunResult } from '../../store/app';

export interface HudRefs {
  score: HTMLElement;
  combo: HTMLElement;
  comboWrap: HTMLElement;
  accuracy: HTMLElement;
  gauge: HTMLElement;
  progress: HTMLElement;
  debug: HTMLElement;
  intro: HTMLElement;
}

export interface PlayCallbacks {
  onPauseChange: (paused: boolean) => void;
  onCountdown: (n: number | null) => void;
  onFinish: (result: RunResult) => void;
  onExit: () => void;
}

const LEAD_IN_MS = 2000;

/**
 * Glue between audio clock, input, game session, Pixi playfield and DOM HUD.
 * The Pixi ticker drives everything; React only mounts the host and overlays.
 */
export class PlayController {
  private app: Application | null = null;
  private playfield: Playfield | null = null;
  private session!: GameSession;
  private compiled!: CompiledChart;
  private destroyed = false;
  private paused = false;
  private finished = false;
  private countdownTimer = 0;
  private startMs = 0;
  private lastFrame = performance.now();
  private soundRead = 0;
  private lastBeat = -1;
  private keyCodes: string[] = [];
  private restartHold = 0;

  // HUD cache (only touch the DOM when a value changes)
  private shown = { score: -1, combo: -1, acc: -1, gauge: -1, progress: -1 };
  private fps = { frames: 0, since: performance.now(), worst: 0, logic: 0, logicMax: 0 };

  constructor(
    private host: HTMLElement,
    private req: PlayRequest,
    private hud: HudRefs,
    private cb: PlayCallbacks,
  ) {}

  async init(): Promise<void> {
    await document.fonts.load('600 48px "IBM Plex Mono"').catch(() => undefined);
    if (this.destroyed) return;
    const app = await attachPixi(this.host);
    if (this.destroyed) return;
    this.app = app;
    const s = settings();
    this.playfield = new Playfield(app.renderer, palette(), {
      effects: prefersReducedMotion() ? 'off' : s.effects,
      shake: s.screenShake && !prefersReducedMotion(),
      showHitError: s.showHitError,
      laneSwap: s.laneSwap,
      scrollSpeed: s.scrollSpeed,
    });
    app.stage.addChild(this.playfield.root);
    this.playfield.resize(app.screen.width, app.screen.height);
    app.renderer.on('resize', this.onResize);

    const diff = this.req.chart.difficulties.find((d) => d.id === this.req.diffId) ?? this.req.chart.difficulties[0];
    this.compiled = compileDifficulty(this.req.chart, diff);
    this.keyCodes = [...s.keys];
    audio.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
    audio.load(this.req.buffer);
    audio.onEnded(null);

    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    app.ticker.add(this.frame);
    this.begin();
  }

  private onResize = (w: number, h: number) => this.playfield?.resize(w, h);

  // ---------------------------------------------------------------- lifecycle
  private begin(): void {
    const opts = this.req.options;
    this.session = new GameSession(this.compiled, undefined, !!opts.autoplay);
    this.playfield!.setChart(this.compiled);
    this.soundRead = 0;
    this.finished = false;
    this.paused = false;
    const requested = opts.startMs ?? 0;
    const firstNote = this.compiled.count ? this.compiled.firstMs : 0;
    if (opts.startMs !== undefined) {
      // test play: audio and notes start right at `requested`
      this.session.skipBefore(requested - 1);
      this.startMs = requested;
    } else {
      this.startMs = Math.min(0, firstNote - LEAD_IN_MS);
    }
    this.shown = { score: -1, combo: -1, acc: -1, gauge: -1, progress: -1 };
    audio.play(this.startMs, opts.rate ?? 1, 0.08);
    if (opts.startMs !== undefined) this.hud.intro.style.opacity = '0';
    else this.hud.intro.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: Math.max(1500, -this.startMs + 600), fill: 'forwards' });
  }

  restart(): void {
    clearInterval(this.countdownTimer);
    this.cb.onCountdown(null);
    this.cb.onPauseChange(false);
    audio.stop();
    this.begin();
  }

  pause(): void {
    if (this.paused || this.finished) return;
    clearInterval(this.countdownTimer);
    this.cb.onCountdown(null);
    this.paused = true;
    audio.pause();
    this.cb.onPauseChange(true);
  }

  /** Resumes after a 3-2-1 countdown, rewinding a little so the player can re-enter */
  resume(): void {
    if (!this.paused) return;
    this.cb.onPauseChange(false);
    let n = 3;
    this.cb.onCountdown(n);
    if (settings().uiSounds) audio.playSfx('countdown', 0.7);
    const resumeAt = audio.positionMs - 1200;
    clearInterval(this.countdownTimer);
    this.countdownTimer = window.setInterval(() => {
      n--;
      if (n > 0) {
        this.cb.onCountdown(n);
        if (settings().uiSounds) audio.playSfx('countdown', 0.7);
      } else {
        clearInterval(this.countdownTimer);
        this.cb.onCountdown(null);
        if (settings().uiSounds) audio.playSfx('go', 0.7);
        this.paused = false;
        audio.play(resumeAt, this.req.options.rate ?? 1, 0.03);
      }
    }, 520);
  }

  get isPaused(): boolean {
    return this.paused;
  }

  destroy(): void {
    this.destroyed = true;
    clearInterval(this.countdownTimer);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    audio.fadeOut(0.25);
    if (this.app) {
      this.app.ticker.remove(this.frame);
      this.app.renderer.off('resize', this.onResize);
      detachPixi(this.app, this.host);
      this.playfield?.destroy();
      this.playfield = null;
      this.app = null;
    }
  }

  // ---------------------------------------------------------------- input
  private songMsAt(timeStamp: number): number {
    return audio.songMsAt(timeStamp) - settings().audioOffsetMs;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Escape') {
      e.preventDefault();
      if (this.finished) return;
      if (this.paused) this.resume();
      else this.pause();
      return;
    }
    if (e.code === 'Backspace') {
      e.preventDefault();
      // the frame loop fires the restart once the key has been held long enough
      if (!e.repeat && this.restartHold === 0) this.restartHold = performance.now();
      return;
    }
    const key = this.keyCodes.indexOf(e.code);
    if (key < 0) return;
    e.preventDefault();
    if (e.repeat || this.paused || this.finished || this.req.options.autoplay) return;
    const ms = this.songMsAt(e.timeStamp);
    this.session.press(key, ms);
    const lane = keyLane(key);
    this.playfield?.press(lane);
    if (settings().hitsounds) audio.playSfx(lane === 0 ? 'ka' : 'don', 0.85);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Backspace') this.restartHold = 0;
    const key = this.keyCodes.indexOf(e.code);
    if (key < 0 || this.req.options.autoplay) return;
    this.session.release(key, this.songMsAt(e.timeStamp));
  };

  private onBlur = () => this.pause();
  private onVisibility = () => {
    if (document.hidden) this.pause();
  };

  // ---------------------------------------------------------------- frame
  private frame = () => {
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    if (!this.playfield) return;
    audio.tick();
    const s = settings();
    const judgeMs = audio.songMsAt(now) - s.audioOffsetMs;
    const visualMs = judgeMs + s.visualOffsetMs;
    if (!this.paused && !this.finished) this.session.update(judgeMs);
    if (this.restartHold > 0 && performance.now() - this.restartHold > 450) {
      this.restartHold = -1; // wait for the key to be released before arming again
      this.restart();
      return;
    }
    this.playfield.update(visualMs, this.paused ? 0 : dt, this.session, this.heldMask());
    this.sounds();
    this.updateHud(judgeMs);
    const logic = performance.now() - now;
    this.fps.logic += logic;
    this.fps.logicMax = Math.max(this.fps.logicMax, logic);

    // grid pulse on each beat behind the canvas
    const beat = Math.floor(this.compiled.timing.msToTick(visualMs) / PPQ);
    if (beat !== this.lastBeat && visualMs > this.compiled.timing.offsetMs) {
      this.lastBeat = beat;
      if (!this.paused) pulseGrid(beat % 4 === 0 ? 0.9 : 0.35);
    }

    const opts = this.req.options;
    if (!this.paused && !this.finished) {
      if (opts.loopEndMs !== undefined && judgeMs > opts.loopEndMs) {
        this.restart();
      } else if (this.session.isFinished(judgeMs) || (!audio.playing && judgeMs > this.compiled.lastMs)) {
        this.finish();
      }
    }

    // debug overlay
    this.fps.frames++;
    this.fps.worst = Math.max(this.fps.worst, dt);
    if (now - this.fps.since > 500) {
      if (s.showFps) {
        const fps = (this.fps.frames * 1000) / (now - this.fps.since);
        const logicAvg = this.fps.logic / Math.max(1, this.fps.frames);
        this.hud.debug.textContent = `${fps.toFixed(0)} fps · frame worst ${this.fps.worst.toFixed(1)} ms · logic ${logicAvg.toFixed(2)} ms (max ${this.fps.logicMax.toFixed(2)}) · notes ${this.playfield.stats.notes} · sprites ${this.playfield.stats.pool} · audio out ${audio.outputLatencyMs.toFixed(0)} ms`;
        this.hud.debug.style.display = '';
      } else if (this.hud.debug.style.display !== 'none') {
        this.hud.debug.style.display = 'none';
      }
      this.fps = { frames: 0, since: now, worst: 0, logic: 0, logicMax: 0 };
    }
  };

  private heldMask(): number {
    let m = 0;
    for (let k = 0; k < 4; k++) if (this.session.isLaneHeld(k >> 1)) m |= 1 << k;
    return m;
  }

  /** Sounds that come from game events rather than key presses */
  private sounds(): void {
    const s = this.session;
    const auto = !!this.req.options.autoplay;
    const hs = settings().hitsounds;
    if (s.evWrite - this.soundRead > GameSession.EVENT_CAPACITY) this.soundRead = s.evWrite - GameSession.EVENT_CAPACITY;
    for (; this.soundRead < s.evWrite; this.soundRead++) {
      const e = this.soundRead % GameSession.EVENT_CAPACITY;
      switch (s.evType[e]) {
        case GameEvent.hit:
          if (auto && hs) audio.playSfx(s.evValue[e] >= 100 ? 'big' : s.evLane[e] === 0 ? 'ka' : 'don', 0.8);
          if (auto) this.playfield?.press(s.evLane[e]);
          break;
        case GameEvent.mashHit:
          if (hs) audio.playSfx('mash', 0.6, 0, Math.min(1200, (s.chart.hits[s.evNote[e]] - s.evValue[e]) * 40));
          break;
        case GameEvent.mashDone:
          if (s.evJudge[e] < 3) audio.playSfx('big', 0.9);
          break;
        case GameEvent.rollHit:
          if (hs) audio.playSfx('roll', 0.5);
          break;
        case GameEvent.mineHit:
          audio.playSfx('mine', 0.8);
          break;
        case GameEvent.collect:
          audio.playSfx('collect', 0.5);
          break;
        case GameEvent.holdBreak:
          audio.playSfx('holdBreak', 0.5);
          break;
      }
    }
  }

  private updateHud(judgeMs: number): void {
    const s = this.session;
    const h = this.hud;
    const shown = this.shown;
    const score = s.score;
    if (score !== shown.score) {
      shown.score = score;
      h.score.textContent = score.toString().padStart(7, '0');
    }
    if (s.combo !== shown.combo) {
      const prev = shown.combo;
      shown.combo = s.combo;
      h.combo.textContent = String(s.combo);
      h.comboWrap.style.opacity = s.combo >= 2 ? '1' : '0';
      if (s.combo > prev && s.combo >= 2 && !prefersReducedMotion()) {
        const milestone = s.combo % 50 === 0;
        h.comboWrap.animate(
          milestone
            ? [{ transform: 'scale(1.45)', color: 'var(--color-accent)' }, { transform: 'scale(1)' }]
            : [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
          { duration: milestone ? 420 : 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      } else if (prev > 10 && s.combo === 0 && !prefersReducedMotion()) {
        h.comboWrap.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'none' }], { duration: 180 });
      }
    }
    const acc = Math.round(s.accuracy * 10000);
    if (acc !== shown.acc) {
      shown.acc = acc;
      h.accuracy.textContent = `${(acc / 100).toFixed(2)}%`;
    }
    const gauge = Math.round(s.gauge * 1000);
    if (gauge !== shown.gauge) {
      shown.gauge = gauge;
      h.gauge.style.transform = `scaleX(${gauge / 1000})`;
      h.gauge.parentElement!.classList.toggle('is-clear', s.cleared);
    }
    const total = Math.max(1, this.compiled.lastMs - Math.max(0, this.startMs));
    const progress = Math.round(Math.min(1, Math.max(0, (judgeMs - Math.max(0, this.startMs)) / total)) * 1000);
    if (progress !== shown.progress) {
      shown.progress = progress;
      h.progress.style.transform = `scaleX(${progress / 1000})`;
    }
  }

  private async finish(): Promise<void> {
    this.finished = true;
    const s = this.session;
    const opts = this.req.options;
    const ranked = !opts.autoplay && opts.startMs === undefined && opts.loopEndMs === undefined && !opts.fromEditor && (opts.rate ?? 1) === 1;
    const accuracy = s.finalAccuracy;
    const grade = gradeFor(accuracy);
    let newBest = false;
    if (ranked) {
      newBest = await bestsDb
        .submit(this.req.songId, this.req.diffId, {
          score: s.score,
          accuracy,
          maxCombo: s.maxCombo,
          grade,
          fullCombo: s.fullCombo,
          cleared: s.cleared,
        })
        .catch(() => false);
    }
    if (this.destroyed) return;
    if (opts.loopEndMs !== undefined) {
      this.restart();
      return;
    }
    this.cb.onFinish({
      request: this.req,
      score: s.score,
      accuracy,
      grade,
      maxCombo: s.maxCombo,
      counts: [s.counts[0], s.counts[1], s.counts[2], s.counts[3]],
      hitErrors: s.hitErrors.slice(0, s.hitErrorCount),
      fullCombo: s.fullCombo,
      cleared: s.cleared,
      rollHits: s.rollHits,
      collected: s.collected,
      collectTotal: s.collectTotal,
      minesHit: s.minesHit,
      totalNotes: this.compiled.count,
      newBest,
    });
  }
}
