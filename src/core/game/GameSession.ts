import type { CompiledChart } from '../chart/compile';
import { NoteKind } from '../chart/types';

/**
 * Pure game logic: judgement, scoring, combo and gauge.
 * It knows nothing about rendering or audio: inputs come in as
 * (key, songMs) pairs that carry the *real* press time (event timestamp mapped
 * to song time), so judgement does not depend on the frame rate.
 * Outputs are pushed into a preallocated ring buffer of events.
 */

export const Judgement = { perfect: 0, great: 1, good: 2, miss: 3 } as const;
export type JudgementId = (typeof Judgement)[keyof typeof Judgement];
export const JUDGEMENT_NAMES = ['PERFECT', 'GREAT', 'GOOD', 'MISS'] as const;
const JUDGEMENT_VALUE = [1, 0.7, 0.3, 0];

export interface HitWindows {
  perfect: number;
  great: number;
  good: number;
}

export const DEFAULT_WINDOWS: HitWindows = { perfect: 35, great: 70, good: 110 };
export const BIG_PAIR_MS = 30;
export const MINE_WINDOW_MS = 45;
export const CLEAR_THRESHOLD = 0.7;

export const GameEvent = {
  hit: 0,        // tap / big / hold head judged (j, offset)
  holdEnd: 1,    // hold tail judged
  holdBreak: 2,  // hold released too early
  mashHit: 3,    // value = remaining hits
  mashDone: 4,   // j
  rollHit: 5,
  mineHit: 6,
  collect: 7,
  collectMiss: 8,
  miss: 9,       // a note passed without input
} as const;

const PENDING = 0;
const ACTIVE = 1; // big waiting for its second key, hold being held, mash being hit
const DONE = 2;

const EVENT_CAPACITY = 512;

/** Key index: 0,1 = up lane; 2,3 = down lane */
export const keyLane = (key: number): 0 | 1 => (key >> 1) as 0 | 1;

export class GameSession {
  readonly chart: CompiledChart;
  readonly windows: HitWindows;

  // per-note state
  readonly state: Uint8Array;
  readonly result: Int8Array;      // head judgement, -1 = none
  readonly tailResult: Int8Array;
  readonly mashCount: Uint16Array;
  private readonly bigPressMs: Float64Array;
  private readonly bigKey: Int8Array;
  private readonly bigJudge: Int8Array;

  // lane-indexed lists of note indices
  private readonly laneList: [Int32Array, Int32Array];
  private readonly laneCursor = new Int32Array(2);
  private readonly spanList: Int32Array; // mash + roll (any key)
  private spanCursor = 0;

  private heldMask = 0;

  // scoring
  combo = 0;
  maxCombo = 0;
  readonly counts = new Uint32Array(4); // per judgement
  rollHits = 0;
  collected = 0;
  collectTotal = 0;
  minesHit = 0;
  gauge = 0;
  private weightedSum = 0;
  private judgedWeight = 0;
  totalWeight: number;
  private gaugeUnit: number;

  // hit error log (signed ms, negative = early)
  readonly hitErrors: Float32Array;
  hitErrorCount = 0;

  // event ring buffer
  readonly evType = new Uint8Array(EVENT_CAPACITY);
  readonly evLane = new Uint8Array(EVENT_CAPACITY);
  readonly evJudge = new Int8Array(EVENT_CAPACITY);
  readonly evOffset = new Float32Array(EVENT_CAPACITY);
  readonly evNote = new Int32Array(EVENT_CAPACITY);
  readonly evValue = new Int32Array(EVENT_CAPACITY);
  evWrite = 0;

  // autoplay
  autoplay = false;
  private readonly autoRelease = new Float64Array(4).fill(Infinity);
  private readonly autoNextSpanHit: Float64Array;

