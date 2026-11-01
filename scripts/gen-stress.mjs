// Generates stress/stress.narg: a ~10k note chart (song length sized to fit) with every note type,
// BPM changes and aggressive scroll-speed changes. Drop it into the game to profile.
//   npm run gen:stress [-- --notes 10000 --minutes 16]
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const TARGET = arg('notes', 10000);
// ~11 notes per second at 180 BPM (1/16 grid with gaps): size the song to fit the target
const MINUTES = arg('minutes', Math.ceil(TARGET / 10 / 60));
const PPQ = 192;
const BPM = 180;
const SR = 8000; // clicks only: low rate keeps a long file small

// deterministic PRNG
let seed = 1337;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ------------------------------------------------------------------ audio: a click track
const seconds = MINUTES * 60;
const samples = new Int16Array(SR * seconds);
const beatSec = 60 / BPM;
for (let t = 0, k = 0; t < seconds; t += beatSec / 2, k++) {
  const start = Math.round(t * SR);
  const strong = k % 2 === 0;
  for (let i = 0; i < SR * 0.05 && start + i < samples.length; i++) {
    const env = Math.exp(-i / (SR * (strong ? 0.02 : 0.006)));
    const v = strong ? Math.sin((2 * Math.PI * 70 * i) / SR) * 0.8 : (rnd() * 2 - 1) * 0.2;
    samples[start + i] = Math.max(-32767, Math.min(32767, samples[start + i] + v * env * 32767));
  }
}
const wav = new Uint8Array(44 + samples.byteLength);
const dv = new DataView(wav.buffer);
const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
str(0, 'RIFF'); dv.setUint32(4, 36 + samples.byteLength, true); str(8, 'WAVE');
str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
str(36, 'data'); dv.setUint32(40, samples.byteLength, true);
wav.set(new Uint8Array(samples.buffer), 44);

// ------------------------------------------------------------------ chart
const totalTicks = Math.floor((seconds - 2) / beatSec) * PPQ;
const notes = [];
const step = PPQ / 4;
let t = PPQ * 4;
while (notes.length < TARGET && t < totalTicks) {
  const r = rnd();
  const lane = rnd() < 0.5 ? 0 : 1;
  if (r < 0.62) notes.push({ t, lane, type: 'tap' });
  else if (r < 0.7) { notes.push({ t, lane: 0, type: 'tap' }); notes.push({ t, lane: 1, type: 'tap' }); }
  else if (r < 0.76) notes.push({ t, lane, type: 'big' });
  else if (r < 0.82) { notes.push({ t, lane, type: 'hold', dur: PPQ }); notes.push({ t: t + step, lane: 1 - lane, type: 'tap' }); t += PPQ; }
  else if (r < 0.86) notes.push({ t, lane, type: 'mine' });
  else if (r < 0.9) notes.push({ t, lane, type: 'collect' });
  else if (r < 0.93) { notes.push({ t, lane: 0, type: 'mash', dur: PPQ * 2, hits: 12 }); t += PPQ * 2; }
  else if (r < 0.95) { notes.push({ t, lane: 0, type: 'roll', dur: PPQ }); t += PPQ; }
  t += rnd() < 0.3 ? step / 2 : step;
}
notes.sort((a, b) => a.t - b.t || a.lane - b.lane);

const speed = [{ t: 0, mult: 1 }];
for (let s = PPQ * 16; s < totalTicks; s += PPQ * 8) {
  speed.push({ t: s, mult: Math.round((0.4 + rnd() * 2.2) * 100) / 100, ease: rnd() < 0.5 ? 'linear' : 'step' });
}
const id = 'stress-test-chart';
const chart = {
  formatVersion: 1,
  id,
  meta: { title: `Stress ${notes.length}`, artist: 'gen-stress.mjs', charter: 'script', tags: ['stress'], previewStartMs: 10000 },
  audio: { file: 'audio_stress.wav', offsetMs: 0 },
  timing: { bpm: [{ t: 0, bpm: BPM }], signatures: [{ t: 0, num: 4, den: 4 }], speed },
  difficulties: [
    { id: 'stress', name: 'Stress', level: 15, notes, events: [{ t: PPQ * 64, type: 'section', label: 'Halfway?' }, { t: PPQ * 128, type: 'flash' }] },
  ],
};

const out = path.resolve('stress');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'stress.narg');
fs.writeFileSync(file, zipSync({ 'chart.json': strToU8(JSON.stringify(chart)), 'audio_stress.wav': [wav, { level: 0 }] }, { level: 6 }));
console.log(`wrote ${file}: ${notes.length} notes, ${speed.length} speed points, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
