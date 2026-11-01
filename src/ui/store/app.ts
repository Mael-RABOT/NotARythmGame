import { flushSync } from 'react-dom';
import { create } from 'zustand';
import type { Chart } from '../../core/chart/types';
import { prefersReducedMotion } from '../components/decor';

export interface PlayOptions {
  autoplay?: boolean;
  rate?: number;
  /** Song ms to start from (practice / editor test play) */
  startMs?: number;
  /** A–B loop end (practice) */
  loopEndMs?: number;
  /** Return to the editor instead of results */
  fromEditor?: boolean;
}

export interface PlayRequest {
  songId: string;
  chart: Chart;
  diffId: string;
  buffer: AudioBuffer;
  options: PlayOptions;
}

export interface RunResult {
  request: PlayRequest;
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
  counts: [number, number, number, number];
  hitErrors: Float32Array;
  fullCombo: boolean;
  cleared: boolean;
  rollHits: number;
  collected: number;
  collectTotal: number;
  minesHit: number;
  totalNotes: number;
  newBest: boolean;
}

export type Screen =
  | { name: 'title' }
  | { name: 'select'; focusSongId?: string }
  | { name: 'play'; request: PlayRequest }
  | { name: 'results'; result: RunResult }
  | { name: 'editor'; songId?: string; newFile?: File; resume?: boolean }
  | { name: 'settings'; back: Screen; tab?: string }
  | { name: 'calibration'; back: Screen };

interface AppStore {
  screen: Screen;
  go: (screen: Screen) => void;
}

/** Navigates with a View Transition when available (cross-fade + slide) */
export const useApp = create<AppStore>((set) => ({
  screen: { name: 'title' },
  go: (screen) => {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !prefersReducedMotion()) {
      doc.startViewTransition(() => flushSync(() => set({ screen })));
    } else {
      set({ screen });
    }
  },
}));

export const go = (screen: Screen) => useApp.getState().go(screen);
