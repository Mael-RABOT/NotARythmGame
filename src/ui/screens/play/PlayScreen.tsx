import React, { useEffect, useRef, useState } from 'react';
import { keyLabel, useSettings } from '../../../storage/settings';
import { Button, Kbd } from '../../components/controls';
import { DecodeText, Eyebrow, GlitchText, SectionLabel } from '../../components/decor';
import { useMenuNav } from '../../components/useMenuNav';
import { go, type PlayRequest } from '../../store/app';
import { PlayController, type HudRefs } from './PlayController';
import './play.css';


export const PlayScreen: React.FC<{ request: PlayRequest }> = ({ request }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const refs = {
    score: useRef<HTMLSpanElement>(null),
    combo: useRef<HTMLSpanElement>(null),
    comboWrap: useRef<HTMLDivElement>(null),
    accuracy: useRef<HTMLSpanElement>(null),
    gauge: useRef<HTMLDivElement>(null),
    progress: useRef<HTMLDivElement>(null),
    debug: useRef<HTMLDivElement>(null),
    intro: useRef<HTMLDivElement>(null),
  };
  const ctrl = useRef<PlayController | null>(null);
  const [paused, setPaused] = useState(false);
  const pauseRef = useRef<HTMLDivElement>(null);
  useMenuNav(pauseRef, { enabled: paused });
  const [countdown, setCountdown] = useState<number | null>(null);
  const keys = useSettings((s) => s.keys);
  const diff = request.chart.difficulties.find((d) => d.id === request.diffId) ?? request.chart.difficulties[0];
  const opts = request.options;

  const exit = () => {
    if (opts.fromEditor) go({ name: 'editor', songId: request.songId, resume: true });
    else go({ name: 'select', focusSongId: request.songId });
  };

  useEffect(() => {
    const host = hostRef.current!;
    const hud = Object.fromEntries(Object.entries(refs).map(([k, r]) => [k, r.current])) as unknown as HudRefs;
    const c = new PlayController(host, request, hud, {
      onPauseChange: setPaused,
      onCountdown: setCountdown,
      onFinish: (result) => {
        if (request.options.fromEditor) go({ name: 'editor', songId: request.songId, resume: true });
        else go({ name: 'results', result });
      },
      onExit: exit,
    });
    ctrl.current = c;
    c.init().catch((e) => {
      console.error(e);
      exit();
    });
    return () => {
      c.destroy();
      ctrl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const mode = opts.autoplay ? 'AUTOPLAY' : opts.fromEditor ? 'TEST PLAY' : opts.startMs !== undefined || opts.loopEndMs !== undefined || (opts.rate ?? 1) !== 1 ? 'PRACTICE' : null;

  return (
    <div className="play">
      <div ref={hostRef} className="play__canvas" />

      <header className="play__top">
        <div className="play__song">
          <SectionLabel>{diff.name} · Lv {diff.level}</SectionLabel>
          <div className="play__title">{request.chart.meta.title}</div>
          <div className="muted play__artist">{request.chart.meta.artist}</div>
        </div>
        <div className="play__stats">
          <span ref={refs.score} className="play__score mono-num">0000000</span>
          <span ref={refs.accuracy} className="play__acc mono-num">100.00%</span>
        </div>
      </header>

      <div className="play__progress"><div ref={refs.progress} className="play__progress-fill" /></div>

      <div className="play__gauge chamfer chamfer--xs" aria-label="Clear gauge">
        <div ref={refs.gauge} className="play__gauge-fill" />
        <span className="play__gauge-mark" />
        <span className="play__gauge-label">CLEAR</span>
      </div>

      <div ref={refs.comboWrap} className="play__combo" style={{ opacity: 0 }}>
        <span ref={refs.combo} className="play__combo-num mono-num">0</span>
        <span className="play__combo-label">COMBO</span>
      </div>

      {mode && <div className="play__mode chamfer chamfer--xs hud">{mode}{opts.rate && opts.rate !== 1 ? ` · ${opts.rate}×` : ''}</div>}

      <div ref={refs.intro} className="play__intro">
        <Eyebrow><DecodeText text={`${diff.name.toUpperCase()} · LV ${diff.level}`} /></Eyebrow>
        <h1><GlitchText text={request.chart.meta.title} onLoad delay={0.1} /></h1>
        <p className="muted">{request.chart.meta.artist} · chart by {request.chart.meta.charter}</p>
        <p className="play__keys">
          <span><Kbd>{keyLabel(keys[0])}</Kbd><Kbd>{keyLabel(keys[1])}</Kbd> <span className="accent">UP</span></span>
          <span><Kbd>{keyLabel(keys[2])}</Kbd><Kbd>{keyLabel(keys[3])}</Kbd> <span style={{ color: 'var(--color-lane-down)' }}>DOWN</span></span>
        </p>
      </div>

      <div ref={refs.debug} className="play__debug mono-num" style={{ display: 'none' }} />

      {countdown !== null && (
        <div className="play__countdown" key={countdown}>
          <span>{countdown}</span>
        </div>
      )}

      {paused && (
        <div className="overlay play__pause">
          <div className="chamfer modal" role="dialog" aria-label="Paused">
            <Eyebrow>Paused</Eyebrow>
            <h2 className="modal__title"><GlitchText text="Take a breath." onLoad /></h2>
            <div className="play__pause-actions" ref={pauseRef}>
              <Button variant="primary" size="lg" kbd="Esc" onClick={() => ctrl.current?.resume()} autoFocus>Resume</Button>
              <Button size="lg" kbd="⌫ hold" onClick={() => ctrl.current?.restart()}>Restart</Button>
              <Button size="lg" sound="back" onClick={exit}>{opts.fromEditor ? 'Back to editor' : 'Quit'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
