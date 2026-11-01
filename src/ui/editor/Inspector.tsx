import React, { useMemo, useState } from 'react';
import { analyzeDifficulty, lintDifficulty, type LintIssue } from '../../core/chart/analysis';
import { PPQ, SPAN_TYPES, newId, type BpmPoint, type Chart, type Difficulty, type Note, type NoteType, type SignaturePoint, type SpeedPoint } from '../../core/chart/types';
import { applyTiming, setNoteProps, withDifficulty } from '../../core/editor/ops';
import { Button, Field, NumberField, Segmented, Tabs, TextField, Toggle, cx } from '../components/controls';
import { SectionLabel } from '../components/decor';
import { toast } from '../components/overlays';
import {
  addBpmPoint,
  addEvent,
  addSignaturePoint,
  addSpeedPoint,
  measureStartAt,
  convertSel,
  deleteSelection,
  duplicateSelection,
  jumpMarker,
  mirror,
  playheadTick,
  quantizeSel,
  removeEvent,
  reverse,
  seekTick,
  selectWhere,
  selectionAsPattern,
  stampPattern,
  stretch,
  updateEvent,
} from './actions';
import { STARTER_PATTERNS, patternSpan, usePatterns, type Pattern } from './patterns';
import { applyTempo, detectTempo } from './session';
import { TOOLS, currentDiff, editor, useEditor, type InspectorTab } from './store';

const TYPE_LABEL: Record<NoteType, string> = { tap: 'Tap', big: 'Big', hold: 'Hold', mash: 'Mash', roll: 'Roll', mine: 'Mine', collect: 'Collect' };

const Row: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => <div className={cx('insp__row', className)}>{children}</div>;