  constructor(chart: CompiledChart, windows: HitWindows = DEFAULT_WINDOWS, autoplay = false) {
    this.chart = chart;
    this.windows = windows;
    this.autoplay = autoplay;
    const n = chart.count;
    this.state = new Uint8Array(n);
    this.result = new Int8Array(n).fill(-1);
    this.tailResult = new Int8Array(n).fill(-1);
    this.mashCount = new Uint16Array(n);
    this.bigPressMs = new Float64Array(n);
    this.bigKey = new Int8Array(n).fill(-1);
    this.bigJudge = new Int8Array(n).fill(-1);
    this.autoNextSpanHit = new Float64Array(n);
    this.hitErrors = new Float32Array(Math.max(1, n * 2));

    const lanes: [number[], number[]] = [[], []];
    const spans: number[] = [];
    let weight = 0;
    for (let i = 0; i < n; i++) {
      const k = chart.kind[i];
      if (k === NoteKind.mash || k === NoteKind.roll) spans.push(i);
      else lanes[chart.lane[i]].push(i);
      weight += GameSession.weightOf(k);
      if (k === NoteKind.collect) this.collectTotal++;
    }
    this.laneList = [Int32Array.from(lanes[0]), Int32Array.from(lanes[1])];
    this.spanList = Int32Array.from(spans);
    this.totalWeight = weight;
    // a full-perfect run fills the gauge at ~75% of the chart
    this.gaugeUnit = weight > 0 ? 1 / (weight * 0.75) : 0;
  }

  /** Scoring weight of a note kind (hold = head + tail) */
  static weightOf(kind: number): number {
    switch (kind) {
      case NoteKind.tap:
      case NoteKind.mash:
        return 1;
      case NoteKind.big:
      case NoteKind.hold:
        return 2;
      default:
        return 0;
    }
  }

  /**
   * Starts mid-chart (practice, editor test play): notes before `ms` are marked
   * done without being judged, and leave the score's denominator.
   */
  skipBefore(ms: number): void {
    const c = this.chart;
    let removed = 0;
    for (let i = 0; i < c.count; i++) {
      if (c.time[i] >= ms) continue;
      this.state[i] = DONE;
      removed += GameSession.weightOf(c.kind[i]);
      if (c.kind[i] === NoteKind.collect) this.collectTotal--;
    }
    this.totalWeight -= removed;
    this.gaugeUnit = this.totalWeight > 0 ? 1 / (this.totalWeight * 0.75) : 0;
    this.update(ms - this.windows.good - 1);
  }

  // ---------------------------------------------------------------- results
  get score(): number {
    return this.totalWeight > 0 ? Math.round((1_000_000 * this.weightedSum) / this.totalWeight) : 0;
  }

  /** Accuracy over what has been judged so far, 0..1 */
  get accuracy(): number {
    return this.judgedWeight > 0 ? this.weightedSum / this.judgedWeight : 1;
  }

  /** Final accuracy against the whole chart */
  get finalAccuracy(): number {
    return this.totalWeight > 0 ? this.weightedSum / this.totalWeight : 1;
  }

  get cleared(): boolean {
    return this.gauge >= CLEAR_THRESHOLD;
  }

  get fullCombo(): boolean {
    return this.counts[Judgement.miss] === 0 && this.minesHit === 0;
  }

  isFinished(nowMs: number): boolean {
    return nowMs > this.chart.lastMs + this.windows.good + 400;
  }

  isLaneHeld(lane: number): boolean {
    return (this.heldMask & (lane === 0 ? 0b0011 : 0b1100)) !== 0;
  }

  // ---------------------------------------------------------------- input
  press(key: number, ms: number): void {
    const lane = keyLane(key);
    this.heldMask |= 1 << key;
    if (this.tryBigSecondKey(lane, key, ms)) return;
    if (this.tryLaneNote(lane, key, ms)) return;
    if (this.trySpan(ms)) return;
    this.tryMine(lane, ms);
  }

  release(key: number, ms: number): void {
    const lane = keyLane(key);
    this.heldMask &= ~(1 << key);
    if (this.isLaneHeld(lane)) return;
    const list = this.laneList[lane];
    const c = this.chart;
    for (let j = this.laneCursor[lane]; j < list.length; j++) {
      const i = list[j];
      if (c.time[i] > ms + this.windows.good) break;
      if (c.kind[i] !== NoteKind.hold || this.state[i] !== ACTIVE) continue;
      const dt = ms - c.end[i];
      if (dt >= -this.windows.good) {
        this.judgeTail(i, this.judgeOffset(dt));
      } else {
        this.state[i] = DONE;
        this.tailResult[i] = Judgement.miss;
        this.applyJudgement(Judgement.miss, 1);
        this.emit(GameEvent.holdBreak, lane, Judgement.miss, dt, i, 0);
      }
    }
  }

