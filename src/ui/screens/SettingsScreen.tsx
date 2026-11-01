import React, { useEffect, useRef, useState } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { keyLabel, useSettings, type Keybinds } from '../../storage/settings';
import { Button, Field, Segmented, Slider, Tabs, Toggle } from '../components/controls';
import { Eyebrow, SectionLabel } from '../components/decor';
import { toast } from '../components/overlays';
import { useMenuNav } from '../components/useMenuNav';
import { go, type Screen } from '../store/app';
import './screens.css';

type Tab = 'gameplay' | 'audio' | 'video' | 'controls';
const SLOT_NAMES = ['Up lane · key A', 'Up lane · key B', 'Down lane · key A', 'Down lane · key B'];
const RESERVED = new Set(['Escape', 'Backspace', 'F5', 'Tab']);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="settings__row" data-nav tabIndex={-1}>
    <div>
      <div className="settings__label">{label}</div>
      {hint && <div className="settings__hint subtle">{hint}</div>}
    </div>
    <div className="settings__control">{children}</div>
  </div>
);

export const SettingsScreen: React.FC<{ back: Screen; tab?: string }> = ({ back, tab: initialTab }) => {
  const s = useSettings();
  const [tab, setTab] = useState<Tab>((initialTab as Tab) ?? 'gameplay');
  const [binding, setBinding] = useState<number | null>(null);
  const navRef = useRef<HTMLElement>(null);
  useMenuNav(navRef, { enabled: binding === null });

  useEffect(() => {
    audio.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume);
  }, [s.masterVolume, s.musicVolume, s.sfxVolume]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (binding !== null) {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') {
          setBinding(null);
          return;
        }
        if (RESERVED.has(e.code)) {
          toast(`${e.code} is reserved`, 'error');
          return;
        }
        const keys = [...s.keys] as Keybinds;
        const clash = keys.indexOf(e.code);
        if (clash >= 0 && clash !== binding) keys[clash] = keys[binding];
        keys[binding] = e.code;
        s.set({ keys });
        audio.ui('uiConfirm');
        setBinding(binding < 3 ? binding + 1 : null);
        return;
      }
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) go(back);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <main ref={navRef} className="settings screen">
      <header className="screen__bar">
        <Button sound="back" kbd="Esc" onClick={() => go(back)} data-nav>Back</Button>
        <div className="screen__heading"><Eyebrow>Settings</Eyebrow></div>
        <Button variant="ghost" sound="back" onClick={() => { s.reset(); toast('Settings reset to defaults', 'info'); }} data-nav>Reset all</Button>
      </header>

      <div className="settings__body chamfer">
        <div className="settings__tabs" data-nav tabIndex={-1}>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'gameplay', label: 'Gameplay' },
            { value: 'audio', label: 'Audio & timing' },
            { value: 'video', label: 'Video' },
            { value: 'controls', label: 'Controls' },
          ]}
        />
        </div>
        <div className="settings__panel fade" key={tab}>
          {tab === 'gameplay' && (
            <>
              <Row label="Scroll speed" hint="How fast notes travel. Higher = more space between notes.">
                <Slider value={s.scrollSpeed} min={1} max={12} step={0.5} onChange={(v) => s.set({ scrollSpeed: v })} format={(v) => v.toFixed(1)} />
              </Row>
              <Row label="Swap lanes" hint="Put the down (cyan) lane on top.">
                <Toggle checked={s.laneSwap} onChange={(v) => s.set({ laneSwap: v })} label="Swap lanes" />
              </Row>
              <Row label="Hit error bar" hint="Early/late ticks under the playfield.">
                <Toggle checked={s.showHitError} onChange={(v) => s.set({ showHitError: v })} label="Hit error bar" />
              </Row>
            </>
          )}
          {tab === 'audio' && (
            <>
              <Row label="Master volume"><Slider value={s.masterVolume} min={0} max={1} step={0.01} onChange={(v) => s.set({ masterVolume: v })} format={(v) => `${Math.round(v * 100)}%`} /></Row>
              <Row label="Music volume"><Slider value={s.musicVolume} min={0} max={1} step={0.01} onChange={(v) => s.set({ musicVolume: v })} format={(v) => `${Math.round(v * 100)}%`} /></Row>
              <Row label="Effects volume">
                <Slider value={s.sfxVolume} min={0} max={1} step={0.01} onChange={(v) => { s.set({ sfxVolume: v }); audio.playSfx('don', 0.8); }} format={(v) => `${Math.round(v * 100)}%`} />
              </Row>
              <Row label="Hitsounds" hint="Play a drum sound on every key press."><Toggle checked={s.hitsounds} onChange={(v) => s.set({ hitsounds: v })} label="Hitsounds" /></Row>
              <Row label="Interface sounds"><Toggle checked={s.uiSounds} onChange={(v) => s.set({ uiSounds: v })} label="Interface sounds" /></Row>
              <SectionLabel className="settings__section">Timing</SectionLabel>
              <Row label="Audio offset" hint="Positive if you hear the music late (e.g. Bluetooth). Shifts judgement and visuals.">
                <Slider value={s.audioOffsetMs} min={-300} max={300} step={1} onChange={(v) => s.set({ audioOffsetMs: v })} format={(v) => `${v > 0 ? '+' : ''}${v} ms`} />
              </Row>
              <Row label="Visual offset" hint="Shifts only where notes are drawn (display lag).">
                <Slider value={s.visualOffsetMs} min={-150} max={150} step={1} onChange={(v) => s.set({ visualOffsetMs: v })} format={(v) => `${v > 0 ? '+' : ''}${v} ms`} />
              </Row>
              <Row label="Calibration" hint="Tap along to a click track; we measure your offset.">
                <Button onClick={() => go({ name: 'calibration', back: { name: 'settings', back, tab: 'audio' } })}>Calibrate…</Button>
              </Row>
            </>
          )}
          {tab === 'video' && (
            <>
              <Row label="Theme">
                <Segmented value={s.theme} onChange={(v) => s.set({ theme: v })} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
              </Row>
              <Row label="Effects" hint="Particles and bursts. Low/off helps slow machines.">
                <Segmented value={s.effects} onChange={(v) => s.set({ effects: v })} options={[{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }, { value: 'off', label: 'Off' }]} />
              </Row>
              <Row label="Screen shake"><Toggle checked={s.screenShake} onChange={(v) => s.set({ screenShake: v })} label="Screen shake" /></Row>
              <Row label="Reduced motion" hint="System follows your OS setting.">
                <Segmented value={s.reducedMotion} onChange={(v) => s.set({ reducedMotion: v })} options={[{ value: 'system', label: 'System' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
              </Row>
              <Row label="Performance overlay" hint="FPS, frame time and pool stats in game."><Toggle checked={s.showFps} onChange={(v) => s.set({ showFps: v })} label="Performance overlay" /></Row>
            </>
          )}
          {tab === 'controls' && (
            <>
              <p className="muted settings__intro">Each lane has two keys so you can alternate on streams, and press both for <b>big</b> notes. Click a slot, then press the new key.</p>
              <div className="keybinds">
                {s.keys.map((code, i) => (
                  <Field key={i} label={SLOT_NAMES[i]}>
                    <button
                      type="button"
                      data-nav
                      className={`chamfer chamfer--sm chamfer--interactive keybind ${i < 2 ? 'keybind--up' : 'keybind--down'} ${binding === i ? 'chamfer--active hud is-binding' : ''}`}
                      onClick={() => setBinding(i)}
                    >
                      {binding === i ? 'press a key…' : keyLabel(code)}
                    </button>
                  </Field>
                ))}
              </div>
              <Button size="sm" onClick={() => setBinding(0)} data-nav>Rebind all</Button>
              <SectionLabel className="settings__section">Fixed keys</SectionLabel>
              <ul className="settings__fixed muted">
                <li><kbd className="kbd">Esc</kbd> pause / back</li>
                <li><kbd className="kbd">Backspace</kbd> hold to restart</li>
              </ul>
            </>
          )}
        </div>
      </div>
    </main>
  );
};