// ============================================================================ Note
const NotePanel: React.FC = () => {
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const timing = useEditor((s) => s.timing);
  const chart = useEditor((s) => s.chart);
  const diffIndex = useEditor((s) => s.diffIndex);
  const sel = [...selection];
  const toolInfo = TOOLS.find((t) => t.id === tool)!;

  if (!sel.length) {
    return (
      <div className="insp__section">
        <SectionLabel>Tool · {toolInfo.label}</SectionLabel>
        <p className="muted insp__hint">{toolInfo.hint}</p>
        <SectionLabel>Quick start</SectionLabel>
        <ol className="insp__steps">
          <li>Set the BPM and offset in <b>Timing</b> (or use Detect).</li>
          <li>Pick a note tool (<kbd className="kbd">2</kbd>–<kbd className="kbd">8</kbd>) and click the lanes.</li>
          <li>Or press <kbd className="kbd">R</kbd> then <kbd className="kbd">Space</kbd> to record with your play keys.</li>
          <li>Hit <kbd className="kbd">F5</kbd> to test play, then <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">S</kbd> to save.</li>
        </ol>
        <SectionLabel>Mouse</SectionLabel>
        <ul className="insp__list muted">
          <li>Wheel: scroll · Ctrl+wheel: zoom · Alt+wheel: snap</li>
          <li>Shift+wheel: step the playhead · Middle-drag: pan</li>
          <li>Right-click: erase · Alt while placing: no snap</li>
          <li>Drag a span&apos;s tail to resize it</li>
        </ul>
      </div>
    );
  }

  const counts = new Map<NoteType, number>();
  for (const n of sel) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const spans = sel.filter((n) => SPAN_TYPES.has(n.type));
  const mashes = sel.filter((n) => n.type === 'mash');
  const first = sel.reduce((a, b) => (b.t < a.t ? b : a));
  const setProps = (label: string, props: Partial<Pick<Note, 'dur' | 'hits' | 'lane'>>) => {
    const diff = currentDiff();
    if (!chart || !diff) return;
    const { notes, remap } = setNoteProps(diff.notes, selection, props);
    editor().commit(label, withDifficulty(chart, diffIndex, { notes }), { remap });
  };

  return (
    <div className="insp__section">
      <SectionLabel>Selection · {sel.length} note{sel.length > 1 ? 's' : ''}</SectionLabel>
      <div className="insp__chips">
        {[...counts].map(([t, c]) => (
          <button key={t} type="button" className="chamfer chamfer--xs insp__chip" data-tip={`Keep only ${t}`} onClick={() => selectWhere((n) => n.type === t)}>
            <span className={`glyph glyph--${t}`} style={{ '--c': 'var(--color-accent)' } as React.CSSProperties} /> {TYPE_LABEL[t]} ×{c}
          </button>
        ))}
      </div>
      {timing && (
        <p className="muted insp__hint">
          {sel.length === 1 ? 'At' : 'From'} {timing.beatLabel(first.t)} · {(timing.tickToMs(first.t) / 1000).toFixed(3)}s · {first.lane === 0 ? 'up' : 'down'} lane
        </p>
      )}

      {spans.length > 0 && (
        <NumberField
          label="Length (beats)"
          value={(spans[0].dur ?? PPQ) / PPQ}
          step={0.25}
          min={1 / 16}
          onChange={(v) => setProps('Set length', { dur: v * PPQ })}
        />
      )}
      {mashes.length > 0 && <NumberField label="Hits required (mash)" value={mashes[0].hits ?? 8} min={1} max={200} onChange={(v) => setProps('Set hits', { hits: v })} />}

      <SectionLabel>Convert to</SectionLabel>
      <div className="insp__grid">
        {(Object.keys(TYPE_LABEL) as NoteType[]).map((t) => (
          <Button key={t} size="sm" onClick={() => convertSel(t)} tip={`Shift+${TOOLS.find((x) => x.id === t)?.key}`}>
            {TYPE_LABEL[t]}
          </Button>
        ))}
      </div>

      <SectionLabel>Transform</SectionLabel>
      <div className="insp__grid">
        <Button size="sm" onClick={mirror} kbd="M">Mirror</Button>
        <Button size="sm" onClick={reverse} tip="Shift+R">Reverse</Button>
        <Button size="sm" onClick={() => stretch(2)} tip="Shift+.">×2</Button>
        <Button size="sm" onClick={() => stretch(0.5)} tip="Shift+,">×½</Button>
        <Button size="sm" onClick={() => stretch(1.5)}>×1.5</Button>
        <Button size="sm" onClick={() => stretch(2 / 3)}>×⅔</Button>
        <Button size="sm" onClick={quantizeSel} kbd="Q">Quantize</Button>
        <Button size="sm" onClick={duplicateSelection} tip="Ctrl+D">Duplicate</Button>
        <Button size="sm" onClick={() => setProps('Move to up lane', { lane: 0 })}>All up</Button>
        <Button size="sm" onClick={() => setProps('Move to down lane', { lane: 1 })}>All down</Button>
      </div>
      <Row>
        <SavePattern />
        <Button size="sm" variant="danger" onClick={deleteSelection} kbd="Del">Delete</Button>
      </Row>
    </div>
  );
};

const SavePattern: React.FC = () => {
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);
  const add = usePatterns((s) => s.add);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>Save as pattern</Button>;
  const commit = () => {
    const notes = selectionAsPattern();
    if (!notes.length) return;
    add(name.trim() || `Pattern ${new Date().toLocaleTimeString()}`, notes);
    toast('Pattern saved. Find it in the Patterns tab', 'success');
    setOpen(false);
    setName('');
  };
  return (
    <form className="insp__inline" onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <TextField value={name} onChange={setName} placeholder="Pattern name" autoFocus />
      <Button size="sm" variant="primary" type="submit" onClick={commit}>Save</Button>
    </form>
  );
};

