import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { JUDGEMENT_NAMES } from '../../core/game/GameSession';
import { useSettings } from '../../storage/settings';
import { Button } from '../components/controls';
import { AngleFrame, DecodeText, Eyebrow, GlitchText, SectionLabel, useReducedMotion } from '../components/decor';
import { toast } from '../components/overlays';
import { useMenuNav } from '../components/useMenuNav';
import { go, type RunResult } from '../store/app';
import './screens.css';

const BINS = 23;
const RANGE = 115;

/** Animated number count-up (rAF, eased) */
const useCountUp = (target: number, ms = 1100, delay = 300) => {
  const [v, setV] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) {
      setV(target);
      return;
    }
    let raf = 0;
    const start = performance.now() + delay;
    const tick = () => {
      const t = Math.min(1, Math.max(0, (performance.now() - start) / ms));
      setV(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, delay, reduce]);
  return v;
};

export const ResultsScreen: React.FC<{ result: RunResult }> = ({ result }) => {
  const score = useCountUp(result.score);
  const { request } = result;
  const diff = request.chart.difficulties.find((d) => d.id === request.diffId)!;
  const setSettings = useSettings((s) => s.set);
  const audioOffset = useSettings((s) => s.audioOffsetMs);
  const played = useRef(false);

  useEffect(() => {
    if (played.current) return;
    played.current = true;
    const t = setTimeout(() => audio.playSfx(result.cleared ? 'go' : 'uiBack', 0.8), 1300);
    return () => clearTimeout(t);
  }, [result.cleared]);

  const { bins, mean, std } = useMemo(() => {
    const b = new Array(BINS).fill(0);
    const errs = result.hitErrors;
    let sum = 0;
    for (const e of errs) {
      sum += e;
      const k = Math.round(((Math.max(-RANGE, Math.min(RANGE, e)) + RANGE) / (2 * RANGE)) * (BINS - 1));
      b[k]++;
    }
    const m = errs.length ? sum / errs.length : 0;
    let v = 0;
    for (const e of errs) v += (e - m) * (e - m);
    return { bins: b, mean: m, std: errs.length ? Math.sqrt(v / errs.length) : 0 };
  }, [result.hitErrors]);
  const maxBin = Math.max(1, ...bins);
  const totalJudged = result.counts.reduce((a, b) => a + b, 0) || 1;

  const retry = () => go({ name: 'play', request: { ...request } });
  const back = () => go({ name: 'select', focusSongId: request.songId });
  const navRef = useRef<HTMLElement>(null);
  useMenuNav(navRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
      else if (e.key.toLowerCase() === 'r') retry();
      else if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const suggest = Math.round(mean);
  const canSuggest = result.hitErrors.length >= 30 && Math.abs(suggest) >= 6;

  return (
    <main ref={navRef} className="results screen">
      <section className="results__main">
        <Eyebrow><DecodeText text={`${diff.name} · Lv ${diff.level} · results`} /></Eyebrow>
        <h1 className="results__song">{request.chart.meta.title}</h1>
        <p className="muted">{request.chart.meta.artist}</p>

        <div className="results__grade-row">
          <div className="angle-host results__grade-box">
            <AngleFrame delay={0.4} inset={12} />
            <span className={`results__grade grade--${result.grade}`}><GlitchText text={result.grade} onLoad delay={0.9} /></span>
          </div>
          <div className="results__score-col">
            <span className="results__score mono-num">{score.toString().padStart(7, '0')}</span>
            <span className="results__acc mono-num">{(result.accuracy * 100).toFixed(2)}%</span>
            <div className="results__badges">
              {result.newBest && <span className="tag tag--accent enter" style={{ '--enter-delay': '1.4s' } as React.CSSProperties}>NEW BEST</span>}
              {result.fullCombo && <span className="tag tag--accent enter" style={{ '--enter-delay': '1.5s' } as React.CSSProperties}>FULL COMBO</span>}
              <span className={`tag enter ${result.cleared ? 'tag--success' : 'tag--error'}`} style={{ '--enter-delay': '1.6s' } as React.CSSProperties}>
                {result.cleared ? 'CLEARED' : 'NOT CLEARED'}
              </span>
            </div>
          </div>
        </div>

        <div className="results__actions">
          <Button variant="primary" size="lg" kbd="R" onClick={retry}>Retry</Button>
          <Button size="lg" kbd="Esc" sound="back" onClick={back}>Song select</Button>
          <Button size="lg" onClick={() => go({ name: 'editor', songId: request.songId })}>Open in editor</Button>
        </div>
      </section>

      <section className="results__side">
        <div className="chamfer results__panel enter" style={{ '--enter-delay': '0.2s' } as React.CSSProperties}>
          <SectionLabel>Judgements</SectionLabel>
          <ul className="results__counts">
            {JUDGEMENT_NAMES.map((name, j) => (
              <li key={name} className={`judge judge--${j}`}>
                <span>{name}</span>
                <span className="results__bar"><span style={{ transform: `scaleX(${result.counts[j] / totalJudged})`, animationDelay: `${0.5 + j * 0.1}s` }} /></span>
                <b className="mono-num">{result.counts[j]}</b>
              </li>
            ))}
          </ul>
          <dl className="results__facts">
            <div><dt>Max combo</dt><dd className="mono-num">{result.maxCombo}</dd></div>
            <div><dt>Collected</dt><dd className="mono-num">{result.collected}/{result.collectTotal}</dd></div>
            <div><dt>Roll hits</dt><dd className="mono-num">{result.rollHits}</dd></div>
            <div><dt>Mines hit</dt><dd className="mono-num">{result.minesHit}</dd></div>
          </dl>
        </div>

        <div className="chamfer results__panel enter" style={{ '--enter-delay': '0.35s' } as React.CSSProperties}>
          <SectionLabel>Timing</SectionLabel>
          <div className="histogram" aria-label="Hit error histogram">
            {bins.map((b, i) => (
              <span
                key={i}
                className={Math.abs(i - (BINS - 1) / 2) <= 3.5 ? 'is-perfect' : Math.abs(i - (BINS - 1) / 2) <= 7 ? 'is-great' : ''}
                style={{ transform: `scaleY(${b / maxBin})`, animationDelay: `${0.4 + i * 0.015}s` }}
              />
            ))}
            <i className="histogram__zero" />
          </div>
          <div className="histogram__axis subtle"><span>early</span><span>0</span><span>late</span></div>
          <p className="results__timing">
            <span className="mono-num">{mean >= 0 ? '+' : ''}{mean.toFixed(1)} ms</span> mean ·{' '}
            <span className="mono-num">±{std.toFixed(1)} ms</span> spread
          </p>
          {canSuggest && (
            <div className="results__suggest">
              <span className="muted">You hit {Math.abs(suggest)} ms {suggest > 0 ? 'late' : 'early'} on average.</span>
              <Button
                size="sm"
                onClick={() => {
                  setSettings({ audioOffsetMs: audioOffset + suggest });
                  toast(`Audio offset set to ${audioOffset + suggest} ms`, 'success');
                }}
              >
                Apply {suggest > 0 ? '+' : ''}{suggest} ms offset
              </Button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
};
