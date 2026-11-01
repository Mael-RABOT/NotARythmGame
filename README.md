# NOT A RYTHM GAME

A two-lane rhythm game (think Muse Dash meets Taiko) with a chart editor anyone can use:
drop a song, chart it in minutes, share it as a single `.narg` file.

Everything runs in the browser. There is no backend, no account and no artwork: every visual is
procedural and every sound effect is synthesized.

## Built-in songs

Every `.narg` in `charts/` ships with the game as a built-in song. Drop a file in, and it shows up in
song select (the dev server reloads by itself). The song list reads only each package's `chart.json`,
which is inlined at build time. The audio is fetched the first time the song plays.

`charts/fearless-pt2.narg` (Lost Sky - Fearless pt.II, Medium and Hard) is listed first and plays on the
title screen. Built-in songs open in the editor as an editable copy.

## Play

| | |
|---|---|
| Up lane | `D` `F` |
| Down lane | `J` `K` |
| Pause / resume | `Esc` |
| Instant restart | hold `Backspace` (or Restart in the pause menu) |

Menus work from the keyboard too: the up-lane keys or `↑` move up, the down-lane keys or `↓` move down, `←`/`→` adjust a slider, toggle or tab, and `Enter` activates.

All keys can be rebound in Settings. The performance overlay is a toggle in Settings → Video. Settings also has a calibration wizard (tap along to a click track) for audio offset.

**Note types**

| Type | What to do |
|---|---|
| Tap | Press the lane |
| Big | Press both keys of the lane together (2× score) |
| Hold | Press, keep holding, release at the end |
| Mash | Hit any key N times before it ends |
| Roll | Free bonus hits during the span |
| Mine | Don't press that lane |
| Collect | Have the lane held as it passes |

Notes on both lanes at the same tick are drawn linked: that's a sync hit. Score tops out at 1,000,000 and has no combo multiplier. To clear, you need 70% gauge at the end.

## Chart editor

Open it from the title screen (`E`), from song select (**New chart**, or **Edit** on a song), or by dropping
an audio file anywhere in the app.

1. **Drop an audio file.** The waveform appears and the BPM and offset are detected in a worker. Click **Apply** in the Timing tab.
2. **Place notes.** Pick a tool with `1`–`9` and click the lanes. Drag to set the length of holds, mashes and rolls. Right-click erases.
3. **Or record.** Press `R`, then `Space`, and play along with your normal game keys. Notes snap to the grid.
4. **Test play.** `F5` starts the real game right at the playhead. `Ctrl+F5` starts from the selection instead. `Esc` brings you back.
5. **Save.** `Ctrl+S` adds the chart to your library. **Export** downloads a `.narg` to share.

**Tools:**
- **Snap and placement:** snap from 1/1 to 1/16, plus triplets. Hold `Alt` to place without snapping.
- **Selection:** box select, and filters by lane or type.
- **Editing:** copy, paste, duplicate, nudge, plus transforms: mirror, reverse, stretch, quantize, convert type.
- **History:** unlimited undo/redo with labelled history.
- **Patterns:** a pattern library with ghost-preview stamping. Save your own from a selection.
- **Playback speed:** 10 %, 25 %, 50 %, 75 % or 100 % (`Shift+[` / `Shift+]`). Slowed playback keeps its pitch (WSOLA time-stretch in an AudioWorklet).
- **Timing:** BPM changes, time signatures and scroll-speed points (step or ramp), tap tempo, and offset nudging. New points go at the playhead, and the buttons show where. Double-click the speed strip under the lanes to add a speed point; drag a point to move it or change its value. Any timing edit can keep notes on the beat or at their time.
- **Markers and events:** sections, bookmarks, flash and hide-lane events.
- **Analysis:** a lint panel (overlaps, unplayable gaps, off-snap notes, density spikes; click an issue to jump to it), a live difficulty estimate and a density minimap.
- **Navigation and help:** a command palette (`Ctrl+K`), a shortcut sheet (`?`) and a first-run tour.
- **Saving:** autosave to IndexedDB with crash-safe restore.

## Chart format

`.narg` is a zip containing `chart.json`, the audio file and an optional cover. Time is measured in **ticks at 192 PPQ**, which represents 1/16 notes and every triplet subdivision exactly, so BPM changes never move notes. At load time, notes compile into struct-of-arrays typed arrays for the game loop. Imports are validated and sanitised (`src/core/chart/serialize.ts`).

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit tests (timing, judgement, editor ops, serialization, tempo detection)
npm run lint
npm run build        # type-check + production build (relative base, works under any path)
npm run gen:stress   # writes stress/stress.narg (~10k notes, 380 speed changes) for profiling
```

### Architecture

```
src/core/      pure TypeScript, no React
  audio/       AudioEngine (audio clock, latency-compensated), synthesized SFX,
               WSOLA time-stretch + AudioWorklet
  chart/       types, TimingMap (tick↔ms↔scroll position), compile (SoA), serialize, lint & difficulty
  game/        GameSession: judgement, scoring, gauge (frame-rate independent, event ring buffer)
  render/      Pixi playfield (pooled sprites, baked textures), shared long-lived Pixi app
  editor/      immutable chart operations (identity-preserving for selections)
  workers/     waveform peak mipmaps, onset/autocorrelation tempo detection
src/ui/        React screens, theme tokens, chamfer/HUD component kit
  editor/      editor screen (lazy chunk), timeline (Pixi notes + 2D canvas grid/waveform)
src/storage/   IndexedDB (songs, bests, autosave), settings
charts/        built-in songs (.narg), bundled by the plugin in vite.config.ts
```

### Performance notes
- Input is judged from `KeyboardEvent.timeStamp`, mapped onto the audio clock, not the frame time.
- The per-frame path allocates nothing. Note and particle sprites are pooled, and all shapes are baked once into textures, so each layer batches.
- Visible notes are found by binary search over the compiled arrays. Game logic stays around 1 ms per frame on the 9k-note stress chart.
- The editor (about 27 kB gzipped) and the analysis worker are lazy-loaded. The initial load is about 283 kB gzipped, most of it Pixi.
- After the first visit, the service worker makes the game work offline.