  private judgeOffset(dt: number): JudgementId {
    const a = Math.abs(dt);
    const w = this.windows;
    return a <= w.perfect ? Judgement.perfect : a <= w.great ? Judgement.great : a <= w.good ? Judgement.good : Judgement.miss;
  }

  private tryBigSecondKey(lane: number, key: number, ms: number): boolean {
    const list = this.laneList[lane];
    const c = this.chart;
    for (let j = this.laneCursor[lane]; j < list.length; j++) {
      const i = list[j];
      if (c.time[i] > ms + this.windows.good) break;
      if (c.kind[i] === NoteKind.big && this.state[i] === ACTIVE && this.bigKey[i] !== key && ms - this.bigPressMs[i] <= BIG_PAIR_MS) {
        this.finishBig(i, this.bigJudge[i] as JudgementId, true);
        return true;
      }
    }
    return false;
  }

  private tryLaneNote(lane: number, key: number, ms: number): boolean {
    const list = this.laneList[lane];
    const c = this.chart;
    const good = this.windows.good;
    for (let j = this.laneCursor[lane]; j < list.length; j++) {
      const i = list[j];
      const t = c.time[i];
      if (t > ms + good) break;
      if (this.state[i] !== PENDING) continue;
      const dt = ms - t;
      if (dt > good) continue; // late: the next update() marks it missed
      const k = c.kind[i];
      if (k === NoteKind.mine) continue;
      if (k === NoteKind.collect) {
        this.collect(i);
        return true;
      }
      const jdg = this.judgeOffset(dt);
      this.logError(dt);
      if (k === NoteKind.tap) {
        this.state[i] = DONE;
        this.result[i] = jdg;
        this.applyJudgement(jdg, 1);
        this.emit(GameEvent.hit, lane, jdg, dt, i, k);
      } else if (k === NoteKind.big) {
        this.state[i] = ACTIVE;
        this.bigPressMs[i] = ms;
        this.bigKey[i] = key;
        this.bigJudge[i] = jdg;
      } else if (k === NoteKind.hold) {
        this.state[i] = ACTIVE;
        this.result[i] = jdg;
        this.applyJudgement(jdg, 1);
        this.emit(GameEvent.hit, lane, jdg, dt, i, k);
        if (this.autoplay) this.autoRelease[key] = Math.min(this.autoRelease[key], c.end[i]);
      }
      return true;
    }
    return false;
  }

  private trySpan(ms: number): boolean {
    const list = this.spanList;
    const c = this.chart;
    const good = this.windows.good;
    for (let j = this.spanCursor; j < list.length; j++) {
      const i = list[j];
      if (c.time[i] - good > ms) break;
      if (this.state[i] === DONE || ms > c.end[i]) continue;
      if (c.kind[i] === NoteKind.mash) {
        this.state[i] = ACTIVE;
        this.mashCount[i]++;
        const remaining = c.hits[i] - this.mashCount[i];
        this.emit(GameEvent.mashHit, c.lane[i], -1, 0, i, remaining);
        if (remaining <= 0) this.finishMash(i);
      } else {
        this.rollHits++;
        this.emit(GameEvent.rollHit, c.lane[i], -1, 0, i, this.rollHits);
      }
      return true;
    }
    return false;
  }

