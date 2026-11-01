import React, { useEffect, useRef, useState } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { useSettings } from '../../storage/settings';
import { Button } from '../components/controls';
import { Eyebrow, GlitchText, SectionLabel, pulseGrid } from '../components/decor';
import { toast } from '../components/overlays';
import { go, type Screen } from '../store/app';
import './screens.css';

const BPM = 100;
const BEAT_S = 60 / BPM;
const NEEDED = 16;

/**
 * Tap-along calibration: a click track is scheduled on the audio clock; each
 * press is mapped to audio time with its event timestamp, and compared to the
 * nearest click. The median offset becomes the suggested audio offset.
 */
export const CalibrationScreen: React.FC<{ back: Screen }> = ({ back }) => {
  const [running, setRunning] = useState(false);
  const [offsets, setOffsets] = useState<number[]>([]);
  const [beatFlash, setBeatFlash] = useState(0);
  const startRef = useRef(0); // ctx time of beat 0
  const setSettings = useSettings((s) => s.set);
  const current = useSettings((s) => s.audioOffsetMs);

  // schedule clicks ahead on the audio clock
  useEffect(() => {
    if (!running) return;
    void audio.unlock();
    const ctx = audio.context;
    startRef.current = ctx.currentTime + 0.5;
    let scheduled = 0;
    let raf = 0;
    let lastBeat = -1;
    const pump = () => {
      raf = requestAnimationFrame(pump);
      while (startRef.current + scheduled * BEAT_S < ctx.currentTime + 0.3) {
        audio.playSfx(scheduled % 4 === 0 ? 'metroHi' : 'metroLo', 1, startRef.current + scheduled * BEAT_S);
        scheduled++;
      }
      audio.tick();
      const heard = audio.ctxTimeAt(performance.now());
      const beat = Math.floor((heard - startRef.current) / BEAT_S);
      if (beat >= 0 && beat !== lastBeat) {
        lastBeat = beat;
        setBeatFlash(beat);
        pulseGrid(beat % 4 === 0 ? 1 : 0.5);
      }
    };
    pump();
    return () => cancelAnimationFrame(raf);
  }, [running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        go(back);
        return;
      }
      if (e.repeat || !running || e.target instanceof HTMLButtonElement) return;
      if (e.code === 'Space' || e.code.startsWith('Key')) {
        e.preventDefault();
        audio.tick();
        const heard = audio.ctxTimeAt(e.timeStamp);
        const rel = (heard - startRef.current) / BEAT_S;
        const nearest = Math.round(rel);
        if (nearest < 1) return;
        // absolute lag between the heard click and the press: this *is* the audio offset to use
        const ms = (rel - nearest) * BEAT_S * 1000;
        setOffsets((o) => [...o.slice(-31), ms]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, back]);

  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const spread = sorted.length > 3 ? sorted[Math.floor(sorted.length * 0.85)] - sorted[Math.floor(sorted.length * 0.15)] : 0;
  const ready = offsets.length >= NEEDED;
  const suggested = Math.round(median);

  return (
    <main className="calibration screen">
      <header className="screen__bar">
        <Button sound="back" kbd="Esc" onClick={() => go(back)}>Back</Button>
        <div className="screen__heading"><Eyebrow>Calibration</Eyebrow></div>
      </header>
      <section className="calibration__body chamfer hud">
        <h1><GlitchText text="Tap with the click." onLoad /></h1>
        <p className="muted">Press <kbd className="kbd">Space</kbd> (or any letter) on every click. Listen, don't watch: the visual pulse follows your current offset.</p>

        <div className="calibration__beats" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`calibration__beat ${running && beatFlash % 4 === i ? 'is-on' : ''} ${i === 0 ? 'is-downbeat' : ''}`} />
          ))}
        </div>

        <div className="calibration__meter">
          <div className="calibration__scale"><span>-100 ms</span><span>0</span><span>+100 ms</span></div>
          <div className="calibration__track">
            {offsets.slice(-20).map((o, i, arr) => (
              <i key={offsets.length - arr.length + i} style={{ left: `${50 + Math.max(-50, Math.min(50, o / 2))}%`, opacity: 0.25 + (i / arr.length) * 0.75 }} />
            ))}
            {offsets.length > 0 && <b style={{ left: `${50 + Math.max(-50, Math.min(50, median / 2))}%` }} />}
          </div>
        </div>

        <dl className="calibration__stats">
          <div><dt>Taps</dt><dd className="mono-num">{Math.min(offsets.length, NEEDED)}/{NEEDED}</dd></div>
          <div><dt>Median</dt><dd className="mono-num">{offsets.length ? `${median > 0 ? '+' : ''}${median.toFixed(0)} ms` : '–'}</dd></div>
          <div><dt>Consistency</dt><dd className="mono-num">{spread ? `±${(spread / 2).toFixed(0)} ms` : '–'}</dd></div>
          <div><dt>Current offset</dt><dd className="mono-num">{current > 0 ? '+' : ''}{current} ms</dd></div>
        </dl>

        <div className="calibration__actions">
          {!running ? (
            <Button variant="primary" size="lg" onClick={() => { setOffsets([]); setRunning(true); }} autoFocus>Start click track</Button>
          ) : (
            <Button size="lg" sound="back" onClick={() => setRunning(false)}>Stop</Button>
          )}
          <Button
            variant={ready ? 'primary' : 'default'}
            size="lg"
            disabled={!ready}
            onClick={() => {
              setSettings({ audioOffsetMs: suggested });
              toast(`Audio offset set to ${suggested > 0 ? '+' : ''}${suggested} ms`, 'success');
              setRunning(false);
            }}
          >
            {ready ? `Apply ${suggested > 0 ? '+' : ''}${suggested} ms` : `Need ${NEEDED - offsets.length} more taps`}
          </Button>
        </div>
        <SectionLabel>Tip</SectionLabel>
        <p className="subtle">Wired headphones or speakers give the most stable result. Wireless audio often needs +100 to +250 ms.</p>
      </section>
    </main>
  );
};
