import { Container, Graphics, Sprite, type Application, type Texture } from 'pixi.js';
import { audio } from '../../core/audio/AudioEngine';
import type { Peaks } from '../../core/audio/analysis';
import { analyzeDifficulty } from '../../core/chart/analysis';
import { TimingMap } from '../../core/chart/TimingMap';
import { PPQ, SPAN_TYPES, compareNotes, noteEnd, type Lane, type Note, type NoteType } from '../../core/chart/types';
import {
  addNotes,
  fromRelative,
  moveNotes,
  removeNotes,
  setNoteProps,
  snapColor,
  snapTicks,
  withDifficulty,
} from '../../core/editor/ops';
import { attachPixi, detachPixi } from '../../core/render/pixiApp';
import { BASE, buildTextures, destroyTextures, type TextureBank } from '../../core/render/textures';
import { settings } from '../../storage/settings';
import { hex, palette, rgba, type Palette } from '../theme/tokens';
import { addSpeedPoint, flashRow } from './actions';
import { toast } from '../components/overlays';
import { currentDiff, editor } from './store';

export const RULER_H = 30;
export const EVENTS_H = 20;
export const SPEED_H = 40;
const FOLLOW_AT = 0.3;
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 3;
const HIT_PAD = 6;

type Drag =
  | { kind: 'none' }
  | { kind: 'seek' }
  | { kind: 'pan'; startX: number; startView: number }
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; additive: boolean }
  | { kind: 'move'; startTick: number; startLane: number; dTick: number; dLane: number; moved: boolean }
  | { kind: 'resize'; note: Note; dur: number }
  | { kind: 'span'; type: NoteType; lane: Lane; t: number; dur: number }
  | { kind: 'erase'; hit: Set<Note> }
  | { kind: 'speed'; index: number; t: number; mult: number; moved: boolean };

interface RecordKey {
  tick: number;
  lane: Lane;
  key: number;
  big: boolean;
}

/**
 * Editor timeline: horizontal (time → x), two lanes, same orientation and note
 * textures as gameplay. Owns pointer interaction, playback scheduling
 * (hitsounds + metronome on the audio clock) and live recording.
 */
export class Timeline {
  private app: Application | null = null;
  private destroyed = false;
  private bg: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private stage = new Container();
  private noteLayer = new Container();
  private overlay = new Graphics();
  private playhead = new Graphics();
  private pool: Sprite[] = [];
  private used = 0;
  private tex: TextureBank | null = null;
  private pal: Palette = palette();

  w = 0;
  h = 0;
  private dpr = 1;
  private drag: Drag = { kind: 'none' };
  private pointer = { x: -1, y: -1, inside: false };
  private lastSig = '';
  private scheduledUntil = -Infinity;
  private recordKeys = new Map<number, RecordKey>();
  private recorded: Note[] = [];
  private recordStartTick = 0;
  private density: Float32Array | null = null;
  private densityFor: unknown = null;
  private lastFrame = performance.now();

  constructor(
    private host: HTMLElement,
    private minimap: HTMLCanvasElement,
  ) {
    this.bg = document.createElement('canvas');
    this.bg.className = 'timeline__bg';
    host.prepend(this.bg);
    this.ctx = this.bg.getContext('2d')!;
    this.stage.addChild(this.noteLayer, this.overlay, this.playhead);
  }

  async init(): Promise<void> {
    await document.fonts.load('500 12px "IBM Plex Mono"').catch(() => undefined);
    if (this.destroyed) return;
    const app = await attachPixi(this.host);
    if (this.destroyed) return;
    this.app = app;
    this.tex = buildTextures(app.renderer, this.pal);
    app.stage.addChild(this.stage);
    app.ticker.add(this.frame);
    this.resize();
    const h = this.host;
    h.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    h.addEventListener('pointerleave', this.onLeave);
    h.addEventListener('wheel', this.onWheel, { passive: false });
    h.addEventListener('contextmenu', this.onContext);
    this.ro.observe(h);
  }

  private ro = new ResizeObserver(() => this.resize());

  destroy(): void {
    this.destroyed = true;
    this.ro.disconnect();
    const h = this.host;
    h.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    h.removeEventListener('pointerleave', this.onLeave);
    h.removeEventListener('wheel', this.onWheel);
    h.removeEventListener('contextmenu', this.onContext);
    if (this.app) {
      this.app.ticker.remove(this.frame);
      detachPixi(this.app, this.host);
      this.app = null;
    }
    this.stage.destroy({ children: true });
    if (this.tex) destroyTextures(this.tex);
    this.bg.remove();
  }

  /** Theme change: rebuild note textures */
  refreshTheme(): void {
    this.pal = palette();
    if (this.app && this.tex) {
      destroyTextures(this.tex);
      this.tex = buildTextures(this.app.renderer, this.pal);
      for (const s of this.pool) s.destroy();
      this.pool = [];
    }
    this.lastSig = '';
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.bg.width = this.w * this.dpr;
    this.bg.height = this.h * this.dpr;
    this.bg.style.width = `${this.w}px`;
    this.bg.style.height = `${this.h}px`;
    this.app?.resize();
    const m = this.minimap;
    const mr = m.getBoundingClientRect();
    m.width = Math.max(1, mr.width * this.dpr);
    m.height = Math.max(1, mr.height * this.dpr);
    this.lastSig = '';
  }

