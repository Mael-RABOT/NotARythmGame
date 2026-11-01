import { BitmapFont, BitmapText, Container, Graphics, Sprite, type Renderer, type Texture } from 'pixi.js';
import { lowerBound, type CompiledChart } from '../chart/compile';
import { NoteKind, PPQ } from '../chart/types';
import { GameEvent, GameSession, Judgement } from '../game/GameSession';
import { hex, type Palette } from '../../ui/theme/tokens';
import { BASE, buildTextures, chamferPoly, destroyTextures, type TextureBank } from './textures';

/** Reusable sprites: `get()` hands out the next one each frame, `end()` hides the rest. */
class SpritePool {
  private items: Sprite[] = [];
  private used = 0;
  private prevUsed = 0;
  constructor(private parent: Container, private texture: Texture, private ax = 0.5, private ay = 0.5) {}

  begin(): void {
    this.used = 0;
  }

  get(texture: Texture = this.texture): Sprite {
    let s = this.items[this.used];
    if (!s) {
      s = new Sprite(texture);
      s.anchor.set(this.ax, this.ay);
      this.parent.addChild(s);
      this.items.push(s);
    } else if (s.texture !== texture) {
      s.texture = texture;
    }
    s.visible = true;
    s.alpha = 1;
    s.tint = 0xffffff;
    s.rotation = 0;
    this.used++;
    return s;
  }

  end(): void {
    for (let i = this.used; i < this.prevUsed; i++) this.items[i].visible = false;
    this.prevUsed = this.used;
  }

  get active(): number {
    return this.used;
  }

  get size(): number {
    return this.items.length;
  }
}

export interface PlayfieldOptions {
  effects: 'high' | 'low' | 'off';
  shake: boolean;
  showHitError: boolean;
  laneSwap: boolean;
  scrollSpeed: number;
}

const MAX_PARTICLES = 320;
const MAX_POPS = 10;
const MAX_TICKS = 40;
const TICK_LIFE = 3500;
const POP_LIFE = 520;

/**
 * Gameplay view. Two horizontal lanes, notes scroll right → left onto the
 * judgement receptors. The draw loop walks only the visible slice of the
 * compiled chart (binary search on scroll position) and reuses pooled sprites,
 * so a frame allocates nothing.
 */
export class Playfield {
  readonly root = new Container();
  private readonly shakeLayer = new Container();
  private readonly bg = new Graphics();
  private readonly beatLayer = new Container();
  private readonly bodyLayer = new Container();
  private readonly noteLayer = new Container();
  private readonly fxLayer = new Container();
  private readonly hudLayer = new Container();
  private tex: TextureBank;
  private palette: Palette;

  private beatPool!: SpritePool;
  private bodyPool!: SpritePool;
  private notePool!: SpritePool;

  private receptors: Sprite[] = [];
  private receptorGlow: Sprite[] = [];
  private laneFlash: Sprite[] = [];
  private readonly flashAlpha = new Float32Array(2);
  private readonly receptorPulse = new Float32Array(2);
  private readonly bandPulse = new Float32Array(2);

  // particles (struct of arrays)
  private particles: Sprite[] = [];
  private readonly pX = new Float32Array(MAX_PARTICLES);
  private readonly pY = new Float32Array(MAX_PARTICLES);
  private readonly pVX = new Float32Array(MAX_PARTICLES);
  private readonly pVY = new Float32Array(MAX_PARTICLES);
  private readonly pLife = new Float32Array(MAX_PARTICLES);
  private readonly pMax = new Float32Array(MAX_PARTICLES);
  private pNext = 0;

  // judgement pops
  private pops: Sprite[] = [];
  private readonly popLife = new Float32Array(MAX_POPS);
  private readonly popY = new Float32Array(MAX_POPS);
  private popNext = 0;
  private readonly lanePop = new Int8Array([-1, -1]);

  // hit error bar
  private errorBar = new Graphics();
  private errorTicks: Sprite[] = [];
  private errorMean!: Sprite;
  private readonly tickLife = new Float32Array(MAX_TICKS);
  private tickNext = 0;
  private errorAvg = 0;
  private errorWidth = 220;

