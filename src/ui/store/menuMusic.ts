import { useEffect } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { TimingMap } from '../../core/chart/TimingMap';
import { PPQ } from '../../core/chart/types';
import { settings } from '../../storage/settings';
import { pulseGrid } from '../components/decor';
import { getSongBuffer, type SongEntry } from './library';

/**
 * Menu music: loops a song's preview section (fade in/out) and pulses the
 * background grid on its beats. One instance at a time.
 */
const PREVIEW_LENGTH_MS = 22000;

let currentId: string | null = null;
let raf = 0;
let token = 0;

const loop = (timing: TimingMap, startMs: number, myToken: number) => {
  let lastBeat = -1;
  const tick = () => {
    if (myToken !== token) return;
    raf = requestAnimationFrame(tick);
    if (!audio.playing) return;
    audio.tick();
    const ms = audio.positionMs;
    const beat = Math.floor(timing.msToTick(ms) / PPQ);
    if (beat !== lastBeat && ms > timing.offsetMs) {
      lastBeat = beat;
      pulseGrid(beat % 4 === 0 ? 1 : 0.4);
    }
    if (ms > startMs + PREVIEW_LENGTH_MS || ms >= audio.durationMs - 50) {
      audio.play(startMs, 1, 0.05, 1.2);
    }
  };
  raf = requestAnimationFrame(tick);
};

export const playPreview = async (entry: SongEntry): Promise<void> => {
  if (currentId === entry.id && audio.playing) return;
  currentId = entry.id;
  const myToken = ++token;
  cancelAnimationFrame(raf);
  if (audio.playing) audio.fadeOut(0.3);
  if (!audio.ready) return;
  try {
    const s = settings();
    audio.setVolumes(s.masterVolume, s.musicVolume * 0.7, s.sfxVolume);
    const buffer = await getSongBuffer(entry.id);
    if (myToken !== token) return;
    const start = Math.min(entry.chart.meta.previewStartMs, Math.max(0, buffer.duration * 1000 - PREVIEW_LENGTH_MS));
    audio.load(buffer);
    audio.play(start, 1, 0.05, 1.2);
    loop(new TimingMap(entry.chart.timing, entry.chart.audio.offsetMs), start, myToken);
  } catch {
    /* preview is decoration: ignore failures */
  }
};

export const stopPreview = (fade = 0.35): void => {
  token++;
  currentId = null;
  cancelAnimationFrame(raf);
  if (audio.playing) audio.fadeOut(fade);
};

/** Keeps a song preview playing while the calling screen is mounted */
export const useMenuMusic = (entry: SongEntry | undefined, enabled = true): void => {
  useEffect(() => {
    if (entry && enabled) void playPreview(entry);
  }, [entry, enabled]);
  useEffect(() => () => stopPreview(), []);
};