  // ---------------------------------------------------------------- geometry
  get lanesTop(): number {
    return RULER_H + EVENTS_H;
  }
  get lanesBottom(): number {
    return this.h - SPEED_H;
  }
  get laneH(): number {
    return (this.lanesBottom - this.lanesTop) / 2;
  }
  laneY(lane: number): number {
    return this.lanesTop + this.laneH * (lane + 0.5);
  }
  get noteSize(): number {
    return Math.max(18, Math.min(this.laneH * 0.6, 60));
  }
  msToX(ms: number): number {
    const s = editor();
    return (ms - s.viewMs) * s.zoom;
  }
  xToMs(x: number): number {
    const s = editor();
    return s.viewMs + x / s.zoom;
  }
  private timing(): TimingMap {
    return editor().timing!;
  }
  tickToX(tick: number): number {
    return this.msToX(this.timing().tickToMs(tick));
  }
  xToTick(x: number): number {
    return this.timing().msToTick(this.xToMs(x));
  }
  private step(alt = false): number {
    return alt ? 1 : snapTicks(editor().snap);
  }
  snapTick(tick: number, alt = false): number {
    const st = this.step(alt);
    return Math.max(0, Math.round(tick / st) * st);
  }
  private laneAt(y: number): Lane | null {
    if (y < this.lanesTop || y > this.lanesBottom) return null;
    return y < this.lanesTop + this.laneH ? 0 : 1;
  }

  /** Song ms of the playhead: live audio position while playing */
  get playheadMs(): number {
    const s = editor();
    if (s.playing) return audio.songMsAt(performance.now()) - settings().audioOffsetMs;
    return s.cursorMs;
  }