  private mashText: BitmapText;

  private chart: CompiledChart | null = null;
  private evRead = 0;
  private shake = 0;

  // layout
  w = 0;
  h = 0;
  judgeX = 0;
  readonly laneY = new Float32Array(2);
  laneH = 0;
  noteSize = 0;
  pxPerMs = 0;
  private midY = 0;

  options: PlayfieldOptions;
  /** Per-frame stats for the debug overlay */
  stats = { notes: 0, pool: 0 };

  // beat-line callback state (bound once: no closure per frame)
  private framePos = 0;
  private readonly onBeat = (tick: number, isMeasure: boolean) => {
    const c = this.chart;
    if (!c) return;
    const ms = c.timing.tickToMs(tick);
    const x = this.judgeX + (c.timing.msToPos(ms) - this.framePos) * this.pxPerMs;
    if (x < this.judgeX - this.noteSize || x > this.w + 4) return;
    const s = this.beatPool.get();
    s.x = Math.round(x) + 0.5;
    s.y = this.midY;
    s.width = isMeasure ? 2 : 1;
    s.height = this.laneSpan;
    s.tint = hex(this.palette.text);
    s.alpha = isMeasure ? 0.2 : 0.07;
  };
  private laneSpan = 0;

  constructor(private renderer: Renderer, palette: Palette, options: PlayfieldOptions) {
    this.palette = palette;
    this.options = options;
    this.tex = buildTextures(renderer, palette);
    this.root.addChild(this.shakeLayer);
    this.shakeLayer.addChild(this.bg, this.beatLayer, this.bodyLayer, this.noteLayer, this.fxLayer, this.hudLayer);
    Playfield.installFont();
    this.mashText = new BitmapText({ text: '0', style: { fontFamily: 'narg-digits', fontSize: 40 } });
    this.mashText.anchor.set(0.5);
    this.mashText.visible = false;
    this.buildStatic();
  }

  /** Rebuilds textures and static graphics (theme change) */
  setPalette(palette: Palette): void {
    this.palette = palette;
    destroyTextures(this.tex);
    this.tex = buildTextures(this.renderer, palette);
    this.shakeLayer.removeChildren();
    this.beatLayer.removeChildren();
    this.bodyLayer.removeChildren();
    this.noteLayer.removeChildren();
    this.fxLayer.removeChildren();
    this.hudLayer.removeChildren();
    this.shakeLayer.addChild(this.bg, this.beatLayer, this.bodyLayer, this.noteLayer, this.fxLayer, this.hudLayer);
    this.buildStatic();
    this.resize(this.w, this.h);
  }