  private tryMine(lane: number, ms: number): void {
    const list = this.laneList[lane];
    const c = this.chart;
    for (let j = this.laneCursor[lane]; j < list.length; j++) {
      const i = list[j];
      if (c.time[i] > ms + MINE_WINDOW_MS) break;
      if (c.kind[i] !== NoteKind.mine || this.state[i] !== PENDING) continue;
      if (Math.abs(ms - c.time[i]) <= MINE_WINDOW_MS) {
        this.state[i] = DONE;
        this.result[i] = Judgement.miss;
        this.minesHit++;
        this.breakCombo();
        this.gauge = Math.max(0, this.gauge - this.gaugeUnit * 2);
        this.emit(GameEvent.mineHit, lane, Judgement.miss, 0, i, 0);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- per frame
  /** Advances time-driven state (misses, hold ends, mash timeouts). Call every frame. */
  update(nowMs: number): void {
    if (this.autoplay) this.runAutoplay(nowMs);
    const c = this.chart;
    const good = this.windows.good;
    for (let lane = 0; lane < 2; lane++) {
      const list = this.laneList[lane];
      const held = this.isLaneHeld(lane);
      for (let j = this.laneCursor[lane]; j < list.length; j++) {
        const i = list[j];
        const t = c.time[i];
        if (t > nowMs + good) break;
        const s = this.state[i];
        if (s === DONE) continue;
        const k = c.kind[i];
        if (k === NoteKind.big && s === ACTIVE) {
          if (nowMs - this.bigPressMs[i] > BIG_PAIR_MS) this.finishBig(i, this.bigJudge[i] as JudgementId, false);
        } else if (k === NoteKind.hold && s === ACTIVE) {
          if (held && nowMs >= c.end[i]) this.judgeTail(i, Judgement.perfect);
        } else if (k === NoteKind.collect) {
          if (held && nowMs >= t - this.windows.perfect) this.collect(i);
          else if (nowMs > t + good) {
            this.state[i] = DONE;
            this.emit(GameEvent.collectMiss, lane, -1, 0, i, 0);
          }
        } else if (k === NoteKind.mine) {
          if (nowMs > t + MINE_WINDOW_MS) this.state[i] = DONE;
        } else if (nowMs > t + good) {
          // tap / big / hold head never pressed
          this.state[i] = DONE;
          this.result[i] = Judgement.miss;
          const units = k === NoteKind.tap ? 1 : 2;
          if (k === NoteKind.hold) this.tailResult[i] = Judgement.miss;
          this.applyJudgement(Judgement.miss, units);
          this.emit(GameEvent.miss, lane, Judgement.miss, 0, i, k);
        }
      }
      // skip finished notes at the front
      while (this.laneCursor[lane] < list.length && this.state[list[this.laneCursor[lane]]] === DONE) this.laneCursor[lane]++;
    }

    const spans = this.spanList;
    for (let j = this.spanCursor; j < spans.length; j++) {
      const i = spans[j];
      if (c.time[i] - good > nowMs) break;
      if (this.state[i] === DONE) continue;
      if (c.kind[i] === NoteKind.mash) {
        if (this.state[i] === PENDING && nowMs >= c.time[i]) this.state[i] = ACTIVE;
        if (nowMs > c.end[i]) this.finishMash(i);
      } else if (nowMs > c.end[i]) {
        this.state[i] = DONE;
      } else if (nowMs >= c.time[i]) {
        this.state[i] = ACTIVE;
      }
    }
    while (this.spanCursor < spans.length && this.state[spans[this.spanCursor]] === DONE) this.spanCursor++;
  }

  private runAutoplay(nowMs: number): void {
    const c = this.chart;
    for (let key = 0; key < 4; key++) {
      if (this.autoRelease[key] <= nowMs) {
        const at = this.autoRelease[key];
        this.autoRelease[key] = Infinity;
        this.release(key, at);
      }
    }
    for (let lane = 0; lane < 2; lane++) {
      const list = this.laneList[lane];
      for (let j = this.laneCursor[lane]; j < list.length; j++) {
        const i = list[j];
        const t = c.time[i];
        if (t > nowMs) break;
        if (this.state[i] !== PENDING) continue;
        const k = c.kind[i];
        if (k === NoteKind.mine) continue;
        const key = lane * 2;
        this.press(key, t);
        if (k === NoteKind.big) this.press(key + 1, t);
        if (k === NoteKind.hold) this.autoRelease[key] = c.end[i] + 1;
        else {
          this.autoRelease[key] = Math.min(this.autoRelease[key], t + 40);
          if (k === NoteKind.big) this.autoRelease[key + 1] = t + 40;
        }
      }
    }
    for (let j = this.spanCursor; j < this.spanList.length; j++) {
      const i = this.spanList[j];
      if (c.time[i] > nowMs) break;
      if (this.state[i] === DONE || nowMs > c.end[i]) continue;
      const interval = c.kind[i] === NoteKind.mash ? Math.max(30, (c.end[i] - c.time[i]) / (c.hits[i] + 2)) : 70;
      if (this.autoNextSpanHit[i] === 0) this.autoNextSpanHit[i] = c.time[i];
      while (this.autoNextSpanHit[i] <= nowMs && this.state[i] !== DONE) {
        const at = this.autoNextSpanHit[i];
        this.autoNextSpanHit[i] += interval;
        const key = (j & 1) * 2;
        this.press(key, at);
        this.heldMask &= ~(1 << key);
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  private finishBig(i: number, jdg: JudgementId, both: boolean): void {
    const final = both ? jdg : (Math.max(jdg, Judgement.good) as JudgementId);
    this.state[i] = DONE;
    this.result[i] = final;
    this.applyJudgement(final, 2);
    this.emit(GameEvent.hit, this.chart.lane[i], final, this.bigPressMs[i] - this.chart.time[i], i, both ? 100 + NoteKind.big : NoteKind.big);
  }

  private finishMash(i: number): void {
    const ratio = this.mashCount[i] / this.chart.hits[i];
    const jdg = ratio >= 1 ? Judgement.perfect : ratio >= 0.75 ? Judgement.great : ratio >= 0.4 ? Judgement.good : Judgement.miss;
    this.state[i] = DONE;
    this.result[i] = jdg;
    this.applyJudgement(jdg, 1);
    this.emit(GameEvent.mashDone, this.chart.lane[i], jdg, 0, i, this.mashCount[i]);
  }

  private judgeTail(i: number, jdg: JudgementId): void {
    this.state[i] = DONE;
    this.tailResult[i] = jdg;
    this.applyJudgement(jdg, 1);
    this.emit(GameEvent.holdEnd, this.chart.lane[i], jdg, 0, i, 0);
  }

  private collect(i: number): void {
    this.state[i] = DONE;
    this.result[i] = Judgement.perfect;
    this.collected++;
    this.emit(GameEvent.collect, this.chart.lane[i], Judgement.perfect, 0, i, 0);
  }

  /** `units` judgement units, each weighing 1 (big = 2 units of the same judgement) */
  private applyJudgement(jdg: JudgementId, units: number): void {
    this.counts[jdg]++;
    this.weightedSum += JUDGEMENT_VALUE[jdg] * units;
    this.judgedWeight += units;
    if (jdg === Judgement.miss) {
      this.breakCombo();
      this.gauge = Math.max(0, this.gauge - this.gaugeUnit * 1.6 * units);
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      const gain = jdg === Judgement.perfect ? 1 : jdg === Judgement.great ? 0.6 : 0.15;
      this.gauge = Math.min(1, this.gauge + this.gaugeUnit * gain * units);
    }
  }

  private breakCombo(): void {
    this.combo = 0;
  }

  private logError(dt: number): void {
    if (this.hitErrorCount < this.hitErrors.length) this.hitErrors[this.hitErrorCount++] = dt;
  }

  private emit(type: number, lane: number, jdg: number, offset: number, note: number, value: number): void {
    const w = this.evWrite % EVENT_CAPACITY;
    this.evType[w] = type;
    this.evLane[w] = lane;
    this.evJudge[w] = jdg;
    this.evOffset[w] = offset;
    this.evNote[w] = note;
    this.evValue[w] = value;
    this.evWrite++;
  }

  static readonly EVENT_CAPACITY = EVENT_CAPACITY;

  /** Note state helpers for the renderer */
  static readonly PENDING = PENDING;
  static readonly ACTIVE = ACTIVE;
  static readonly DONE = DONE;
}

export const gradeFor = (accuracy: number): string =>
  accuracy >= 0.99 ? 'SS' : accuracy >= 0.95 ? 'S' : accuracy >= 0.9 ? 'A' : accuracy >= 0.8 ? 'B' : accuracy >= 0.7 ? 'C' : 'D';