  /** Note under a point (head, or anywhere on a span body) */
  hitTest(x: number, y: number): Note | null {
    const lane = this.laneAt(y);
    const diff = currentDiff();
    if (lane === null || !diff) return null;
    const half = this.noteSize / 2 + HIT_PAD;
    const t0 = this.xToTick(x - half);
    const t1 = this.xToTick(x + half);
    let best: Note | null = null;
    let bestD = Infinity;
    for (const n of diff.notes) {
      if (n.t > t1) break;
      const spanAny = n.type === 'mash' || n.type === 'roll';
      if (!spanAny && n.lane !== lane) continue;
      if (noteEnd(n) < t0) continue;
      const hx = this.tickToX(n.t);
      const d = Math.abs(hx - x);
      const onBody = SPAN_TYPES.has(n.type) && x >= hx && x <= this.tickToX(noteEnd(n)) + half;
      if ((d <= half || onBody) && d < bestD) {
        best = n;
        bestD = onBody ? Math.min(d, half) : d;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- transport
  play(fromMs?: number): void {
    const s = editor();
    if (!s.buffer) return;
    const start = fromMs ?? s.cursorMs;
    audio.load(s.buffer);
    audio.play(start + settings().audioOffsetMs, s.rate, 0.05, 0, { keepPitch: true });
    this.scheduledUntil = start - 1;
    s.set({ playing: true, follow: true });
    if (s.recording) this.beginRecordPass();
  }

  pause(): void {
    const s = editor();
    if (!s.playing) return;
    const at = this.playheadMs;
    audio.pause();
    if (s.recording) this.endRecordPass();
    s.set({ playing: false, cursorMs: Math.max(0, at) });
  }

  toggle(): void {
    if (editor().playing) this.pause();
    else this.play();
  }

  seek(ms: number): void {
    const s = editor();
    const clamped = Math.max(-2000, Math.min(ms, (s.buffer?.duration ?? 0) * 1000));
    if (s.playing) {
      audio.seek(clamped + settings().audioOffsetMs);
      this.scheduledUntil = clamped - 1;
      s.set({ cursorMs: clamped });
    } else {
      s.set({ cursorMs: clamped });
      this.ensureVisible(clamped);
    }
  }

  ensureVisible(ms: number): void {
    const s = editor();
    const x = this.msToX(ms);
    if (x < this.w * 0.08 || x > this.w * 0.92) s.set({ viewMs: ms - (this.w * FOLLOW_AT) / s.zoom });
  }

  zoomBy(factor: number, anchorX = this.w * FOLLOW_AT): void {
    const s = editor();
    const anchorMs = this.xToMs(anchorX);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom * factor));
    s.set({ zoom, viewMs: anchorMs - anchorX / zoom });
  }

  // ---------------------------------------------------------------- recording
  beginRecordPass(): void {
    this.recorded = [];
    this.recordKeys.clear();
    this.recordStartTick = Math.max(0, Math.floor(this.timing().msToTick(this.playheadMs)));
  }

  endRecordPass(): void {
    const s = editor();
    for (const k of [...this.recordKeys.keys()]) this.recordKey(k, false, performance.now());
    const diff = currentDiff();
    if (!s.chart || !diff || !this.recorded.length) {
      this.recorded = [];
      return;
    }
    const endTick = Math.ceil(this.timing().msToTick(this.playheadMs));
    let notes = diff.notes;
    if (s.recordOverwrite) notes = notes.filter((n) => n.t < this.recordStartTick || n.t > endTick);
    const added = this.recorded.sort(compareNotes);
    const next = addNotes(notes, added);
    s.commit(`Record ${added.length} notes`, withDifficulty(s.chart, s.diffIndex, { notes: next }), { selection: new Set(added) });
    this.recorded = [];
  }

  /** Gameplay key during a record pass. Returns true when consumed. */
  recordKey(key: number, down: boolean, timeStamp: number): boolean {
    const s = editor();
    if (!s.recording || !s.playing) return false;
    const lane = (key >> 1) as Lane;
    const ms = audio.songMsAt(timeStamp) - settings().audioOffsetMs;
    const rawTick = this.timing().msToTick(ms);
    const tick = s.recordQuantize ? this.snapTick(rawTick) : Math.max(0, Math.round(rawTick));
    if (down) {
      // second key of the same lane within 40 ms → big note
      for (const rk of this.recordKeys.values()) {
        if (rk.lane === lane && !rk.big && Math.abs(this.timing().tickToMs(rk.tick) - ms) < 40) {
          rk.big = true;
          return true;
        }
      }
      this.recordKeys.set(key, { tick, lane, key, big: false });
      if (s.hitsounds) audio.playSfx(lane === 0 ? 'ka' : 'don', 0.7);
      return true;
    }
    const rk = this.recordKeys.get(key);
    if (!rk) return true;
    this.recordKeys.delete(key);
    const held = tick - rk.tick;
    // held for at least a beat (and a full snap step) → hold note
    const note: Note = held >= Math.max(PPQ, this.step()) ? { t: rk.tick, lane, type: 'hold', dur: held } : { t: rk.tick, lane, type: rk.big ? 'big' : 'tap' };
    this.recorded = this.recorded.filter((n) => !(n.t === note.t && n.lane === note.lane));
    this.recorded.push(note);
    return true;
  }

  // ---------------------------------------------------------------- pointer
  private local(e: PointerEvent | WheelEvent) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onContext = (e: Event) => e.preventDefault();

  private onDown = (e: PointerEvent) => {
    const s = editor();
    if (!s.chart || !s.timing) return;
    const { x, y } = this.local(e);
    this.host.setPointerCapture?.(e.pointerId);
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { kind: 'pan', startX: x, startView: s.viewMs };
      s.set({ follow: false });
      return;
    }
    if (y >= this.lanesBottom) {
      this.onSpeedStripDown(e, x, y);
      return;
    }
    if (y < this.lanesTop) {
      // double-click a BPM marker: show it in the Timing tab
      if (this.isDoubleClick(e, x, y)) {
        const bp = s.chart.timing.bpm.find((b) => Math.abs(this.tickToX(b.t) - x) < 8);
        if (bp) {
          flashRow(`bpm:${bp.t}`);
          return;
        }
      }
      this.drag = { kind: 'seek' };
      this.seek(e.shiftKey ? this.timing().tickToMs(this.snapTick(this.xToTick(x))) : this.xToMs(x));
      return;
    }
    const lane = this.laneAt(y);
    if (lane === null) return;
    const hit = this.hitTest(x, y);
    const tick = this.xToTick(x);
    const diff = currentDiff()!;

    if (e.button === 2) {
      if (s.stamp) {
        s.set({ stamp: null });
        return;
      }
      this.drag = { kind: 'erase', hit: new Set(hit ? [hit] : []) };
      return;
    }

    if (s.stamp && e.button === 0) {
      const at = this.snapTick(tick, e.altKey);
      const flip = s.stamp[0] ? s.stamp[0].lane !== lane : false;
      const add = fromRelative(s.stamp, at, flip);
      s.commit('Stamp pattern', withDifficulty(s.chart, s.diffIndex, { notes: addNotes(diff.notes, add) }), { selection: new Set(add) });
      if (!e.shiftKey) s.set({ stamp: null });
      return;
    }

    if (s.tool === 'erase') {
      this.drag = { kind: 'erase', hit: new Set(hit ? [hit] : []) };
      return;
    }

    if (hit) {
      // resize handle: the tail of a span note
      if (SPAN_TYPES.has(hit.type) && Math.abs(this.tickToX(noteEnd(hit)) - x) < 10) {
        this.drag = { kind: 'resize', note: hit, dur: hit.dur ?? PPQ };
        s.set({ selection: new Set([hit]) });
        return;
      }
      let sel = s.selection;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        sel = new Set(sel);
        if (sel.has(hit)) sel.delete(hit);
        else sel.add(hit);
      } else if (!sel.has(hit)) {
        sel = new Set([hit]);
      }
      s.set({ selection: sel, inspector: 'note' });
      if (sel.has(hit)) this.drag = { kind: 'move', startTick: tick, startLane: lane, dTick: 0, dLane: 0, moved: false };
      return;
    }