  private buildStatic(): void {
    const t = this.tex;
    this.beatPool = new SpritePool(this.beatLayer, t.white);
    this.bodyPool = new SpritePool(this.bodyLayer, t.white, 0, 0.5);
    this.notePool = new SpritePool(this.noteLayer, t.tap[0]);
    this.receptors = [];
    this.receptorGlow = [];
    this.laneFlash = [];
    for (let lane = 0; lane < 2; lane++) {
      const flash = new Sprite(t.flash);
      flash.anchor.set(0, 0.5);
      flash.alpha = 0;
      this.bodyLayer.addChildAt(flash, 0);
      this.laneFlash.push(flash);
      const glow = new Sprite(t.glow);
      glow.anchor.set(0.5);
      glow.alpha = 0;
      this.fxLayer.addChild(glow);
      this.receptorGlow.push(glow);
      const r = new Sprite(t.receptor);
      r.anchor.set(0.5);
      this.hudLayer.addChild(r);
      this.receptors.push(r);
    }
    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = new Sprite(t.particle);
      s.anchor.set(0.5);
      s.visible = false;
      this.fxLayer.addChild(s);
      this.particles.push(s);
    }
    this.pops = [];
    for (let i = 0; i < MAX_POPS; i++) {
      const s = new Sprite(t.judgement[0]);
      s.anchor.set(0.5);
      s.visible = false;
      this.hudLayer.addChild(s);
      this.pops.push(s);
    }
    this.errorBar = new Graphics();
    this.hudLayer.addChild(this.errorBar);
    this.errorTicks = [];
    for (let i = 0; i < MAX_TICKS; i++) {
      const s = new Sprite(t.white);
      s.anchor.set(0.5);
      s.visible = false;
      this.hudLayer.addChild(s);
      this.errorTicks.push(s);
    }
    this.errorMean = new Sprite(t.white);
    this.errorMean.anchor.set(0.5, 0);
    this.hudLayer.addChild(this.errorMean);
    this.mashText.tint = hex(this.palette.text);
    this.hudLayer.addChild(this.mashText);
  }

  private static fontInstalled = false;
  static installFont(): void {
    if (Playfield.fontInstalled) return;
    BitmapFont.install({
      name: 'narg-digits',
      style: { fontFamily: 'IBM Plex Mono', fontSize: 64, fontWeight: '600', fill: '#ffffff' },
      chars: [['0', '9'], '×x+-.%'],
      resolution: 2,
    });
    Playfield.fontInstalled = true;
  }

  setChart(chart: CompiledChart): void {
    this.chart = chart;
    this.evRead = 0;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.laneH = Math.round(Math.min(h * 0.17, 132));
    this.noteSize = Math.round(this.laneH * 0.74);
    this.midY = Math.round(h * 0.52);
    const gap = this.laneH * 0.62;
    const top = this.midY - gap;
    const bottom = this.midY + gap;
    this.laneY[0] = this.options.laneSwap ? bottom : top;
    this.laneY[1] = this.options.laneSwap ? top : bottom;
    this.laneSpan = gap * 2 + this.laneH;
    this.judgeX = Math.round(Math.max(110, Math.min(w * 0.17, 260)));
    this.setScrollSpeed(this.options.scrollSpeed);

    const p = this.palette;
    const g = this.bg;
    g.clear();
    for (let lane = 0; lane < 2; lane++) {
      const y = this.laneY[lane];
      const color = hex(lane === 0 ? p.laneUp : p.laneDown);
      g.rect(0, y - this.laneH / 2, w, this.laneH).fill({ color, alpha: 0.045 });
      g.rect(0, y - this.laneH / 2, w, 1).fill({ color: hex(p.text), alpha: 0.12 });
      g.rect(0, y + this.laneH / 2 - 1, w, 1).fill({ color: hex(p.text), alpha: 0.12 });
      // dotted centre guide
      for (let x = this.judgeX + this.noteSize; x < w; x += 12) g.rect(x, y, 2, 1).fill({ color: hex(p.text), alpha: 0.12 });
    }
    // judgement column: chamfered slab behind the receptors
    const colW = this.noteSize * 1.25;
    g.poly(chamferPoly(colW, this.laneSpan + 24, 14).map((v, i) => (i % 2 ? v + this.midY : v + this.judgeX)))
      .fill({ color: hex(p.surface), alpha: 0.65 })
      .stroke({ width: 1, color: hex(p.text), alpha: 0.2 });

    for (let lane = 0; lane < 2; lane++) {
      const color = hex(lane === 0 ? p.laneUp : p.laneDown);
      const r = this.receptors[lane];
      r.position.set(this.judgeX, this.laneY[lane]);
      r.tint = color;
      r.scale.set(this.noteSize / BASE);
      const glow = this.receptorGlow[lane];
      glow.position.set(this.judgeX, this.laneY[lane]);
      glow.tint = color;
      glow.scale.set((this.noteSize * 2.2) / 128);
      const f = this.laneFlash[lane];
      f.position.set(this.judgeX, this.laneY[lane]);
      f.tint = color;
      f.width = Math.min(w - this.judgeX, 640);
      f.height = this.laneH;
    }

    // hit error bar (bottom centre)
    const eb = this.errorBar;
    eb.clear();
    const ew = (this.errorWidth = Math.min(280, w * 0.4));
    const ey = h - 36;
    const half = ew / 2;
    const cxm = w / 2;
    const good = 110;
    const scale = half / good;
    eb.rect(cxm - half, ey - 3, ew, 6).fill({ color: hex(p.text), alpha: 0.08 });
    eb.rect(cxm - 70 * scale, ey - 3, 140 * scale, 6).fill({ color: hex(p.laneDown), alpha: 0.22 });
    eb.rect(cxm - 35 * scale, ey - 3, 70 * scale, 6).fill({ color: hex(p.accent), alpha: 0.35 });
    eb.rect(cxm - 0.5, ey - 9, 1, 18).fill({ color: hex(p.text), alpha: 0.7 });
    eb.visible = this.options.showHitError;
    this.errorMean.visible = this.options.showHitError;
    this.errorMean.tint = hex(p.text);
    this.errorMean.width = 3;
    this.errorMean.height = 6;
    this.errorMean.position.set(cxm, ey + 6);
  }

  setScrollSpeed(speed: number): void {
    this.options.scrollSpeed = speed;
    const lookAheadMs = 8000 / Math.max(1, speed);
    this.pxPerMs = (this.w - this.judgeX) / lookAheadMs;
  }

  // ---------------------------------------------------------------- feedback
  /** Instant feedback on any key press (even when no note is hit) */
  press(lane: number): void {
    this.flashAlpha[lane] = 0.55;
    this.receptorPulse[lane] = 1;
  }

  private burst(x: number, y: number, color: number, count: number, speed: number, life = 420): void {
    if (this.options.effects === 'off') return;
    if (this.options.effects === 'low') count = Math.ceil(count / 3);
    for (let k = 0; k < count; k++) {
      const i = this.pNext;
      this.pNext = (this.pNext + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.pX[i] = x;
      this.pY[i] = y;
      this.pVX[i] = Math.cos(a) * v + speed * 0.25;
      this.pVY[i] = Math.sin(a) * v;
      this.pLife[i] = this.pMax[i] = life * (0.6 + Math.random() * 0.4);
      const s = this.particles[i];
      s.visible = true;
      s.tint = color;
      s.texture = k % 3 === 0 ? this.tex.spark : this.tex.particle;
      s.rotation = a;
      s.scale.set(0.6 + Math.random() * 0.9);
    }
  }

  private pop(texture: Texture, lane: number, yOffset = 0): void {
    const i = this.popNext;
    this.popNext = (this.popNext + 1) % MAX_POPS;
    // a new judgement in the same lane cuts the previous one short (no stacking)
    if (yOffset === 0) {
      const prev = this.lanePop[lane];
      if (prev >= 0 && prev !== i) this.popLife[prev] = Math.min(this.popLife[prev], 60);
      this.lanePop[lane] = i;
    }
    const s = this.pops[i];
    s.texture = texture;
    s.visible = true;
    this.popLife[i] = POP_LIFE;
    this.popY[i] = this.laneY[lane] - this.noteSize * 0.95 + yOffset;
    s.x = this.judgeX + this.noteSize * 0.1;
  }

  private errorTick(offset: number, jdg: number): void {
    if (!this.options.showHitError) return;
    const i = this.tickNext;
    this.tickNext = (this.tickNext + 1) % MAX_TICKS;
    const s = this.errorTicks[i];
    const half = this.errorWidth / 2;
    s.visible = true;
    s.x = this.w / 2 + Math.max(-1, Math.min(1, offset / 110)) * half;
    s.y = this.h - 36;
    s.width = 2;
    s.height = 14;
    const p = this.palette;
    s.tint = hex(jdg === Judgement.perfect ? p.judgePerfect : jdg === Judgement.great ? p.judgeGreat : p.judgeGood);
    this.tickLife[i] = TICK_LIFE;
    this.errorAvg += (offset - this.errorAvg) * 0.15;
  }

  /** Turns session events into effects. Call once per frame. */
  private consumeEvents(session: GameSession): void {
    const c = this.chart!;
    const cap = GameSession.EVENT_CAPACITY;
    if (session.evWrite - this.evRead > cap) this.evRead = session.evWrite - cap;
    const p = this.palette;
    for (; this.evRead < session.evWrite; this.evRead++) {
      const e = this.evRead % cap;
      const type = session.evType[e];
      const lane = session.evLane[e];
      const jdg = session.evJudge[e];
      const note = session.evNote[e];
      const laneColor = hex(lane === 0 ? p.laneUp : p.laneDown);
      const x = this.judgeX;
      const y = this.laneY[lane];
      switch (type) {
        case GameEvent.hit: {
          this.pop(this.tex.judgement[jdg], lane);
          if (jdg !== Judgement.miss) {
            const isBig = c.kind[note] === NoteKind.big;
            const full = session.evValue[e] >= 100;
            this.burst(x, y, jdg === Judgement.perfect ? laneColor : hex(p.text), isBig ? 22 : jdg === Judgement.perfect ? 12 : 7, isBig ? 0.55 : 0.4);
            this.receptorPulse[lane] = 1;
            if (isBig && full) {
              this.pop(this.tex.extra.big, lane, -this.noteSize * 0.45);
              if (this.options.shake) this.shake = Math.max(this.shake, 5);
            }
            this.errorTick(session.evOffset[e], jdg);
          }
          break;
        }
        case GameEvent.holdEnd:
          this.pop(this.tex.judgement[jdg], lane);
          this.burst(x, y, laneColor, 14, 0.45);
          break;
        case GameEvent.holdBreak:
          this.pop(this.tex.extra.break, lane);
          break;
        case GameEvent.miss:
          this.pop(this.tex.judgement[Judgement.miss], lane);
          break;
        case GameEvent.mashHit:
          this.receptorPulse[0] = this.receptorPulse[1] = 0.6;
          this.burst(x, this.midY, hex(p.accent), 4, 0.35, 300);
          break;
        case GameEvent.mashDone:
          this.pop(this.tex.judgement[jdg], 0, this.laneH * 0.5);
          if (jdg !== Judgement.miss) {
            this.burst(x, this.midY, hex(p.accent), 40, 0.7, 650);
            if (this.options.shake) this.shake = Math.max(this.shake, 8);
          }
          break;
        case GameEvent.rollHit:
          this.burst(x, this.laneY[lane], hex(p.warning), 3, 0.3, 260);
          break;
        case GameEvent.mineHit:
          this.pop(this.tex.extra.mine, lane);
          this.burst(x, y, hex(p.error), 26, 0.6);
          if (this.options.shake) this.shake = Math.max(this.shake, 10);
          break;
        case GameEvent.collect:
          this.burst(x, y, hex(p.text), 10, 0.3, 500);
          break;
      }
    }
  }

  // ---------------------------------------------------------------- frame
  /**
   * @param visualMs song time to draw (audio time + visual offset)
   * @param dt frame delta in ms (effects only)
   */
  update(visualMs: number, dt: number, session: GameSession | null, heldMask = 0): void {
    const c = this.chart;
    if (!c) return;
    if (session) this.consumeEvents(session);
    const timing = c.timing;
    const posNow = timing.msToPos(visualMs);
    const ppm = this.pxPerMs;
    const ahead = (this.w - this.judgeX + this.noteSize * 2) / ppm;
    const behind = (this.judgeX + this.noteSize * 2) / ppm;
    this.framePos = posNow;

    // beat lines
    this.beatPool.begin();
    const speedMin = Math.max(0.25, timing.minSpeed);
    const t0 = timing.msToTick(visualMs - behind / speedMin);
    const t1 = timing.msToTick(visualMs + Math.min(8000, ahead / speedMin));
    timing.forEachBeat(Math.max(0, Math.floor(t0)), Math.ceil(t1), this.onBeat);
    this.beatPool.end();

    // lane band pulse on each beat
    const beatPhase = timing.msToTick(visualMs) / PPQ;
    const frac = beatPhase - Math.floor(beatPhase);
    const pulse = beatPhase >= 0 ? Math.pow(1 - frac, 4) : 0;
    this.bg.alpha = 0.85 + pulse * 0.15;
    for (let lane = 0; lane < 2; lane++) this.bandPulse[lane] = pulse;

    // notes
    this.bodyPool.begin();
    this.notePool.begin();
    const st = session?.state;
    const res = session?.result;
    const tail = session?.tailResult;
    const p = this.palette;
    const tex = this.tex;
    const scale = this.noteSize / BASE;
    let drawn = 0;
    let mashShown = false;
    const first = lowerBound(c.pos, posNow - behind - c.maxSpanPos, c.count);
    for (let i = first; i < c.count; i++) {
      const pos = c.pos[i];
      if (pos > posNow + ahead) break;
      const kind = c.kind[i];
      const lane = c.lane[i];
      const s = st ? st[i] : 0;
      let alpha = 1;
      if (s === GameSession.DONE) {
        const r = res![i];
        if (kind === NoteKind.mash || kind === NoteKind.roll) continue;
        if (kind === NoteKind.mine) {
          if (r === Judgement.miss) continue;
        } else if (kind === NoteKind.collect) {
          if (r === Judgement.perfect) continue;
          alpha = 0.3;
        } else if (kind === NoteKind.hold) {
          if (r !== Judgement.miss && tail![i] !== Judgement.miss) continue;
          alpha = 0.3;
        } else {
          if (r !== Judgement.miss) continue;
          alpha = 0.3;
        }
      }
      let x = this.judgeX + (pos - posNow) * ppm;
      const y = this.laneY[lane];
      const active = s === GameSession.ACTIVE;
      drawn++;

      if (kind === NoteKind.hold || kind === NoteKind.roll) {
        const xEnd = this.judgeX + (c.posEnd[i] - posNow) * ppm;
        if (active) x = Math.max(x, this.judgeX);
        const color = hex(kind === NoteKind.roll ? p.warning : lane === 0 ? p.laneUp : p.laneDown);
        if (xEnd > x) {
          const body = this.bodyPool.get();
          body.x = x;
          body.y = y;
          body.width = xEnd - x;
          body.height = this.noteSize * 0.42;
          body.tint = color;
          body.alpha = alpha * (active ? 0.55 + this.bandPulse[lane] * 0.2 : 0.28);
          this.edge(x, y - this.noteSize * 0.21, xEnd - x, color, alpha * 0.9);
          this.edge(x, y + this.noteSize * 0.21, xEnd - x, color, alpha * 0.9);
        }
        const tailSprite = this.notePool.get(kind === NoteKind.roll ? tex.holdTail[0] : tex.holdTail[lane]);
        tailSprite.position.set(xEnd, y);
        tailSprite.scale.set(scale);
        tailSprite.alpha = alpha;
        if (kind === NoteKind.roll) tailSprite.tint = hex(p.warning);
        const head = this.notePool.get(kind === NoteKind.roll ? tex.rollHead : tex.tap[lane]);
        head.position.set(x, y);
        head.scale.set(scale * (active ? 1.06 + this.receptorPulse[lane] * 0.08 : 1));
        head.alpha = alpha;
        continue;
      }

      if (kind === NoteKind.mash) {
        if (active) x = Math.max(x, this.judgeX);
        const m = this.notePool.get(tex.mash);
        m.position.set(x, this.midY);
        const punch = active ? this.receptorPulse[0] * 0.12 : 0;
        m.scale.set(scale * (1 + punch));
        m.rotation = active ? Math.sin(visualMs * 0.03) * 0.04 * this.receptorPulse[0] : 0;
        if (!mashShown) {
          mashShown = true;
          const remaining = session ? Math.max(0, c.hits[i] - session.mashCount[i]) : c.hits[i];
          const label = String(remaining);
          if (this.mashText.text !== label) this.mashText.text = label;
          this.mashText.position.set(x, this.midY);
          this.mashText.scale.set((this.noteSize / 70) * (1 + punch));
          this.mashText.visible = true;
        }
        continue;
      }

      let t: Texture;
      let sc = scale;
      switch (kind) {
        case NoteKind.big: t = tex.big[lane]; sc = scale * 1.3; break;
        case NoteKind.mine: t = tex.mine; break;
        case NoteKind.collect: t = tex.collect; break;
        default: t = tex.tap[lane];
      }
      if (c.sync[i] && lane === 0 && s !== GameSession.DONE) {
        const link = this.bodyPool.get();
        link.x = x - 1;
        link.y = this.midY;
        link.width = 2;
        link.height = Math.abs(this.laneY[1] - this.laneY[0]) - this.noteSize * 0.9;
        link.tint = hex(p.text);
        link.alpha = 0.45;
      }
      const sp = this.notePool.get(t);
      sp.position.set(x, y);
      sp.scale.set(sc);
      sp.alpha = alpha;
      if (kind === NoteKind.collect) sp.rotation = visualMs * 0.002;
    }
    if (!mashShown) this.mashText.visible = false;
    this.bodyPool.end();
    this.notePool.end();
    this.stats.notes = drawn;
    this.stats.pool = this.notePool.size + this.bodyPool.size;

    this.updateEffects(dt, heldMask);
  }

  private edge(x: number, y: number, w: number, color: number, alpha: number): void {
    const e = this.bodyPool.get();
    e.x = x;
    e.y = y;
    e.width = w;
    e.height = 2;
    e.tint = color;
    e.alpha = alpha;
  }

  private updateEffects(dt: number, heldMask: number): void {
    const k = Math.min(dt, 50);
    for (let lane = 0; lane < 2; lane++) {
      const held = (heldMask & (lane === 0 ? 0b0011 : 0b1100)) !== 0;
      this.flashAlpha[lane] = Math.max(held ? 0.12 : 0, this.flashAlpha[lane] - k * 0.004);
      this.laneFlash[lane].alpha = this.flashAlpha[lane];
      this.receptorPulse[lane] = Math.max(0, this.receptorPulse[lane] - k * 0.006);
      const pulse = this.receptorPulse[lane];
      const r = this.receptors[lane];
      r.scale.set((this.noteSize / BASE) * (1 + pulse * 0.12 + this.bandPulse[lane] * 0.03));
      r.alpha = 0.55 + pulse * 0.45 + (held ? 0.2 : 0);
      this.receptorGlow[lane].alpha = pulse * 0.5 + this.bandPulse[lane] * 0.08;
    }

    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= k;
      const s = this.particles[i];
      if (this.pLife[i] <= 0) {
        s.visible = false;
        continue;
      }
      this.pVX[i] *= 0.985;
      this.pVY[i] = this.pVY[i] * 0.985 + 0.0006 * k;
      this.pX[i] += this.pVX[i] * k;
      this.pY[i] += this.pVY[i] * k;
      s.x = this.pX[i];
      s.y = this.pY[i];
      s.alpha = this.pLife[i] / this.pMax[i];
    }

    for (let i = 0; i < MAX_POPS; i++) {
      if (this.popLife[i] <= 0) continue;
      this.popLife[i] -= k;
      const s = this.pops[i];
      if (this.popLife[i] <= 0) {
        s.visible = false;
        continue;
      }
      const t = 1 - this.popLife[i] / POP_LIFE;
      const appear = Math.min(1, t * 8);
      s.y = this.popY[i] - t * 18;
      s.alpha = t < 0.7 ? appear : 1 - (t - 0.7) / 0.3;
      s.scale.set((this.noteSize / 110) * (1.25 - 0.25 * appear));
    }

    for (let i = 0; i < MAX_TICKS; i++) {
      if (this.tickLife[i] <= 0) continue;
      this.tickLife[i] -= k;
      const s = this.errorTicks[i];
      if (this.tickLife[i] <= 0) s.visible = false;
      else s.alpha = Math.min(1, this.tickLife[i] / TICK_LIFE) * 0.9;
    }
    this.errorMean.x = this.w / 2 + Math.max(-1, Math.min(1, this.errorAvg / 110)) * (this.errorWidth / 2);

    if (this.shake > 0.1) {
      this.shakeLayer.x = (Math.random() - 0.5) * this.shake;
      this.shakeLayer.y = (Math.random() - 0.5) * this.shake;
      this.shake *= Math.pow(0.86, k / 16);
    } else if (this.shakeLayer.x !== 0 || this.shakeLayer.y !== 0) {
      this.shakeLayer.position.set(0, 0);
      this.shake = 0;
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
    destroyTextures(this.tex);
  }
}
