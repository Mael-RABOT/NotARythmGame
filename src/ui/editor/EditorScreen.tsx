import React, { useEffect, useMemo, useRef, useState } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { SNAPS } from '../../core/editor/ops';
import { autosaveDb, type AutosaveRecord } from '../../storage/db';
import { useSettings } from '../../storage/settings';
import { Button, Kbd, Segmented, cx } from '../components/controls';
import { Eyebrow, GlitchText, SectionLabel } from '../components/decor';
import { Modal, toast } from '../components/overlays';
import { go } from '../store/app';
import { useLibrary } from '../store/library';
import {
  EDITOR_RATES,
  buildCommands,
  comboOf,
  prettyKey,
  setRate,
  setTimeline,
  setTool,
  timeline,
  toggleRecord,
  togglePlay,
  type Command,
} from './actions';
import { Inspector, tapTempo } from './Inspector';
import { autosaveNow, exportNarg, isAudioFile, isNargFile, openFile, openSong, restoreAutosave, save, testPlay } from './session';
import { TOOLS, editor, useEditor } from './store';
import { Timeline } from './Timeline';
import './editor.css';

// ============================================================================ helpers
const fmtTime = (ms: number) => {
  const neg = ms < 0;
  const a = Math.abs(ms);
  const m = Math.floor(a / 60000);
  const s = Math.floor((a % 60000) / 1000);
  const r = Math.floor(a % 1000);
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
};

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

const SNAP_LABEL: Record<number, string> = { 1: '1/1', 2: '1/2', 3: '1/3', 4: '1/4', 6: '1/6', 8: '1/8', 12: '1/12', 16: '1/16' };