// ============================================================================ Timing
const TimingPanel: React.FC = () => {
  const chart = useEditor((s) => s.chart)!;
  const timing = useEditor((s) => s.timing)!;
  const keepTime = useEditor((s) => s.keepTime);
  const tempo = useEditor((s) => s.tempo);
  const tempoBusy = useEditor((s) => s.tempoBusy);
  const taps = useEditor((s) => s.taps);
  const t = chart.timing;

  const commitTiming = (label: string, next: Chart['timing'], offsetMs = chart.audio.offsetMs) =>
    editor().commit(label, applyTiming(chart, next, offsetMs, keepTime), { keepSelection: !keepTime });

  const setBpm = (i: number, patch: Partial<BpmPoint>) =>
    commitTiming('Edit BPM', { ...t, bpm: t.bpm.map((p, j) => (j === i ? { ...p, ...patch } : p)).sort((a, b) => a.t - b.t) });
  const setSig = (i: number, patch: Partial<SignaturePoint>) =>
    commitTiming('Edit signature', { ...t, signatures: t.signatures.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setSpeed = (i: number, patch: Partial<SpeedPoint>) =>
    editor().commit('Edit scroll speed', { ...chart, timing: { ...t, speed: t.speed.map((p, j) => (j === i ? { ...p, ...patch } : p)) } }, { keepSelection: true });

  // live targets for the add buttons (re-render when the stopped playhead or snap moves)
  useEditor((s) => s.cursorMs);
  useEditor((s) => s.snap);
  const playing = useEditor((s) => s.playing);
  const flash = useEditor((s) => s.flash);
  const head = playheadTick();
  const where = playing ? 'playhead' : timing.beatLabel(head);
  const measureLabel = timing.beatLabel(measureStartAt(head)).split('.')[0];
  const rowClass = (key: string) => (flash === key ? 'is-flash' : undefined);

  const tapBpm = taps.length >= 4 ? (60000 * (taps.length - 1)) / (taps[taps.length - 1] - taps[0]) : null;

  return (
    <div className="insp__section">
      <p className="chamfer chamfer--xs insp__note">Points are added at the playhead. Click the ruler to move it.</p>
      <SectionLabel>Audio offset</SectionLabel>
      <p className="muted insp__hint">Where tick 0 (the first downbeat) sits in the audio file.</p>
      <Row>
        <NumberField value={chart.audio.offsetMs} step={1} suffix="ms" width={92} onChange={(v) => commitTiming('Set offset', t, v)} />
        <div className="segmented">
          {[-10, -1, 1, 10].map((d) => (
            <Button key={d} size="sm" sound="toggle" onClick={() => commitTiming('Nudge offset', t, chart.audio.offsetMs + d)}>
              {d > 0 ? `+${d}` : d}
            </Button>
          ))}
        </div>
      </Row>
      <Field label="When timing changes" inline>
        <span className="insp__toggle">
          <span className="muted">{keepTime ? 'notes keep their time' : 'notes follow the beat'}</span>
          <Toggle checked={keepTime} onChange={(v) => editor().set({ keepTime: v })} label="Keep notes at their time" />
        </span>
      </Field>

      <SectionLabel>Tempo detection</SectionLabel>
      <Row>
        <Button size="sm" onClick={() => detectTempo()} disabled={tempoBusy}>{tempoBusy ? 'Analysing…' : 'Detect BPM & offset'}</Button>
        <Button size="sm" kbd="T" onClick={() => tapTempo()}>Tap</Button>
        {taps.length > 0 && <Button size="sm" variant="ghost" onClick={() => editor().set({ taps: [] })}>Reset</Button>}
      </Row>
      {tempo && (
        <div className="chamfer chamfer--sm chamfer--raised insp__suggest">
          <span>
            <b className="mono-num">{tempo.bpm} BPM</b> · offset <span className="mono-num">{tempo.offsetMs.toFixed(0)} ms</span>
            <span className="muted"> · confidence {Math.round(tempo.confidence * 100)}%</span>
          </span>
          <Row>
            <Button size="sm" variant="primary" onClick={() => applyTempo(tempo.bpm, tempo.offsetMs)}>Apply</Button>
            <Button size="sm" onClick={() => applyTempo(tempo.bpm * 2, tempo.offsetMs)}>×2</Button>
            <Button size="sm" onClick={() => applyTempo(tempo.bpm / 2, tempo.offsetMs)}>÷2</Button>
            <Button size="sm" variant="ghost" onClick={() => editor().set({ tempo: null })}>Dismiss</Button>
          </Row>
        </div>
      )}
      {tapBpm && (
        <div className="chamfer chamfer--sm chamfer--raised insp__suggest">
          <span>Tapped <b className="mono-num">{tapBpm.toFixed(2)} BPM</b> <span className="muted">({taps.length} taps)</span></span>
          <Row>
            <Button size="sm" variant="primary" onClick={() => setBpm(0, { bpm: Math.round(tapBpm * 10) / 10 })}>Use {Math.round(tapBpm * 10) / 10}</Button>
            <Button size="sm" onClick={() => setBpm(0, { bpm: Math.round(tapBpm) })}>Use {Math.round(tapBpm)}</Button>
          </Row>
        </div>
      )}

      <SectionLabel>BPM points</SectionLabel>
      <ul className="insp__points">
        {t.bpm.map((p, i) => (
          <li key={`${p.t}-${i}`} className={rowClass(`bpm:${p.t}`)}>
            <button type="button" className="insp__at" onClick={() => seekTick(p.t)}>{timing.beatLabel(p.t)}</button>
            <NumberField value={p.bpm} min={1} max={2000} step={0.5} width={80} suffix="bpm" onChange={(v) => setBpm(i, { bpm: v })} />
            {i > 0 && <Button size="icon" variant="ghost" tip="Remove" onClick={() => commitTiming('Remove BPM', { ...t, bpm: t.bpm.filter((_, j) => j !== i) })}>×</Button>}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        onClick={() => addBpmPoint(playheadTick(), (next) => commitTiming('Add BPM', next))}
      >
        + BPM change at {where}
      </Button>

      <SectionLabel>Time signatures</SectionLabel>
      <ul className="insp__points">
        {t.signatures.map((p, i) => (
          <li key={`${p.t}-${i}`} className={rowClass(`sig:${p.t}`)}>
            <button type="button" className="insp__at" onClick={() => seekTick(p.t)}>{timing.beatLabel(p.t)}</button>
            <NumberField value={p.num} min={1} max={32} width={48} onChange={(v) => setSig(i, { num: Math.round(v) })} />
            <span className="muted">/</span>
            <NumberField value={p.den} min={1} max={32} width={48} onChange={(v) => setSig(i, { den: [1, 2, 4, 8, 16, 32].reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) })} />
            {i > 0 && <Button size="icon" variant="ghost" tip="Remove" onClick={() => commitTiming('Remove signature', { ...t, signatures: t.signatures.filter((_, j) => j !== i) })}>×</Button>}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        onClick={() => addSignaturePoint(playheadTick(), (next) => commitTiming('Add signature', next))}
      >
        + Signature at measure {playing ? 'of the playhead' : measureLabel}
      </Button>

      <SectionLabel>Scroll speed</SectionLabel>
      <p className="muted insp__hint">Speed-ups, slow-downs and ramps (linear eases from the previous point). Double-click the speed strip under the lanes to add a point there; drag a point to edit it.</p>
      <ul className="insp__points">
        {t.speed.map((p, i) => (
          <li key={`${p.t}-${i}`} className={rowClass(`speed:${p.t}`)}>
            <button type="button" className="insp__at" onClick={() => seekTick(p.t)}>{timing.beatLabel(p.t)}</button>
            <NumberField value={p.mult} min={0.05} max={10} step={0.05} width={64} suffix="×" onChange={(v) => setSpeed(i, { mult: v })} />
            {i > 0 && (
              <Segmented
                value={p.ease ?? 'step'}
                options={[{ value: 'step', label: 'Step' }, { value: 'linear', label: 'Ramp' }]}
                onChange={(v) => setSpeed(i, { ease: v })}
              />
            )}
            {i > 0 && (
              <Button size="icon" variant="ghost" tip="Remove" onClick={() => editor().commit('Remove speed', { ...chart, timing: { ...t, speed: t.speed.filter((_, j) => j !== i) } }, { keepSelection: true })}>
                ×
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        onClick={() => addSpeedPoint(playheadTick())}
      >
        + Speed point at {where}
      </Button>
    </div>
  );
};

/** Tap-tempo: keeps taps within a rolling 2.5 s gap */
export const tapTempo = () => {
  const now = performance.now();
  const taps = editor().taps;
  const next = taps.length && now - taps[taps.length - 1] > 2500 ? [now] : [...taps, now].slice(-32);
  editor().set({ taps: next, inspector: 'timing' });
};

// ============================================================================ Chart
const ChartPanel: React.FC = () => {
  const chart = useEditor((s) => s.chart)!;
  const diffIndex = useEditor((s) => s.diffIndex);
  const buffer = useEditor((s) => s.buffer);
  const timing = useEditor((s) => s.timing)!;
  const diff = chart.difficulties[diffIndex];
  const stats = useMemo(() => analyzeDifficulty(chart, diff, 60, (buffer?.duration ?? 0) * 1000), [chart, diff, buffer]);

  const meta = (patch: Partial<Chart['meta']>) => editor().commit('Edit metadata', { ...chart, meta: { ...chart.meta, ...patch } }, { keepSelection: true });
  const setDiffs = (label: string, difficulties: Difficulty[], index = diffIndex) => {
    editor().commit(label, { ...chart, difficulties });
    editor().setDiff(Math.max(0, Math.min(index, difficulties.length - 1)));
  };
  const markers = diff.events;

  return (
    <div className="insp__section">
      <SectionLabel>Song</SectionLabel>
      <TextField label="Title" value={chart.meta.title} onChange={(v) => meta({ title: v })} />
      <TextField label="Artist" value={chart.meta.artist} onChange={(v) => meta({ artist: v })} />
      <TextField label="Charter" value={chart.meta.charter} onChange={(v) => meta({ charter: v })} />
      <TextField label="Source (album, game…)" value={chart.meta.source ?? ''} onChange={(v) => meta({ source: v || undefined })} />
      <TextField label="Tags (comma separated)" value={chart.meta.tags.join(', ')} onChange={(v) => meta({ tags: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
      <Field label="Song select preview">
        <Row>
          <span className="mono-num">{(chart.meta.previewStartMs / 1000).toFixed(1)}s</span>
          <Button size="sm" onClick={() => meta({ previewStartMs: Math.max(0, Math.round(timing.tickToMs(playheadTick()))) })}>Set from playhead</Button>
        </Row>
      </Field>

      <SectionLabel>Difficulties</SectionLabel>
      <ul className="insp__diffs">
        {chart.difficulties.map((d, i) => (
          <li key={d.id}>
            <button type="button" className={cx('chamfer chamfer--xs chamfer--interactive insp__diff', i === diffIndex && 'chamfer--active')} onClick={() => editor().setDiff(i)}>
              <span>{d.name}</span>
              <span className="muted mono-num">Lv {d.level} · {d.notes.length}</span>
            </button>
          </li>
        ))}
      </ul>
      <Row>
        <Button size="sm" onClick={() => setDiffs('Add difficulty', [...chart.difficulties, { id: newId(), name: `Diff ${chart.difficulties.length + 1}`, level: 5, notes: [], events: [...diff.events] }], chart.difficulties.length)}>+ Empty</Button>
        <Button size="sm" onClick={() => setDiffs('Copy difficulty', [...chart.difficulties, { ...structuredClone(diff), id: newId(), name: `${diff.name} copy` }], chart.difficulties.length)}>Copy this one</Button>
        <Button
          size="sm"
          variant="danger"
          disabled={chart.difficulties.length < 2}
          onClick={() => {
            if (!confirm(`Delete difficulty “${diff.name}” and its ${diff.notes.length} notes? (Undo works.)`)) return;
            setDiffs('Delete difficulty', chart.difficulties.filter((_, i) => i !== diffIndex), diffIndex - 1);
          }}
        >
          Delete
        </Button>
      </Row>
      <TextField label="Difficulty name" value={diff.name} onChange={(v) => editor().commit('Rename difficulty', withDifficulty(chart, diffIndex, { name: v }), { keepSelection: true })} />
      <Field label="Level" hint={`Estimated: Lv ${stats.level} · ${stats.avgNps.toFixed(1)} avg / ${stats.peakNps.toFixed(1)} peak notes per second`}>
        <Row>
          <NumberField value={diff.level} min={1} max={15} width={56} onChange={(v) => editor().commit('Set level', withDifficulty(chart, diffIndex, { level: Math.round(v) }), { keepSelection: true })} />
          {stats.noteCount > 0 && stats.level !== diff.level && (
            <Button size="sm" onClick={() => editor().commit('Set level', withDifficulty(chart, diffIndex, { level: stats.level }), { keepSelection: true })}>Use estimate ({stats.level})</Button>
          )}
        </Row>
      </Field>

      <SectionLabel>Markers & events</SectionLabel>
      <Row>
        <Button size="sm" onClick={() => addEvent('section')} tip="Shift+B">+ Section</Button>
        <Button size="sm" onClick={() => addEvent('bookmark')} kbd="B">+ Bookmark</Button>
        <Button size="sm" onClick={() => addEvent('flash')}>+ Flash</Button>
        <Button size="sm" onClick={() => addEvent('hideLane')}>+ Hide lane</Button>
      </Row>
      <Row>
        <Button size="sm" variant="ghost" onClick={() => jumpMarker(-1)} tip="Alt+←">◀ Prev</Button>
        <Button size="sm" variant="ghost" onClick={() => jumpMarker(1)} tip="Alt+→">Next ▶</Button>
      </Row>
      {markers.length === 0 && <p className="muted insp__hint">No markers yet. Sections show in the minimap and practice mode.</p>}
      <ul className="insp__points">
        {markers.map((ev, i) => (
          <li key={`${ev.t}-${ev.type}-${i}`}>
            <button type="button" className="insp__at" onClick={() => seekTick(ev.t)}>{timing.beatLabel(ev.t)}</button>
            <span className={cx('insp__evtype', `insp__evtype--${ev.type}`)}>{ev.type === 'hideLane' ? 'hide' : ev.type}</span>
            {(ev.type === 'section' || ev.type === 'bookmark') && <TextField value={ev.label ?? ''} placeholder="Label" onChange={(v) => updateEvent(ev, { label: v })} />}
            {ev.type === 'hideLane' && (
              <>
                <Segmented value={ev.lane ?? 0} options={[{ value: 0, label: 'Up' }, { value: 1, label: 'Down' }]} onChange={(v) => updateEvent(ev, { lane: v as 0 | 1 })} />
                <NumberField value={(ev.dur ?? PPQ * 4) / PPQ} min={0.25} step={0.5} width={52} suffix="beats" onChange={(v) => updateEvent(ev, { dur: Math.round(v * PPQ) })} />
              </>
            )}
            <Button size="icon" variant="ghost" tip="Remove" onClick={() => removeEvent(ev)}>×</Button>
          </li>
        ))}
      </ul>
    </div>
  );
};

// ============================================================================ Lint
const LintPanel: React.FC = () => {
  const chart = useEditor((s) => s.chart)!;
  const diffIndex = useEditor((s) => s.diffIndex);
  const buffer = useEditor((s) => s.buffer);
  const diff = chart.difficulties[diffIndex];
  const issues = useMemo(() => lintDifficulty(chart, diff), [chart, diff]);
  const stats = useMemo(() => analyzeDifficulty(chart, diff, 60, (buffer?.duration ?? 0) * 1000), [chart, diff, buffer]);
  const timing = useEditor((s) => s.timing)!;

  const jump = (issue: LintIssue) => {
    seekTick(issue.tick);
    const notes = issue.noteIndices.map((i) => diff.notes[i]).filter(Boolean);
    if (notes.length) editor().set({ selection: new Set(notes) });
  };
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;

  return (
    <div className="insp__section">
      <SectionLabel>Stats</SectionLabel>
      <dl className="insp__stats">
        <div><dt>Notes</dt><dd className="mono-num">{stats.noteCount}</dd></div>
        <div><dt>Est. level</dt><dd className="mono-num">{stats.noteCount ? stats.level : '–'}</dd></div>
        <div><dt>Avg NPS</dt><dd className="mono-num">{stats.avgNps.toFixed(1)}</dd></div>
        <div><dt>Peak NPS</dt><dd className="mono-num">{stats.peakNps.toFixed(1)}</dd></div>
      </dl>
      <div className="density insp__density" aria-hidden>
        {Array.from(stats.density).map((v, i) => <span key={i} style={{ transform: `scaleY(${Math.max(0.02, v)})` }} />)}
      </div>
      <SectionLabel>
        Checks · {errors ? `${errors} error${errors > 1 ? 's' : ''}` : 'no errors'} · {warnings} warning{warnings === 1 ? '' : 's'}
      </SectionLabel>
      {issues.length === 0 && <p className="insp__ok">✓ Nothing to fix. This chart is clean.</p>}
      <ul className="insp__issues">
        {issues.slice(0, 200).map((issue, i) => (
          <li key={i}>
            <button type="button" className={cx('insp__issue', `insp__issue--${issue.level}`)} onClick={() => jump(issue)}>
              <span className="insp__issue-at mono-num">{timing.beatLabel(issue.tick)}</span>
              <span>{issue.message}</span>
            </button>
          </li>
        ))}
      </ul>
      {issues.length > 200 && <p className="muted insp__hint">…and {issues.length - 200} more.</p>}
    </div>
  );
};

// ============================================================================ Patterns
const PatternPreview: React.FC<{ p: Pattern }> = ({ p }) => {
  const span = Math.max(PPQ, patternSpan(p));
  return (
    <svg className="insp__pattern-svg" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <line x1="0" y1="12" x2="100" y2="12" />
      {p.notes.map((n, i) => {
        const x = 4 + (n.t / span) * 92;
        const y = n.type === 'mash' ? 12 : n.lane === 0 ? 6 : 18;
        const cls = `pn pn--${n.type} pn--l${n.lane}`;
        return (
          <g key={i}>
            {n.dur ? <rect className={cls} x={x} y={y - 1.5} width={(n.dur / span) * 92} height={3} opacity={0.5} /> : null}
            <rect className={cls} x={x - 2} y={y - (n.type === 'big' ? 4 : 3)} width={n.type === 'big' ? 5 : 4} height={n.type === 'big' ? 8 : 6} />
          </g>
        );
      })}
    </svg>
  );
};

const PatternsPanel: React.FC = () => {
  const user = usePatterns((s) => s.user);
  const remove = usePatterns((s) => s.remove);
  const stamp = useEditor((s) => s.stamp);
  const hasSel = useEditor((s) => s.selection.size > 0);
  const item = (p: Pattern) => (
    <li key={p.id}>
      <button type="button" className={cx('chamfer chamfer--xs chamfer--interactive insp__pattern', stamp === p.notes && 'chamfer--active')} onClick={() => stampPattern(p.notes)}>
        <span className="insp__pattern-name">{p.name}</span>
        <PatternPreview p={p} />
      </button>
      {!p.builtin && !STARTER_PATTERNS.includes(p) && (
        <Button size="icon" variant="ghost" tip="Delete pattern" onClick={() => remove(p.id)}>×</Button>
      )}
    </li>
  );
  return (
    <div className="insp__section">
      <p className="muted insp__hint">Click a pattern, then click the timeline to stamp it at the cursor. Stamping on the other lane mirrors it.</p>
      <SectionLabel>Your patterns</SectionLabel>
      {user.length === 0 && <p className="muted insp__hint">Select notes and choose <b>Save as pattern</b> in the Note tab.</p>}
      {hasSel && <SavePattern />}
      <ul className="insp__patterns">{user.map(item)}</ul>
      <SectionLabel>Starter patterns</SectionLabel>
      <ul className="insp__patterns">{STARTER_PATTERNS.map(item)}</ul>
    </div>
  );
};

// ============================================================================ root
const TABS: { value: InspectorTab; label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'timing', label: 'Timing' },
  { value: 'chart', label: 'Chart' },
  { value: 'lint', label: 'Lint' },
  { value: 'patterns', label: 'Patterns' },
];

export const Inspector: React.FC = () => {
  const tab = useEditor((s) => s.inspector);
  const hasChart = useEditor((s) => !!s.chart && !!s.timing);
  return (
    <aside className="chamfer chamfer--md insp" data-tour="inspector">
      <Tabs value={tab} tabs={TABS} onChange={(v) => editor().set({ inspector: v })} />
      <div className="insp__body">
        {hasChart && tab === 'note' && <NotePanel />}
        {hasChart && tab === 'timing' && <TimingPanel />}
        {hasChart && tab === 'chart' && <ChartPanel />}
        {hasChart && tab === 'lint' && <LintPanel />}
        {hasChart && tab === 'patterns' && <PatternsPanel />}
      </div>
    </aside>
  );
};