    if (s.tool === 'select') {
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, additive: e.shiftKey || e.ctrlKey };
      if (!this.drag.additive) s.set({ selection: new Set() });
      return;
    }

    // placement tools
    const t = this.snapTick(tick, e.altKey);
    const type = s.tool as NoteType;
    if (SPAN_TYPES.has(type)) {
      this.drag = { kind: 'span', type, lane, t, dur: 0 };
      return;
    }
    const note: Note = { t, lane, type };
    s.commit(`Place ${type}`, withDifficulty(s.chart, s.diffIndex, { notes: addNotes(diff.notes, [note]) }), { selection: new Set([note]) });
    if (s.hitsounds && !s.playing) audio.playSfx(type === 'big' ? 'big' : lane === 0 ? 'ka' : 'don', 0.6);
  };

  // ---------------------------------------------------------------- speed strip
  private speedY(mult: number): number {
    const max = Math.max(2, this.timing().maxSpeed);
    return this.lanesBottom + 1 + SPEED_H - 6 - (mult / max) * (SPEED_H - 14);
  }
  private speedFromY(y: number): number {
    const max = Math.max(2, this.timing().maxSpeed);
    const v = ((this.lanesBottom + 1 + SPEED_H - 6 - y) / (SPEED_H - 14)) * max;
    return Math.max(0.05, Math.min(10, Math.round(v * 20) / 20));
  }

  private onSpeedStripDown(e: PointerEvent, x: number, y: number): void {
    const s = editor();
    if (!s.chart) return;
    const pts = s.chart.timing.speed;
    let index = -1;
    let best = 9;
    pts.forEach((p, i) => {
      const d = Math.hypot(this.tickToX(p.t) - x, (this.speedY(p.mult) - y) * 0.5);
      if (d < best) {
        best = d;
        index = i;
      }
    });
    if (index >= 0) {
      if (e.button === 2 && index > 0) {
        s.commit('Remove speed point', { ...s.chart, timing: { ...s.chart.timing, speed: pts.filter((_, j) => j !== index) } }, { keepSelection: true });
        return;
      }
      const p = pts[index];
      this.drag = { kind: 'speed', index, t: p.t, mult: p.mult, moved: false };
      flashRow(`speed:${p.t}`);
      return;
    }
    if (this.isDoubleClick(e, x, y) && e.button === 0) addSpeedPoint(this.snapTick(this.xToTick(x), e.altKey));
  }

  /** PointerEvent.detail is 0 in some browsers: track double-clicks ourselves */
  private lastClick = { at: 0, x: -99, y: -99 };
  private isDoubleClick(e: PointerEvent, x: number, y: number): boolean {
    const prev = this.lastClick;
    const dbl = e.timeStamp - prev.at < 400 && Math.abs(x - prev.x) < 6 && Math.abs(y - prev.y) < 6;
    this.lastClick = dbl ? { at: 0, x: -99, y: -99 } : { at: e.timeStamp, x, y };
    return dbl;
  }

  private onMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    this.pointer = { x, y, inside: x >= 0 && y >= 0 && x <= this.w && y <= this.h };
    const s = editor();
    if (!s.timing) return;
    const d = this.drag;
    switch (d.kind) {
      case 'seek':
        this.seek(this.xToMs(Math.max(0, Math.min(this.w, x))));
        break;
      case 'pan':
        s.set({ viewMs: d.startView - (x - d.startX) / s.zoom });
        break;
      case 'box':
        d.x1 = x;
        d.y1 = y;
        break;
      case 'move': {
        const st = this.step(e.altKey);
        const tick = this.xToTick(x);
        d.dTick = Math.round((tick - d.startTick) / st) * st;
        const lane = this.laneAt(y);
        d.dLane = lane !== null && lane !== d.startLane ? 1 : 0;
        if (d.dTick || d.dLane) d.moved = true;
        break;
      }
      case 'resize': {
        const st = this.step(e.altKey);
        d.dur = Math.max(st, this.snapTick(this.xToTick(x), e.altKey) - d.note.t);
        break;
      }
      case 'span':
        d.dur = Math.max(0, this.snapTick(this.xToTick(x), e.altKey) - d.t);
        break;
      case 'speed': {
        const t = d.index === 0 ? 0 : this.snapTick(this.xToTick(x), e.altKey);
        const mult = this.speedFromY(y);
        if (t !== d.t || mult !== d.mult) {
          d.t = t;
          d.mult = mult;
          d.moved = true;
        }
        break;
      }
      case 'erase': {
        const hit = this.hitTest(x, y);
        if (hit) d.hit.add(hit);
        break;
      }
    }
    // hover readout
    const lane = this.laneAt(y);
    if (this.pointer.inside && lane !== null) {
      const tick = this.snapTick(this.xToTick(x), e.altKey);
      if (!s.hover || s.hover.tick !== tick || s.hover.lane !== lane) s.set({ hover: { tick, lane } });
    } else if (s.hover) {
      s.set({ hover: null });
    }
  };

  private onLeave = () => {
    this.pointer.inside = false;
    if (editor().hover) editor().set({ hover: null });
  };

  private onUp = () => {
    const s = editor();
    const d = this.drag;
    this.drag = { kind: 'none' };
    const diff = currentDiff();
    if (!s.chart || !diff) return;
    switch (d.kind) {
      case 'box': {
        const xa = Math.min(d.x0, d.x1);
        const xb = Math.max(d.x0, d.x1);
        const ya = Math.min(d.y0, d.y1);
        const yb = Math.max(d.y0, d.y1);
        if (xb - xa < 3 && yb - ya < 3) break;
        const ta = this.xToTick(xa);
        const tb = this.xToTick(xb);
        const sel = new Set(d.additive ? s.selection : []);
        for (const n of diff.notes) {
          if (n.t < ta) continue;
          if (n.t > tb) break;
          const ly = this.laneY(n.lane);
          const any = n.type === 'mash' || n.type === 'roll';
          if (any || (ly >= ya - this.noteSize / 2 && ly <= yb + this.noteSize / 2)) sel.add(n);
        }
        s.set({ selection: sel, inspector: sel.size ? 'note' : s.inspector });
        break;
      }
      case 'move': {
        if (!d.moved) break;
        const { notes, remap } = moveNotes(diff.notes, s.selection, d.dTick, d.dLane);
        s.commit(`Move ${s.selection.size} note${s.selection.size > 1 ? 's' : ''}`, withDifficulty(s.chart, s.diffIndex, { notes }), { remap });
        break;
      }
      case 'resize': {
        if (d.dur === (d.note.dur ?? 0)) break;
        const { notes, remap } = setNoteProps(diff.notes, new Set([d.note]), { dur: d.dur });
        s.commit('Resize', withDifficulty(s.chart, s.diffIndex, { notes }), { remap });
        break;
      }
      case 'span': {
        const dur = d.dur || PPQ;
        const note: Note = { t: d.t, lane: d.lane, type: d.type, dur };
        if (d.type === 'mash') note.hits = Math.max(3, Math.round((dur / PPQ) * 4));
        s.commit(`Place ${d.type}`, withDifficulty(s.chart, s.diffIndex, { notes: addNotes(diff.notes, [note]) }), { selection: new Set([note]) });
        break;
      }
      case 'speed': {
        if (!d.moved) break;
        const pts = s.chart.timing.speed;
        const orig = pts[d.index];
        if (d.index > 0 && pts.some((p, k) => k !== d.index && p.t === d.t)) {
          toast('Another speed point already sits there', 'info', 1800);
          break;
        }
        const speed = pts.map((p, k) => (k === d.index ? { ...orig, t: d.t, mult: d.mult } : p)).sort((a, b) => a.t - b.t);
        s.commit('Edit speed point', { ...s.chart, timing: { ...s.chart.timing, speed } }, { keepSelection: true });
        flashRow(`speed:${d.t}`);
        break;
      }
      case 'erase': {
        if (!d.hit.size) break;
        s.commit(`Erase ${d.hit.size}`, withDifficulty(s.chart, s.diffIndex, { notes: removeNotes(diff.notes, d.hit) }), { keepSelection: false });
        break;
      }
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = editor();
    if (!s.timing) return;
    const { x } = this.local(e);
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.pow(1.0018, -delta), x);
    } else if (e.altKey) {
      const snaps = [1, 2, 3, 4, 6, 8, 12, 16] as const;
      const i = snaps.indexOf(s.snap);
      s.set({ snap: snaps[Math.max(0, Math.min(snaps.length - 1, i + (delta > 0 ? -1 : 1)))] });
    } else if (e.shiftKey) {
      // beat-scrub: move the playhead by one snap step
      const tick = this.snapTick(this.timing().msToTick(this.playheadMs));
      const next = Math.max(0, tick + (delta > 0 ? 1 : -1) * this.step());
      this.seek(this.timing().tickToMs(next));
    } else {
      s.set({ viewMs: s.viewMs + delta / s.zoom * 0.8, follow: false });
    }
  };

  // ---------------------------------------------------------------- frame
  private frame = () => {
    const s = editor();
    const now = performance.now();
    const dt = now - this.lastFrame;
    this.lastFrame = now;
    void dt;
    if (!s.chart || !s.timing || !this.tex) return;
    audio.tick();
    const head = this.playheadMs;

    if (s.playing) {
      if (s.follow) {
        const want = head - (this.w * FOLLOW_AT) / s.zoom;
        if (Math.abs(want - s.viewMs) > 0.5) s.set({ viewMs: want });
      }
      this.schedule(head);
      if (s.buffer && head > s.buffer.duration * 1000 + 200) this.pause();
    }

    const sig = [
      s.viewMs.toFixed(2), s.zoom, s.snap, this.w, this.h, s.chart === this.sigChart, s.selection.size, s.selection === this.sigSel,
      s.peaks ? 1 : 0, s.playing ? head.toFixed(1) : s.cursorMs, this.drag.kind, JSON.stringify(this.drag.kind === 'erase' ? (this.drag as { hit: Set<Note> }).hit.size : this.drag),
      s.hover?.tick, s.hover?.lane, s.tool, s.stamp?.length, this.recorded.length, this.recordKeys.size, s.diffIndex,
    ].join('|');
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.sigChart = s.chart;
    this.sigSel = s.selection;

    this.drawBackground(head);
    this.drawNotes(head);
    this.drawMinimap(head);
  };
  private sigChart: unknown = null;
  private sigSel: unknown = null;

  /** Schedules hitsounds and metronome ticks slightly ahead on the audio clock */
  private schedule(head: number): void {
    const s = editor();
    const from = this.scheduledUntil;
    const to = head + 150 * s.rate;
    if (to <= from) return;
    const timing = this.timing();
    const offset = settings().audioOffsetMs;
    const diff = currentDiff();
    if (s.hitsounds && diff && !s.recording) {
      const tFrom = timing.msToTick(from);
      const tTo = timing.msToTick(to);
      for (const n of diff.notes) {
        if (n.t <= tFrom) continue;
        if (n.t > tTo) break;
        const ms = timing.tickToMs(n.t);
        const when = audio.ctxTimeForSong(ms + offset);
        const name = n.type === 'big' ? 'big' : n.type === 'mine' ? 'mine' : n.type === 'collect' ? 'collect' : n.type === 'mash' || n.type === 'roll' ? 'mash' : n.lane === 0 ? 'ka' : 'don';
        audio.playSfx(name, n.type === 'mine' ? 0.3 : 0.7, Math.max(audio.now, when));
      }
    }
    if (s.metronome) {
      timing.forEachBeat(Math.max(0, Math.ceil(timing.msToTick(from) + 0.001)), timing.msToTick(to), (t, measure) => {
        const ms = timing.tickToMs(t);
        if (ms <= from || ms > to) return;
        audio.playSfx(measure ? 'metroHi' : 'metroLo', 0.8, Math.max(audio.now, audio.ctxTimeForSong(ms + offset)));
      });
    }
    this.scheduledUntil = to;
  }

  // ---------------------------------------------------------------- drawing (2D canvas)
  private drawBackground(head: number): void {
    const s = editor();
    const c = this.ctx;
    const p = this.pal;
    const { w, h } = this;
    const timing = this.timing();
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const top = this.lanesTop;
    const bottom = this.lanesBottom;
    // lanes
    c.fillStyle = rgba(p.laneUp, 0.05);
    c.fillRect(0, top, w, this.laneH);
    c.fillStyle = rgba(p.laneDown, 0.05);
    c.fillRect(0, top + this.laneH, w, this.laneH);
    c.fillStyle = p.line;
    c.fillRect(0, top + this.laneH, w, 1);
    c.fillRect(0, top, w, 1);
    c.fillRect(0, bottom, w, 1);

    // song bounds
    const endMs = (s.buffer?.duration ?? 0) * 1000;
    const x0 = this.msToX(0);
    const xEnd = this.msToX(endMs);
    c.fillStyle = rgba(p.bg, 0.6);
    if (x0 > 0) c.fillRect(0, top, x0, bottom - top);
    if (xEnd < w) c.fillRect(xEnd, top, w - xEnd, bottom - top);

    // waveform
    if (s.peaks) this.drawWave(s.peaks, top, bottom);

    // snap grid
    const tA = Math.max(0, Math.floor(this.xToTick(0)));
    const tB = Math.ceil(this.xToTick(w));
    const st = this.step();
    const pxPerStep = this.tickToX(tA + st) - this.tickToX(tA);
    const gridColors: Record<string, string> = {
      measure: rgba(p.text, 0.5),
      beat: rgba(p.text, 0.28),
      half: rgba(p.laneDown, 0.3),
      quarter: rgba(p.accent, 0.22),
      triplet: rgba(p.success, 0.25),
      fine: rgba(p.text, 0.08),
    };
    if (pxPerStep >= 5) {
      for (let t = Math.ceil(tA / st) * st; t <= tB; t += st) {
        const x = Math.round(this.tickToX(t)) + 0.5;
        c.fillStyle = gridColors[snapColor(t)];
        c.fillRect(x - 0.5, top, 1, bottom - top);
      }
    }
    timing.forEachBeat(tA, tB, (t, measure) => {
      if (!measure) return;
      const x = Math.round(this.tickToX(t));
      c.fillStyle = gridColors.measure;
      c.fillRect(x, top - EVENTS_H, 1, bottom - top + EVENTS_H);
    });

    // ruler
    c.fillStyle = p.surface;
    c.fillRect(0, 0, w, RULER_H);
    c.fillStyle = p.line;
    c.fillRect(0, RULER_H - 1, w, 1);
    c.font = `500 11px 'IBM Plex Mono', monospace`;
    c.textBaseline = 'middle';
    let lastLabel = -Infinity;
    timing.forEachBeat(tA, tB, (t, measure) => {
      const x = Math.round(this.tickToX(t));
      c.fillStyle = measure ? p.textMuted : p.textSubtle;
      c.fillRect(x, measure ? 10 : 20, 1, measure ? RULER_H - 10 : RULER_H - 20);
      if (measure && x - lastLabel > 34) {
        c.fillStyle = p.text;
        c.fillText(timing.beatLabel(t).split('.')[0], x + 4, 12);
        lastLabel = x;
      }
    });
    // BPM and speed markers on the ruler
    c.fillStyle = p.warning;
    for (const b of s.chart!.timing.bpm) {
      const x = this.tickToX(b.t);
      if (x < -60 || x > w) continue;
      c.fillRect(x, 0, 2, RULER_H);
      c.fillText(`${+b.bpm.toFixed(2)} bpm`, x + 5, 23);
    }

    // events strip (sections, bookmarks)
    c.fillStyle = rgba(p.surface, 0.8);
    c.fillRect(0, RULER_H, w, EVENTS_H);
    const diff = currentDiff();
    if (diff) {
      for (const ev of diff.events) {
        const x = this.tickToX(ev.t);
        if (x < -200 || x > w) continue;
        if (ev.type === 'section') {
          c.fillStyle = p.accent;
          c.beginPath();
          c.moveTo(x, RULER_H + 2);
          c.lineTo(x + 8, RULER_H + 2);
          c.lineTo(x + 12, RULER_H + 6);
          c.lineTo(x, RULER_H + 6);
          c.fill();
          c.fillRect(x, RULER_H + 2, 1, EVENTS_H - 2);
          c.fillText(ev.label ?? 'Section', x + 6, RULER_H + 13);
        } else if (ev.type === 'bookmark') {
          c.fillStyle = p.laneDown;
          c.fillRect(x - 3, RULER_H + 4, 7, 7);
          if (ev.label) c.fillText(ev.label, x + 7, RULER_H + 10);
        } else {
          c.fillStyle = p.textMuted;
          c.fillRect(x, RULER_H + 4, 2, EVENTS_H - 6);
          c.fillText(ev.type, x + 5, RULER_H + 11);
        }
      }
    }

    // speed strip
    const sy = bottom + 1;
    c.fillStyle = rgba(p.surface, 0.9);
    c.fillRect(0, sy, w, SPEED_H - 1);
    const maxSpeed = Math.max(2, timing.maxSpeed);
    c.strokeStyle = p.success;
    c.lineWidth = 1.5;
    c.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const v = timing.speedAtMs(this.xToMs(x));
      const y = sy + SPEED_H - 6 - (v / maxSpeed) * (SPEED_H - 14);
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    c.fillStyle = p.success;
    for (const sp of s.chart!.timing.speed) {
      const x = this.tickToX(sp.t);
      if (x < -60 || x > w) continue;
      const y = sy + SPEED_H - 6 - (sp.mult / maxSpeed) * (SPEED_H - 14);
      c.fillRect(x - 3, y - 3, 6, 6);
      c.fillText(`${sp.mult}×`, x + 6, y - 6 < sy + 6 ? y + 8 : y - 6);
    }
    if (this.drag.kind === 'speed') {
      const d = this.drag;
      const x = this.tickToX(d.t);
      const y = this.speedY(d.mult);
      c.strokeStyle = p.text;
      c.lineWidth = 1;
      c.strokeRect(x - 5.5, y - 5.5, 11, 11);
      c.fillStyle = p.text;
      c.fillText(`${d.mult}× · ${timing.beatLabel(d.t)}`, x + 9, y - 6 < sy + 6 ? y + 8 : y - 6);
    }
    c.fillStyle = p.textSubtle;
    c.fillText('SCROLL SPEED', w - 92, sy + 10);

    // box selection
    if (this.drag.kind === 'box') {
      const d = this.drag;
      c.fillStyle = rgba(p.accent, 0.08);
      c.strokeStyle = p.accent;
      c.lineWidth = 1;
      const bx = Math.min(d.x0, d.x1);
      const by = Math.min(d.y0, d.y1);
      c.fillRect(bx, by, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      c.strokeRect(bx + 0.5, by + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // hover column
    if (s.hover && this.drag.kind === 'none' && !s.playing) {
      const x = Math.round(this.tickToX(s.hover.tick)) + 0.5;
      c.fillStyle = rgba(p.text, 0.25);
      c.fillRect(x - 0.5, top, 1, bottom - top);
    }

    // playhead
    const px = Math.round(this.msToX(head)) + 0.5;
    if (px >= -2 && px <= w + 2) {
      c.fillStyle = p.accent;
      c.fillRect(px - 1, 0, 2, bottom);
      c.beginPath();
      c.moveTo(px - 6, 0);
      c.lineTo(px + 6, 0);
      c.lineTo(px, 8);
      c.fill();
    }
    if (s.recording) {
      c.fillStyle = p.error;
      c.fillRect(0, top, 3, bottom - top);
    }
  }

  private drawWave(peaks: Peaks, top: number, bottom: number): void {
    const c = this.ctx;
    const { w } = this;
    const mid = (top + bottom) / 2;
    const amp = (bottom - top) * 0.46;
    const sr = peaks.sampleRate;
    const s = editor();
    const samplesPerPx = sr / (s.zoom * 1000);
    let level = peaks.levels[0];
    for (const l of peaks.levels) if (l.bucket <= samplesPerPx) level = l;
    const { min, max, bucket } = level;
    c.fillStyle = rgba(this.pal.text, 0.16);
    for (let x = 0; x < w; x++) {
      const msA = this.xToMs(x);
      const a = Math.floor((msA * sr) / 1000 / bucket);
      const b = Math.max(a + 1, Math.floor(((msA + 1 / s.zoom) * sr) / 1000 / bucket));
      if (b <= 0 || a >= min.length) continue;
      let lo = 1;
      let hi = -1;
      for (let i = Math.max(0, a); i < Math.min(min.length, b); i++) {
        if (min[i] < lo) lo = min[i];
        if (max[i] > hi) hi = max[i];
      }
      if (hi < lo) continue;
      c.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
  }

  private drawMinimap(head: number): void {
    const s = editor();
    const m = this.minimap;
    const c = m.getContext('2d');
    if (!c || !s.chart) return;
    const W = m.width;
    const H = m.height;
    const p = this.pal;
    const diff = currentDiff();
    const durMs = Math.max(1, (s.buffer?.duration ?? 1) * 1000);
    if (diff && this.densityFor !== diff.notes) {
      this.densityFor = diff.notes;
      this.density = analyzeDifficulty(s.chart, diff, 200, durMs).density;
    }
    c.clearRect(0, 0, W, H);
    c.fillStyle = p.surface;
    c.fillRect(0, 0, W, H);
    if (this.density) {
      const n = this.density.length;
      const bw = W / n;
      c.fillStyle = rgba(p.accent, 0.55);
      for (let i = 0; i < n; i++) {
        const v = this.density[i];
        if (v > 0) c.fillRect(i * bw, H - v * (H - 4), Math.max(1, bw - 1), v * (H - 4));
      }
    }
    if (diff) {
      c.fillStyle = p.text;
      for (const ev of diff.events) {
        if (ev.type !== 'section' && ev.type !== 'bookmark') continue;
        const x = (this.timing().tickToMs(ev.t) / durMs) * W;
        c.fillStyle = ev.type === 'section' ? p.accent : p.laneDown;
        c.fillRect(x, 0, Math.max(1, this.dpr), H);
      }
    }
    // viewport + playhead
    const vx = (s.viewMs / durMs) * W;
    const vw = (this.w / s.zoom / durMs) * W;
    c.fillStyle = rgba(p.text, 0.08);
    c.fillRect(vx, 0, vw, H);
    c.strokeStyle = rgba(p.text, 0.5);
    c.lineWidth = this.dpr;
    c.strokeRect(vx + 0.5, 0.5, vw, H - 1);
    c.fillStyle = p.accent;
    c.fillRect((head / durMs) * W - this.dpr / 2, 0, this.dpr * 1.5, H);
  }

  // ---------------------------------------------------------------- drawing (Pixi notes)
  private sprite(tex: Texture): Sprite {
    let sp = this.pool[this.used];
    if (!sp) {
      sp = new Sprite(tex);
      sp.anchor.set(0.5);
      this.noteLayer.addChild(sp);
      this.pool.push(sp);
    } else if (sp.texture !== tex) sp.texture = tex;
    sp.visible = true;
    sp.alpha = 1;
    sp.tint = 0xffffff;
    sp.rotation = 0;
    sp.anchor.set(0.5);
    this.used++;
    return sp;
  }

  private body(x0: number, x1: number, y: number, color: number, alpha: number): void {
    const b = this.sprite(this.tex!.white);
    b.anchor.set(0, 0.5);
    b.position.set(x0, y);
    b.width = Math.max(1, x1 - x0);
    b.height = this.noteSize * 0.4;
    b.tint = color;
    b.alpha = alpha;
  }

  private drawNote(n: Note, dTick: number, flip: boolean, alpha: number, selected: boolean, durOverride?: number): void {
    const tex = this.tex!;
    const p = this.pal;
    const lane = (flip ? 1 - n.lane : n.lane) as Lane;
    const t = n.t + dTick;
    const x = this.tickToX(t);
    const any = n.type === 'mash' || n.type === 'roll';
    const y = n.type === 'mash' ? this.lanesTop + this.laneH : this.laneY(lane);
    const scale = this.noteSize / BASE;
    if (SPAN_TYPES.has(n.type)) {
      const dur = durOverride ?? n.dur ?? PPQ;
      const xe = this.tickToX(t + dur);
      const color = hex(n.type === 'roll' ? p.warning : n.type === 'mash' ? p.accent : lane === 0 ? p.laneUp : p.laneDown);
      this.body(x, xe, y, color, alpha * (n.type === 'mash' ? 0.18 : 0.35));
      const tail = this.sprite(tex.holdTail[lane]);
      tail.position.set(xe, y);
      tail.scale.set(scale);
      tail.alpha = alpha;
      if (any) tail.tint = color;
    }
    let texture = tex.tap[lane];
    let sc = scale;
    switch (n.type) {
      case 'big': texture = tex.big[lane]; sc = scale * 1.25; break;
      case 'mine': texture = tex.mine; break;
      case 'collect': texture = tex.collect; break;
      case 'mash': texture = tex.mash; sc = scale * 0.85; break;
      case 'roll': texture = tex.rollHead; break;
    }
    if (selected) {
      const ring = this.sprite(tex.receptor);
      ring.position.set(x, y);
      ring.scale.set(sc * 1.15);
      ring.tint = hex(p.text);
    }
    const sp = this.sprite(texture);
    sp.position.set(x, y);
    sp.scale.set(sc);
    sp.alpha = alpha;
  }

  private drawNotes(head: number): void {
    const s = editor();
    const diff = currentDiff();
    this.used = 0;
    if (diff) {
      const half = this.noteSize;
      const tA = this.xToTick(-half);
      const tB = this.xToTick(this.w + half);
      const d = this.drag;
      const moving = d.kind === 'move' && d.moved;
      const erasing = d.kind === 'erase' ? d.hit : null;
      // binary search the first note that can be visible (long spans start earlier)
      const notes = diff.notes;
      let lo = 0;
      let hi = notes.length;
      const from = tA - PPQ * 64;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].t < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < notes.length; i++) {
        const n = notes[i];
        if (n.t > tB) break;
        if (noteEnd(n) < tA) continue;
        if (erasing?.has(n)) continue;
        const selected = s.selection.has(n);
        if (selected && moving) {
          this.drawNote(n, 0, false, 0.18, false);
          this.drawNote(n, d.dTick, d.dLane === 1, 0.9, true);
          continue;
        }
        const resizing = d.kind === 'resize' && d.note === n;
        // already-played notes dim while playing
        const passed = s.playing && this.timing().tickToMs(noteEnd(n)) < head;
        this.drawNote(n, 0, false, passed ? 0.45 : 1, selected, resizing ? d.dur : undefined);
      }
    }
    // in-progress span
    if (this.drag.kind === 'span') {
      const d = this.drag;
      this.drawNote({ t: d.t, lane: d.lane, type: d.type, dur: d.dur || PPQ }, 0, false, 0.8, true);
    }
    // recorded (not yet committed) notes
    for (const n of this.recorded) this.drawNote(n, 0, false, 0.85, true);
    for (const rk of this.recordKeys.values()) {
      const cur = Math.max(rk.tick, this.snapTick(this.timing().msToTick(head)));
      this.drawNote({ t: rk.tick, lane: rk.lane, type: cur - rk.tick >= PPQ ? 'hold' : 'tap', dur: cur - rk.tick }, 0, false, 0.85, true);
    }
    // ghost of the active tool / pattern stamp under the cursor
    if (s.hover && this.drag.kind === 'none' && this.pointer.inside && !s.playing) {
      if (s.stamp) {
        const flip = s.stamp[0] ? s.stamp[0].lane !== s.hover.lane : false;
        for (const n of fromRelative(s.stamp, s.hover.tick, flip)) this.drawNote(n, 0, false, 0.45, false);
      } else if (s.tool !== 'select' && s.tool !== 'erase' && !this.hitTest(this.pointer.x, this.pointer.y)) {
        const type = s.tool as NoteType;
        this.drawNote({ t: s.hover.tick, lane: s.hover.lane as Lane, type, dur: SPAN_TYPES.has(type) ? PPQ : undefined }, 0, false, 0.4, false);
      }
    }
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  // ---------------------------------------------------------------- helpers for the UI
  /** Tick under the playhead, snapped */
  playheadTick(): number {
    return this.snapTick(this.timing().msToTick(this.playheadMs));
  }
}