// ============================================================================ empty state
const StartPanel: React.FC<{ busy: string | null; onFile: (f: File) => void }> = ({ busy, onFile }) => {
  const songs = useLibrary((s) => s.songs);
  const [auto, setAuto] = useState<AutosaveRecord | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    autosaveDb.latest().then((r) => setAuto(r ?? null)).catch(() => undefined);
  }, []);
  return (
    <div className="ed-start">
      <div className="ed-start__hero">
        <Eyebrow>Chart editor</Eyebrow>
        <h1 className="ed-start__title"><GlitchText text="Drop a song." onLoad /></h1>
        <p className="muted ed-start__lead">
          MP3, OGG, WAV, FLAC or M4A. The waveform shows up, the BPM gets detected, and you start placing notes in seconds.
        </p>
      </div>
      <button type="button" className="chamfer chamfer--md chamfer--interactive hud ed-drop" onClick={() => input.current?.click()} data-tour="drop" disabled={!!busy}>
        <span className="ed-drop__icon" aria-hidden>
          <svg viewBox="0 0 48 48"><path d="M24 6v24m0 0-9-9m9 9 9-9M8 34v8h32v-8" /></svg>
        </span>
        <span className="ed-drop__label">{busy ?? 'Drop an audio file here, or click to browse'}</span>
        <span className="muted ed-drop__sub">.narg chart packages open too</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,.narg,.mp3,.ogg,.wav,.flac,.m4a,.opus"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <div className="ed-start__cols">
        {auto && (
          <section className="chamfer chamfer--sm ed-start__card">
            <SectionLabel>Unsaved session</SectionLabel>
            <p><b>{auto.chart.meta.title}</b> <span className="muted">· {new Date(auto.at).toLocaleString()}</span></p>
            <div className="ed-row">
              <Button size="sm" variant="primary" onClick={() => restoreAutosave(auto).catch((e) => toast(String(e), 'error'))}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={() => autosaveDb.remove(auto.id).then(() => setAuto(null))}>Discard</Button>
            </div>
          </section>
        )}
        <section className="chamfer chamfer--sm ed-start__card">
          <SectionLabel>Edit a library song</SectionLabel>
          <ul className="ed-start__songs">
            {songs.map((s) => (
              <li key={s.id}>
                <button type="button" className="ed-start__song" onClick={() => go({ name: 'editor', songId: s.id })}>
                  <span>{s.chart.meta.title}</span>
                  <span className="muted">{s.chart.meta.artist}{s.builtin ? ' · copy' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

// ============================================================================ top bar
const Readout: React.FC = () => {
  const time = useRef<HTMLSpanElement>(null);
  const beat = useRef<HTMLSpanElement>(null);
  const bpm = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const tl = timeline();
      const s = editor();
      if (!tl || !s.timing) return;
      const ms = tl.playheadMs;
      const tick = s.timing.msToTick(ms);
      const txt = `${fmtTime(ms)}|${s.timing.beatLabel(Math.max(0, Math.floor(tick)))}|${+s.timing.bpmAt(Math.max(0, tick)).toFixed(2)}`;
      if (txt === last) return;
      last = txt;
      const [a, b, c] = txt.split('|');
      if (time.current) time.current.textContent = a;
      if (beat.current) beat.current.textContent = b;
      if (bpm.current) bpm.current.textContent = c;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="ed-readout chamfer chamfer--xs" data-tour="transport-readout">
      <span ref={time} className="ed-readout__time mono-num">0:00.000</span>
      <span className="ed-readout__beat mono-num" ref={beat}>1.1</span>
      <span className="muted mono-num"><span ref={bpm}>120</span> bpm</span>
    </div>
  );
};

const TopBar: React.FC<{ onBack: () => void; onPalette: () => void; onShortcuts: () => void }> = ({ onBack, onPalette, onShortcuts }) => {
  const playing = useEditor((s) => s.playing);
  const recording = useEditor((s) => s.recording);
  const snap = useEditor((s) => s.snap);
  const rate = useEditor((s) => s.rate);
  const metronome = useEditor((s) => s.metronome);
  const hitsounds = useEditor((s) => s.hitsounds);
  const follow = useEditor((s) => s.follow);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past.at(-1)?.label);
  const redoLabel = useEditor((s) => s.future.at(-1)?.label);
  const dirty = useEditor((s) => s.dirty);
  const title = useEditor((s) => s.chart?.meta.title ?? '');
  const diffs = useEditor((s) => s.chart?.difficulties);
  const diffIndex = useEditor((s) => s.diffIndex);

  return (
    <header className="ed-bar">
      <div className="ed-bar__group">
        <Button size="sm" variant="ghost" sound="back" onClick={onBack} tip="Back to songs">◀</Button>
        <div className="ed-bar__title">
          <span className="eyebrow">Editing{dirty ? ' · unsaved' : ''}</span>
          <span className="ed-bar__name">{title || 'Untitled'}</span>
        </div>
        {diffs && diffs.length > 1 && (
          <span className="chamfer field-box ed-bar__field"><select className="input ed-bar__diff" value={diffIndex} onChange={(e) => editor().setDiff(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} aria-label="Difficulty">
            {diffs.map((d, i) => <option key={d.id} value={i}>{d.name}</option>)}
          </select></span>
        )}
      </div>

      <div className="ed-bar__group" data-tour="transport">
        <Button size="sm" active={playing} onClick={togglePlay} tip={playing ? 'Pause (Space)' : 'Play from the playhead (Space)'}>{playing ? '❚❚' : '▶'}</Button>
        <Button size="sm" active={recording} className={cx(recording && 'ed-rec')} onClick={toggleRecord} tip="Record (R): play with your lane keys to place notes" data-tour="record">● Rec</Button>
        <Readout />
        <Segmented
          value={rate}
          options={EDITOR_RATES.map((r) => ({ value: r, label: `${Math.round(r * 100)}%`, tip: 'Playback speed, pitch kept (Shift+[ / Shift+])' }))}
          onChange={(v) => void setRate(v)}
        />
      </div>

      <div className="ed-bar__group" data-tour="snap">
        <span className="chamfer field-box ed-bar__field"><select className="input ed-bar__snap" value={snap} onChange={(e) => editor().set({ snap: Number(e.target.value) as typeof snap })} onKeyDown={(e) => e.stopPropagation()} aria-label="Snap">
          {SNAPS.map((v) => <option key={v} value={v}>Snap {SNAP_LABEL[v]}{v % 3 === 0 ? ' ³' : ''}</option>)}
        </select></span>
        <Button size="sm" active={metronome} sound="toggle" onClick={() => editor().set({ metronome: !metronome })} tip="Metronome (N)">Metro</Button>
        <Button size="sm" active={hitsounds} sound="toggle" onClick={() => editor().set({ hitsounds: !hitsounds })} tip="Hitsounds (H)">Hits</Button>
        <Button size="sm" active={follow} sound="toggle" onClick={() => editor().set({ follow: !follow })} tip="Follow the playhead (Shift+F)">Follow</Button>
      </div>

      <div className="ed-bar__group ed-bar__group--end">
        <Button size="icon" variant="ghost" disabled={!canUndo} onClick={() => editor().undo()} tip={canUndo ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}>↶</Button>
        <Button size="icon" variant="ghost" disabled={!canRedo} onClick={() => editor().redo()} tip={canRedo ? `Redo: ${redoLabel} (Ctrl+Y)` : 'Nothing to redo'}>↷</Button>
        <Button size="icon" variant="ghost" onClick={onPalette} tip="Command palette (Ctrl+K)">⌘</Button>
        <Button size="icon" variant="ghost" onClick={onShortcuts} tip="Keyboard shortcuts (?)">?</Button>
        <Button size="sm" onClick={() => testPlay(false)} tip="Test play from the ▶ TEST flag: the playhead's beat (F5). Ctrl+F5: from the selection" data-tour="test">▶ Test</Button>
        <Button size="sm" onClick={() => exportNarg()} tip="Download a .narg to share (Ctrl+E)">Export</Button>
        <Button size="sm" variant="primary" onClick={() => save()} tip="Save to library (Ctrl+S)" data-tour="save">Save</Button>
      </div>
    </header>
  );
};

// ============================================================================ tools
const ToolPalette: React.FC = () => {
  const tool = useEditor((s) => s.tool);
  const stamp = useEditor((s) => s.stamp);
  return (
    <nav className="ed-tools chamfer chamfer--sm" data-tour="tools" aria-label="Tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={cx('ed-tool', tool === t.id && !stamp && 'is-active')}
          onClick={() => setTool(t.id)}
          data-tip={`${t.label} (${t.key}): ${t.hint}`}
          data-tip-pos="right"
          aria-pressed={tool === t.id}
        >
          <span className={cx('ed-tool__glyph', `ed-tool__glyph--${t.id}`)} aria-hidden />
          <span className="ed-tool__key">{t.key}</span>
        </button>
      ))}
      {stamp && (
        <button type="button" className="ed-tool is-active" onClick={() => editor().set({ stamp: null })} data-tip="Stamping a pattern: right-click or Esc to stop" data-tip-pos="right">
          <span className="ed-tool__glyph ed-tool__glyph--stamp" aria-hidden />
          <span className="ed-tool__key">Esc</span>
        </button>
      )}
    </nav>
  );
};

// ============================================================================ status bar
const StatusBar: React.FC = () => {
  const hover = useEditor((s) => s.hover);
  const timing = useEditor((s) => s.timing);
  const selection = useEditor((s) => s.selection.size);
  const zoom = useEditor((s) => s.zoom);
  const recording = useEditor((s) => s.recording);
  const recordQuantize = useEditor((s) => s.recordQuantize);
  const recordOverwrite = useEditor((s) => s.recordOverwrite);
  const notes = useEditor((s) => s.chart?.difficulties[s.diffIndex]?.notes.length ?? 0);
  const savedAt = useEditor((s) => s.savedAt);
  const dirty = useEditor((s) => s.dirty);
  const keys = useSettings((s) => s.keys);
  return (
    <footer className="ed-status">
      {recording ? (
        <span className="ed-status__rec">
          ● RECORD · keys {keys.map((k) => k.replace('Key', '')).join(' ')} · Space to start/stop ·
          <label><input type="checkbox" checked={recordQuantize} onChange={(e) => editor().set({ recordQuantize: e.target.checked })} /> snap to grid</label>
          <label><input type="checkbox" checked={recordOverwrite} onChange={(e) => editor().set({ recordOverwrite: e.target.checked })} /> overwrite the pass</label>
        </span>
      ) : (
        <span className="mono-num">
          {hover && timing ? `${timing.beatLabel(hover.tick)} · ${fmtTime(timing.tickToMs(hover.tick))} · ${hover.lane === 0 ? 'up' : 'down'}` : 'Hover the lanes for a readout'}
        </span>
      )}
      <span className="ed-status__spacer" />
      <span className="mono-num">{notes} notes{selection ? ` · ${selection} selected` : ''}</span>
      <span className="mono-num">zoom {Math.round(zoom * 400)}%</span>
      <span className="muted">{dirty ? 'autosaving locally' : `saved ${new Date(savedAt).toLocaleTimeString()}`}</span>
    </footer>
  );
};

// ============================================================================ command palette
const CommandPalette: React.FC<{ open: boolean; onClose: () => void; commands: Command[] }> = ({ open, onClose, commands }) => {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands.slice(0, 60);
    // rank: word-start matches in the label beat substring matches, which beat group/key matches
    const score = (c: Command) => {
      const label = c.label.toLowerCase();
      const rest = `${c.group} ${c.keys?.join(' ') ?? ''}`.toLowerCase();
      let total = 0;
      for (const w of words) {
        if (label.startsWith(w)) total += 4;
        else if (label.split(/[^a-z0-9]+/).some((part) => part.startsWith(w))) total += 3;
        else if (label.includes(w)) total += 1;
        else if (rest.includes(w)) total += 0.5;
        else return -1;
      }
      return total;
    };
    return commands
      .map((c) => [c, score(c)] as const)
      .filter(([, sc]) => sc >= 0)
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c)
      .slice(0, 60);
  }, [q, commands]);
  useEffect(() => {
    if (open) {
      setQ('');
      setI(0);
    }
  }, [open]);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    requestAnimationFrame(() => c.run());
  };
  return (
    <Modal open={open} onClose={onClose} eyebrow="Command palette" title="What do you want to do?" width={560}>
      <span className="chamfer field-box chamfer--sm">
      <input
        className="input ed-palette__input"
        autoFocus
        value={q}
        placeholder="Type to search: mirror, bpm, record…"
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(list.length - 1, v + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
          if (e.key === 'Enter') run(list[i]);
          if (e.key === 'Escape') onClose();
        }}
      />
      </span>
      <ul className="ed-palette__list" role="listbox">
        {list.map((c, j) => (
          <li key={c.id}>
            <button type="button" className={cx('ed-palette__item', j === i && 'is-active')} onMouseEnter={() => setI(j)} onClick={() => run(c)} role="option" aria-selected={j === i}>
              <span className="ed-palette__group">{c.group}</span>
              <span className="ed-palette__label">{c.label}</span>
              {c.keys?.[0] && <Kbd>{prettyKey(c.keys[0])}</Kbd>}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="muted">No matching command.</li>}
      </ul>
    </Modal>
  );
};

