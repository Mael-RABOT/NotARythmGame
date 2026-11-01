import React, { useEffect, useMemo, useRef, useState } from 'react';
import { analyzeDifficulty } from '../../core/chart/analysis';
import { bestsDb, type BestRecord } from '../../storage/db';
import { Button, Segmented, Toggle } from '../components/controls';
import { DecodeText, Eyebrow, GlitchText, SectionLabel } from '../components/decor';
import { Modal, toast } from '../components/overlays';
import { useSettings } from '../../storage/settings';
import { go } from '../store/app';
import { deleteSong, exportSong, getSongBuffer, importNargFile, useLibrary, type SongEntry } from '../store/library';
import { stopPreview, useMenuMusic } from '../store/menuMusic';
import './screens.css';

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const RATES = [0.5, 0.75, 1, 1.25, 1.5];

export const SongSelectScreen: React.FC<{ focusSongId?: string }> = ({ focusSongId }) => {
  const songs = useLibrary((s) => s.songs);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, songs.findIndex((s) => s.id === focusSongId)));
  const [diffIndex, setDiffIndex] = useState(0);
  const [bests, setBests] = useState<Record<string, BestRecord>>({});
  const [autoplay, setAutoplay] = useState(false);
  const [rate, setRate] = useState(1);
  const [loading, setLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return songs;
    return songs.filter((s) => `${s.chart.meta.title} ${s.chart.meta.artist} ${s.chart.meta.charter} ${s.chart.meta.tags.join(' ')}`.toLowerCase().includes(q));
  }, [songs, query]);

  const song: SongEntry | undefined = filtered[Math.min(index, filtered.length - 1)];
  const diff = song?.chart.difficulties[Math.min(diffIndex, song.chart.difficulties.length - 1)];
  useMenuMusic(song);

  useEffect(() => {
    bestsDb.all().then((all) => setBests(Object.fromEntries(all.map((b) => [b.key, b])))).catch(() => undefined);
  }, []);

  const stats = useMemo(() => (song && diff ? analyzeDifficulty(song.chart, diff, 60) : null), [song, diff]);
  const bpm = useMemo(() => {
    if (!song) return '';
    const vals = song.chart.timing.bpm.map((b) => Math.round(b.bpm));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return min === max ? `${min}` : `${min}–${max}`;
  }, [song]);
  const length = stats?.durationMs ?? 0;

  const best = song && diff ? bests[bestsDb.key(song.id, diff.id)] : undefined;

  const play = async (practice = false) => {
    if (!song || !diff || loading) return;
    setLoading(true);
    try {
      const buffer = await getSongBuffer(song.id);
      stopPreview(0.2);
      go({
        name: 'play',
        request: {
          songId: song.id,
          chart: song.chart,
          diffId: diff.id,
          buffer,
          options: practice || autoplay || rate !== 1 ? { autoplay, rate } : {},
        },
      });
    } catch (e) {
      toast(`Could not load audio: ${(e as Error).message}`, 'error');
      setLoading(false);
    }
  };

  const onImport = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      try {
        const chart = await importNargFile(f);
        toast(`Imported “${chart.meta.title}”`, 'success');
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    }
  };

  // keyboard navigation (arrows or lane keys)
  const laneKeys = useSettings((s) => s.keys);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmDelete) return;
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === 'Escape') {
        if (typing && query) {
          setQuery('');
          return;
        }
        go({ name: 'title' });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (!typing && !e.ctrlKey && !e.metaKey && laneKeys.includes(e.code))) {
        e.preventDefault();
        const down = e.key === 'ArrowDown' || e.code === laneKeys[2] || e.code === laneKeys[3];
        setIndex((i) => Math.max(0, Math.min(filtered.length - 1, i + (down ? 1 : -1))));
        setDiffIndex(0);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (typing) return;
        e.preventDefault();
        const n = song?.chart.difficulties.length ?? 1;
        setDiffIndex((i) => Math.max(0, Math.min(n - 1, i + (e.key === 'ArrowRight' ? 1 : -1))));
      } else if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) {
        void play();
      } else if (!typing && e.key.toLowerCase() === 'e' && song) {
        go({ name: 'editor', songId: song.id });
      } else if (!typing && e.key === '/') {
        e.preventDefault();
        document.getElementById('song-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [index]);

  return (
    <main className="select screen">
      <header className="screen__bar">
        <Button sound="back" kbd="Esc" onClick={() => go({ name: 'title' })}>Back</Button>
        <div className="screen__heading">
          <Eyebrow>Song select</Eyebrow>
        </div>
        <span className="chamfer field-box select__search">
        <input
          id="song-search"
          className="input"
          placeholder="Search  ( / )"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        </span>
        <Button onClick={() => fileRef.current?.click()} tip="Import .narg chart packages">Import</Button>
        <Button variant="primary" onClick={() => go({ name: 'editor' })}>New chart</Button>
        <input ref={fileRef} type="file" accept=".narg,application/zip" multiple hidden onChange={(e) => void onImport(e.target.files)} />
      </header>

      <div className="select__body">
        <ul ref={listRef} className="select__list" role="listbox" aria-label="Songs">
          {filtered.map((s, i) => {
            const selected = s === song;
            const topBest = s.chart.difficulties.map((d) => bests[bestsDb.key(s.id, d.id)]).filter(Boolean).sort((a, b) => b.score - a.score)[0];
            return (
              <li key={s.id} role="option" aria-selected={selected}>
                <button
                  type="button"
                  className={`chamfer chamfer--md chamfer--interactive song-card ${selected ? 'is-selected chamfer--active hud' : ''}`}
                  style={{ '--enter-delay': `${Math.min(i, 12) * 0.03}s` } as React.CSSProperties}
                  onClick={() => {
                    if (selected) void play();
                    setIndex(i);
                    setDiffIndex(0);
                  }}
                >
                  <span className="song-card__title">{s.chart.meta.title}</span>
                  <span className="song-card__artist muted">{s.chart.meta.artist}</span>
                  <span className="song-card__meta">
                    {s.builtin && <span className="tag tag--accent">built-in</span>}
                    {s.chart.difficulties.map((d) => (
                      <span key={d.id} className="tag">{d.name} {d.level}</span>
                    ))}
                    {topBest && <span className={`grade grade--${topBest.grade}`}>{topBest.grade}</span>}
                  </span>
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && <li className="muted select__empty">No song matches “{query}”.</li>}
        </ul>

        {song && diff ? (
          <section className="select__detail chamfer hud" key={song.id}>
            <Eyebrow><DecodeText text={`${song.builtin ? 'Built-in · ' : ''}Charted by ${song.chart.meta.charter}`} /></Eyebrow>
            <h1 className="select__title"><GlitchText text={song.chart.meta.title} onLoad /></h1>
            <p className="muted">{song.chart.meta.artist}{song.chart.meta.source ? ` · ${song.chart.meta.source}` : ''}</p>

            <dl className="select__facts">
              <div><dt>BPM</dt><dd className="mono-num">{bpm}</dd></div>
              <div><dt>Length</dt><dd className="mono-num">{fmtTime(length)}</dd></div>
              <div><dt>Notes</dt><dd className="mono-num">{stats?.noteCount ?? 0}</dd></div>
              <div><dt>Peak NPS</dt><dd className="mono-num">{stats?.peakNps ?? 0}</dd></div>
            </dl>

            <SectionLabel>Difficulty</SectionLabel>
            <div className="select__diffs">
              <Segmented
                value={diffIndex}
                onChange={setDiffIndex}
                options={song.chart.difficulties.map((d, i) => ({ value: i, label: <>{d.name} <b className="accent">{d.level}</b></> }))}
              />
              <span className="subtle">← →</span>
            </div>

            {stats && (
              <div className="density" aria-label="Note density">
                {Array.from(stats.density).map((v, i) => (
                  <span key={i} style={{ transform: `scaleY(${Math.max(0.04, v)})` }} />
                ))}
              </div>
            )}

            <div className="select__best">
              <SectionLabel>Personal best</SectionLabel>
              {best ? (
                <div className="select__best-row">
                  <span className={`grade grade--lg grade--${best.grade}`}>{best.grade}</span>
                  <span className="mono-num select__best-score">{best.score.toString().padStart(7, '0')}</span>
                  <span className="mono-num muted">{(best.accuracy * 100).toFixed(2)}%</span>
                  <span className="mono-num muted">{best.maxCombo}x</span>
                  {best.fullCombo && <span className="tag tag--accent">FULL COMBO</span>}
                  {!best.fullCombo && best.cleared && <span className="tag">CLEAR</span>}
                  <span className="subtle">{best.plays} play{best.plays === 1 ? '' : 's'}</span>
                </div>
              ) : (
                <p className="subtle">Not played yet.</p>
              )}
            </div>

            <div className="select__options">
              <label className="select__opt"><Toggle checked={autoplay} onChange={setAutoplay} label="Autoplay" /> Autoplay</label>
              <div className="select__opt">
                <span className="field__label">Rate</span>
                <Segmented value={rate} onChange={setRate} options={RATES.map((r) => ({ value: r, label: `${r}×` }))} />
              </div>
            </div>

            <div className="select__actions">
              <Button variant="primary" size="lg" kbd="Enter" onClick={() => void play()} disabled={loading}>
                {loading ? 'Loading…' : autoplay ? 'Watch' : rate !== 1 ? 'Practice' : 'Play'}
              </Button>
              <Button kbd="E" onClick={() => go({ name: 'editor', songId: song.id })}>Edit</Button>
              <Button onClick={() => exportSong(song.id).catch((e) => toast((e as Error).message, 'error'))} tip="Download a .narg to share">Export</Button>
              {!song.builtin && <Button variant="danger" sound="back" onClick={() => setConfirmDelete(true)}>Delete</Button>}
            </div>
          </section>
        ) : (
          <section className="select__detail chamfer">
            <p className="muted">Your library is empty. Create a chart or import one.</p>
          </section>
        )}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        eyebrow="Delete song"
        title={`Delete “${song?.chart.meta.title}”?`}
        actions={
          <>
            <Button sound="back" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (!song) return;
                stopPreview(0.1);
                await deleteSong(song.id);
                setConfirmDelete(false);
                setIndex(0);
                toast('Song deleted', 'info');
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="muted">The chart, its audio and every difficulty will be removed from this browser. Export it first if you want to keep a copy.</p>
      </Modal>
    </main>
  );
};
