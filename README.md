# NOT A RYTHM GAME

A two-lane rhythm game (inspired by Taiko & Muse Dash) with a chart editor anyone can use:
drop a song, chart it in minutes, share it as a single `.narg` file.

Everything runs in the browser. There is no backend & no account.

## Built-in songs

Every `.narg` in `charts/` ships with the game as a built-in song. Drop a file in, and it shows up in
song select (the dev server reloads by itself). The song list reads only each package's `chart.json`,
which is inlined at build time. The audio is fetched the first time the song plays.

`charts/fearless-pt2.narg` (Lost Sky - Fearless pt.II, Medium and Hard) is listed first. A song's preview plays only
when you select it in song select; the title screen is silent. Built-in songs open in the editor as an editable copy.

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

### Performance notes
- Input is judged from `KeyboardEvent.timeStamp`, mapped onto the audio clock, not the frame time.
- The per-frame path allocates nothing. Note and particle sprites are pooled, and all shapes are baked once into textures, so each layer batches.
- Visible notes are found by binary search over the compiled arrays. Game logic stays around 1 ms per frame on the 9k-note stress chart.
- The editor (about 27 kB gzipped) and the analysis worker are lazy-loaded. The initial load is about 283 kB gzipped, most of it Pixi.
- After the first visit, the service worker makes the game work offline.