const ShortcutsModal: React.FC<{ open: boolean; onClose: () => void; commands: Command[] }> = ({ open, onClose, commands }) => {
  const groups = useMemo(() => {
    const m = new Map<string, Command[]>();
    for (const c of commands) if (c.keys?.length) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m];
  }, [commands]);
  return (
    <Modal open={open} onClose={onClose} eyebrow="Reference" title="Keyboard shortcuts" width={880}>
      <div className="ed-keys">
        {groups.map(([g, cs]) => (
          <section key={g}>
            <SectionLabel>{g}</SectionLabel>
            <ul>
              {cs.map((c) => (
                <li key={c.id}>
                  <span>{c.label}</span>
                  <span className="ed-keys__k">{c.keys!.map((k) => <Kbd key={k}>{prettyKey(k)}</Kbd>)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section>
          <SectionLabel>Mouse</SectionLabel>
          <ul>
            <li><span>Scroll / zoom / change snap</span><span className="ed-keys__k"><Kbd>Wheel</Kbd><Kbd>Ctrl</Kbd><Kbd>Alt</Kbd></span></li>
            <li><span>Step the playhead by one snap</span><span className="ed-keys__k"><Kbd>Shift+Wheel</Kbd></span></li>
            <li><span>Pan</span><span className="ed-keys__k"><Kbd>Middle drag</Kbd></span></li>
            <li><span>Erase (any tool)</span><span className="ed-keys__k"><Kbd>Right click</Kbd></span></li>
            <li><span>Add to selection</span><span className="ed-keys__k"><Kbd>Shift</Kbd><Kbd>Ctrl</Kbd></span></li>
            <li><span>Place / move without snapping</span><span className="ed-keys__k"><Kbd>Alt</Kbd></span></li>
            <li><span>Seek (snapped with Shift)</span><span className="ed-keys__k"><Kbd>Click ruler</Kbd></span></li>
          </ul>
        </section>
      </div>
    </Modal>
  );
};

// ============================================================================ onboarding tour
const TOUR: { target: string; title: string; text: string }[] = [
  { target: 'timeline', title: 'The timeline', text: 'Two lanes, the same as in game: up on top, down below. Time flows left to right over the waveform. Click a lane to place a note.' },
  { target: 'tools', title: 'Note tools', text: 'Keys 1–9. Tap, Big (both keys), Hold, Mash, Roll, Mine and Collect. Drag to set the length of holds, mashes and rolls. Right-click always erases.' },
  { target: 'snap', title: 'Snap & listening', text: 'Notes snap to the beat grid (1/4 by default, triplets included). Turn on the metronome and hitsounds to check your timing by ear.' },
  { target: 'inspector', title: 'Timing first', text: 'Set the BPM and offset in the Timing tab, or let Detect do it. Once the grid lines sit on the beats, charting is fast and precise.' },
  { target: 'record', title: 'Record mode', text: 'The fastest way to chart. Press R, then Space, and play along with your normal game keys. Notes land on the grid.' },
  { target: 'test', title: 'Test play', text: 'F5 jumps into the real game from the playhead. Esc brings you right back here, nothing lost.' },
  { target: 'save', title: 'Save & share', text: 'Ctrl+S puts the chart in your library. Export makes a .narg file anyone can drop into the game. Everything also autosaves locally.' },
];

const Tour: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const s = TOUR[step];
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const update = () => setRect(document.querySelector(`[data-tour="${s.target}"]`)?.getBoundingClientRect() ?? null);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, s.target]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setStep((v) => Math.max(0, v - 1));
      else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        if (step === TOUR.length - 1) onClose();
        else setStep((v) => v + 1);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, step, onClose]);
  if (!open) return null;
  const pad = 8;
  const r = rect ?? new DOMRect(window.innerWidth / 2 - 100, window.innerHeight / 2 - 50, 200, 100);
  const cardW = 340;
  const below = r.bottom + 180 < window.innerHeight;
  const left = Math.max(16, Math.min(window.innerWidth - cardW - 16, r.left + r.width / 2 - cardW / 2));
  const top = below ? r.bottom + pad + 12 : Math.max(16, r.top - pad - 12 - 170);
  const fitsRight = r.right + cardW + 32 < window.innerWidth;
  const sideways = r.height > window.innerHeight * 0.45;
  const cardStyle: React.CSSProperties = sideways
    ? { left: fitsRight ? r.right + 20 : Math.max(16, r.left - cardW - 20), top: Math.max(16, r.top + 40), width: cardW }
    : { left, top, width: cardW };
  return (
    <div className="ed-tour" role="dialog" aria-modal="true" aria-label="Editor tour">
      <div className="ed-tour__spot hud" style={{ left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }} />
      <div className="chamfer chamfer--md chamfer--raised ed-tour__card" style={cardStyle}>
        <span className="eyebrow">Tour · {step + 1}/{TOUR.length}</span>
        <h3 className="ed-tour__title">{s.title}</h3>
        <p className="muted">{s.text}</p>
        <div className="ed-row ed-tour__actions">
          <Button size="sm" variant="ghost" sound="back" onClick={onClose}>Skip</Button>
          <span className="ed-status__spacer" />
          {step > 0 && <Button size="sm" onClick={() => setStep(step - 1)}>Back</Button>}
          <Button size="sm" variant="primary" onClick={() => (step === TOUR.length - 1 ? onClose() : setStep(step + 1))}>
            {step === TOUR.length - 1 ? 'Start charting' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================ timeline host
const TimelineView: React.FC = () => {
  const host = useRef<HTMLDivElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const theme = useSettings((s) => s.theme);
  const tlRef = useRef<Timeline | null>(null);
  useEffect(() => {
    const t = new Timeline(host.current!, mini.current!);
    tlRef.current = t;
    setTimeline(t);
    t.init().catch((e) => console.error(e));
    return () => {
      t.pause();
      t.destroy();
      setTimeline(null);
      tlRef.current = null;
    };
  }, []);
  useEffect(() => {
    // wait one frame for the theme variables to switch
    const id = requestAnimationFrame(() => tlRef.current?.refreshTheme());
    return () => cancelAnimationFrame(id);
  }, [theme]);

  const onMini = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = editor();
    const r = e.currentTarget.getBoundingClientRect();
    const seek = (clientX: number) => {
      const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      const ms = f * (s.buffer?.duration ?? 0) * 1000;
      const tl = timeline();
      if (!tl) return;
      tl.seek(ms);
      editor().set({ viewMs: ms - tl.w * 0.3 / editor().zoom });
    };
    seek(e.clientX);
    const move = (ev: PointerEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="ed-center">
      <div className="chamfer chamfer--md ed-timeline" data-tour="timeline">
        <div className="ed-timeline__host" ref={host} />
        <span className="ed-timeline__lane ed-timeline__lane--up">UP</span>
        <span className="ed-timeline__lane ed-timeline__lane--down">DOWN</span>
      </div>
      <canvas ref={mini} className="chamfer chamfer--xs ed-minimap" onPointerDown={onMini} aria-label="Song overview: click to seek" />
    </div>
  );
};

// ============================================================================ screen
const EditorScreen: React.FC<{ songId?: string; newFile?: File; resume?: boolean }> = ({ songId, newFile, resume }) => {
  const hasChart = useEditor((s) => !!s.chart && !!s.buffer);
  const pendingRestore = useEditor((s) => s.pendingRestore);
  const seenTour = useSettings((s) => s.seenEditorTour);
  const [busy, setBusy] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [tour, setTour] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);

  // ---------------------------------------------------------------- loading
  const handleFile = async (f: File) => {
    if (!isAudioFile(f) && !isNargFile(f)) {
      toast('That file is not audio or a .narg chart', 'error');
      return;
    }
    setBusy(`Loading ${f.name}…`);
    try {
      await audio.unlock();
      await openFile(f);
    } catch (e) {
      console.error(e);
      toast(`Could not open ${f.name}: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const s = editor();
    if (resume && s.chart && (!songId || s.chart.id === songId)) return;
    if (newFile) {
      void handleFile(newFile);
    } else if (songId) {
      setBusy('Opening song…');
      openSong(songId)
        .catch((e) => {
          toast(`Could not open the song: ${(e as Error).message}`, 'error');
          editor().set({ chart: null, buffer: null });
        })
        .finally(() => setBusy(null));
    } else {
      editor().set({ chart: null, buffer: null, peaks: null, timing: null });
    }
     
  }, [songId, newFile, resume]);

  // first visit: tour
  useEffect(() => {
    if (hasChart && !seenTour) {
      const id = setTimeout(() => setTour(true), 600);
      return () => clearTimeout(id);
    }
  }, [hasChart, seenTour]);

  // autosave + leave guard
  useEffect(() => {
    const id = setInterval(() => void autosaveNow(), 4000);
    const onUnload = (e: BeforeUnloadEvent) => {
      if (editor().dirty) {
        void autosaveNow();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      clearInterval(id);
      window.removeEventListener('beforeunload', onUnload);
      void autosaveNow();
    };
  }, []);

  const leave = () => {
    timeline()?.pause();
    if (editor().dirty) setLeaving(true);
    else go({ name: 'select' });
  };

  // ---------------------------------------------------------------- commands & keys
  const commands = useMemo(
    () =>
      buildCommands({
        save: () => void save(),
        exportNarg: () => void exportNarg(),
        testPlay: (auto, fromSel) => testPlay(auto, fromSel),
        palette: () => setPalette(true),
        shortcuts: () => setShortcuts(true),
        tour: () => setTour(true),
        back: leave,
        tapTempo,
      }),
     
    [],
  );

  useEffect(() => {
    if (!hasChart) return;
    const map = new Map<string, Command>();
    for (const c of commands) for (const k of c.keys ?? []) map.set(k, c);
    const onDown = (e: KeyboardEvent) => {
      if (isTyping(e) || document.querySelector('.overlay')) return;
      const s = editor();
      // record pass: gameplay keys place notes
      const keyIndex = useSettings.getState().keys.indexOf(e.code);
      if (keyIndex >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey && s.recording && s.playing) {
        e.preventDefault();
        if (!e.repeat) timeline()?.recordKey(keyIndex, true, e.timeStamp);
        return;
      }
      for (const k of comboOf(e)) {
        const c = map.get(k);
        if (!c) continue;
        if (e.repeat && !c.repeat) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        c.run();
        return;
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const keyIndex = useSettings.getState().keys.indexOf(e.code);
      if (keyIndex >= 0) timeline()?.recordKey(keyIndex, false, e.timeStamp);
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [hasChart, commands]);

  // ---------------------------------------------------------------- drag & drop
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (editor().chart && editor().dirty) setReplaceFile(f);
    else void handleFile(f);
  };

  return (
    <div
      className="editor"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {hasChart ? (
        <>
          <TopBar onBack={leave} onPalette={() => setPalette(true)} onShortcuts={() => setShortcuts(true)} />
          {pendingRestore && (
            <div className="chamfer chamfer--sm ed-banner">
              <span>Unsaved changes from {new Date(pendingRestore.at).toLocaleString()} were found for this song.</span>
              <Button size="sm" variant="primary" onClick={() => restoreAutosave(pendingRestore)}>Restore them</Button>
              <Button size="sm" variant="ghost" onClick={() => { void autosaveDb.remove(pendingRestore.id); editor().set({ pendingRestore: null }); }}>Discard</Button>
            </div>
          )}
          <div className="ed-main">
            <ToolPalette />
            <TimelineView />
            <Inspector />
          </div>
          <StatusBar />
        </>
      ) : (
        <>
          <header className="ed-bar">
            <div className="ed-bar__group">
              <Button size="sm" variant="ghost" sound="back" onClick={() => go({ name: 'select' })}>◀ Songs</Button>
            </div>
          </header>
          <StartPanel busy={busy} onFile={(f) => void handleFile(f)} />
        </>
      )}

      {busy && hasChart && <div className="ed-busy chamfer chamfer--sm">{busy}</div>}
      {dragging && (
        <div className="dropzone">
          <div className="dropzone__inner">
            <span className="eyebrow">Drop to open</span>
            <h2>Audio → new chart · .narg → open</h2>
          </div>
        </div>
      )}

      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      <ShortcutsModal open={shortcuts} onClose={() => setShortcuts(false)} commands={commands} />
      <Tour
        open={tour}
        onClose={() => {
          setTour(false);
          useSettings.getState().set({ seenEditorTour: true });
        }}
      />
      <Modal
        open={leaving}
        onClose={() => setLeaving(false)}
        eyebrow="Unsaved changes"
        title="Save before leaving?"
        actions={
          <>
            <Button variant="ghost" sound="back" onClick={() => setLeaving(false)}>Stay</Button>
            <Button variant="danger" onClick={() => { setLeaving(false); void autosaveNow().then(() => { editor().set({ dirty: false }); go({ name: 'select' }); }); }}>Leave without saving</Button>
            <Button variant="primary" onClick={async () => { if (await save()) { setLeaving(false); go({ name: 'select', focusSongId: editor().chart?.id }); } }}>Save & leave</Button>
          </>
        }
      >
        <p className="muted">Your work is autosaved locally, so you can still restore it from the editor later.</p>
      </Modal>
      <Modal
        open={!!replaceFile}
        onClose={() => setReplaceFile(null)}
        eyebrow="Open file"
        title={`Open ${replaceFile?.name ?? ''}?`}
        actions={
          <>
            <Button variant="ghost" sound="back" onClick={() => setReplaceFile(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { const f = replaceFile!; setReplaceFile(null); void autosaveNow().then(() => handleFile(f)); }}>Open it</Button>
          </>
        }
      >
        <p className="muted">The current chart has unsaved changes. They stay in the local autosave.</p>
      </Modal>
    </div>
  );
};

export default EditorScreen;
