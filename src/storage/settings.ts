import { create } from 'zustand';
import type { ThemeMode } from '../ui/theme/tokens';

/** Key codes (KeyboardEvent.code) for the four gameplay keys: up A, up B, down A, down B */
export type Keybinds = [string, string, string, string];

export interface Settings {
  keys: Keybinds;
  scrollSpeed: number;     // 1..12
  audioOffsetMs: number;   // + when the audio reaches you late (judgement + visuals)
  visualOffsetMs: number;  // visuals only
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  hitsounds: boolean;
  uiSounds: boolean;
  effects: 'high' | 'low' | 'off';
  screenShake: boolean;
  showFps: boolean;
  showHitError: boolean;
  theme: ThemeMode;
  reducedMotion: 'system' | 'on' | 'off';
  laneSwap: boolean;       // swap which colour sits on top
  seenEditorTour: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  scrollSpeed: 6,
  audioOffsetMs: 0,
  visualOffsetMs: 0,
  masterVolume: 0.8,
  musicVolume: 0.8,
  sfxVolume: 0.7,
  hitsounds: true,
  uiSounds: true,
  effects: 'high',
  screenShake: true,
  showFps: false,
  showHitError: true,
  theme: 'dark',
  reducedMotion: 'system',
  laneSwap: false,
  seenEditorTour: false,
};

const STORAGE_KEY = 'narg.settings.v1';

const load = (): Settings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* private mode / corrupted: defaults */
  }
  return { ...DEFAULT_SETTINGS };
};

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { set: _s, reset: _r, ...data } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* ignore quota errors */
    }
  },
  reset: () => {
    set({ ...DEFAULT_SETTINGS });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));

/** Non-React access (game loop) */
export const settings = (): Settings => useSettings.getState();

export const keyLabel = (code: string): string =>
  code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5) : code
    .replace('Arrow', '')
    .replace('Semicolon', ';')
    .replace('Quote', "'")
    .replace('Comma', ',')
    .replace('Period', '.')
    .replace('Slash', '/')
    .replace('BracketLeft', '[')
    .replace('BracketRight', ']')
    .replace('Space', 'Space');
