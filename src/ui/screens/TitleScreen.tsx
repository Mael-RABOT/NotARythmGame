import React, { useEffect, useRef, useState } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { keyLabel, useSettings } from '../../storage/settings';
import { Button, Kbd } from '../components/controls';
import { AngleFrame, DecodeText, Eyebrow, GlitchText, SectionLabel } from '../components/decor';
import { useMenuNav } from '../components/useMenuNav';
import { go } from '../store/app';
import './screens.css';

let unlockedOnce = false;

export const TitleScreen: React.FC = () => {
  const [unlocked, setUnlocked] = useState(unlockedOnce);
  const keys = useSettings((s) => s.keys);
  const menuRef = useRef<HTMLElement>(null);
  useMenuNav(menuRef, { enabled: unlocked });

  useEffect(() => {
    if (unlocked) return;
    const unlock = async () => {
      await audio.unlock();
      unlockedOnce = true;
      setUnlocked(true);
      audio.ui('uiConfirm');
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.key === 'Tab') return;
      e.preventDefault();
      void unlock();
    };
    const onPointer = () => void unlock();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [unlocked]);

  useEffect(() => {
    if (!unlocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (keys.includes(e.code)) return; // lane keys navigate the menu
      if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) go({ name: 'select' });
      else if (e.key.toLowerCase() === 'e') go({ name: 'editor' });
      else if (e.key.toLowerCase() === 's') go({ name: 'settings', back: { name: 'title' } });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [unlocked, keys]);

  return (
    <main className="title screen">
      <section className="title__hero">
        <Eyebrow><DecodeText text="v0.1 · two lanes · zero excuses" /></Eyebrow>
        <h1 className="title__logo" aria-label="Not A Rythm Game">
          <span className="title__line enter" style={{ '--enter-delay': '0.05s' } as React.CSSProperties}><GlitchText text="NOT A" onLoad delay={0.5} /></span>
          <span className="title__line title__line--accent enter" style={{ '--enter-delay': '0.15s' } as React.CSSProperties}><GlitchText text="RYTHM" onLoad loop delay={0.7} /></span>
          <span className="title__line enter" style={{ '--enter-delay': '0.25s' } as React.CSSProperties}><GlitchText text="GAME." onLoad delay={0.9} /></span>
        </h1>
        <p className="title__tagline muted enter" style={{ '--enter-delay': '0.35s' } as React.CSSProperties}>
          A two-lane rhythm game, and a <span className="mark">chart editor anyone can use</span>.
          Drop a song, tap along, play it.
        </p>

        {unlocked ? (
          <nav ref={menuRef} className="title__menu" aria-label="Main menu">
            <Button variant="primary" size="lg" kbd="Enter" className="enter-left" style={{ '--enter-delay': '0s' } as React.CSSProperties} onClick={() => go({ name: 'select' })} autoFocus>
              Play
            </Button>
            <Button size="lg" kbd="E" className="enter-left" style={{ '--enter-delay': '0.06s' } as React.CSSProperties} onClick={() => go({ name: 'editor' })}>
              Chart editor
            </Button>
            <Button size="lg" kbd="S" className="enter-left" style={{ '--enter-delay': '0.12s' } as React.CSSProperties} onClick={() => go({ name: 'settings', back: { name: 'title' } })}>
              Settings
            </Button>
          </nav>
        ) : (
          <p className="title__press">
            <span className="title__blink">▍</span> PRESS ANY KEY
          </p>
        )}
      </section>

      <aside className="title__howto enter" style={{ '--enter-delay': '0.45s' } as React.CSSProperties}>
        <div className="angle-host chamfer title__card">
          <AngleFrame delay={0.6} inset={18} />
          <SectionLabel>How to play</SectionLabel>
          <div className="title__keys">
            <div>
              <Kbd>{keyLabel(keys[0])}</Kbd> <Kbd>{keyLabel(keys[1])}</Kbd>
              <span className="lane-chip lane-chip--up">UP lane</span>
            </div>
            <div>
              <Kbd>{keyLabel(keys[2])}</Kbd> <Kbd>{keyLabel(keys[3])}</Kbd>
              <span className="lane-chip lane-chip--down">DOWN lane</span>
            </div>
          </div>
          <ul className="legend">
            <li><i className="glyph glyph--tap" /> <b>Tap</b> hit the lane as it crosses the line</li>
            <li><i className="glyph glyph--big" /> <b>Big</b> both keys of that lane at once</li>
            <li><i className="glyph glyph--hold" /> <b>Hold</b> keep it pressed until the tail</li>
            <li><i className="glyph glyph--mash" /> <b>Mash</b> hit any key, fast, before it ends</li>
            <li><i className="glyph glyph--roll" /> <b>Roll</b> free bonus hits, any key</li>
            <li><i className="glyph glyph--mine" /> <b>Mine</b> do not touch that lane</li>
            <li><i className="glyph glyph--collect" /> <b>Collect</b> hold the lane as it passes</li>
          </ul>
          <p className="subtle title__hint">Esc pauses · hold Backspace to restart</p>
        </div>
      </aside>

      <footer className="title__footer subtle">
        <span>Drop a <b>.narg</b> chart anywhere to import it · drop audio to start charting</span>
        <span>Not A Rythm Game · {new Date().getFullYear()}</span>
      </footer>
    </main>
  );
};
