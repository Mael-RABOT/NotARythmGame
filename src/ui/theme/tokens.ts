/**
 * Design tokens: single source of truth for the UI *and* the Pixi canvas.
 * Ported from the portfolio (src/theme/theme.const.ts), minus the MUI/CV parts,
 * plus gameplay tokens (lanes, judgements).
 *
 * Every token is exposed as a CSS custom property on :root:
 *   palettes.*.accentSoft -> --color-accent-soft,  shape.chamferSm -> --shape-chamfer-sm
 * Colours are scoped by <html data-theme="dark|light">. The canvas reads hex values
 * through `palette()` / `hex()` at stage init (and rebuilds on theme change).
 */

// ============================================================================
// 0. HELPERS
// ============================================================================
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return {
    r: parseInt(full.substring(0, 2), 16) || 0,
    g: parseInt(full.substring(2, 4), 16) || 0,
    b: parseInt(full.substring(4, 6), 16) || 0,
  };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function adjustBrightness(hex: string, percent: number): string {
  const { r, g, b } = hexToRgb(hex);
  const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c + (255 * percent) / 100)));
  const toHex = (c: number) => c.toString(16).padStart(2, '0');
  return `#${toHex(adjust(r))}${toHex(adjust(g))}${toHex(adjust(b))}`;
}

/** '#FF8A3D' -> 0xff8a3d (Pixi colours) */
export const hex = (color: string): number => parseInt(color.replace('#', '').slice(0, 6), 16);

// ============================================================================
// 1. COLORS
// ============================================================================
export type ThemeMode = 'dark' | 'light';
export const DEFAULT_THEME: ThemeMode = 'dark';

const PARCHMENT = '#F7F1E5';
const INK = '#1B1A17';

interface PaletteBase {
  bg: string;
  surface: string;
  surfaceRaised: string;
  text: string;
  accent: string;
  accentHover: string;
  onAccent: string;
  laneDown: string;      // the second lane colour (cool, contrasts with the amber accent)
  error: string;
  warning: string;
  success: string;
  gridAlpha: number;
}

const buildPalette = (b: PaletteBase) => ({
  bg: b.bg,
  surface: b.surface,
  surfaceRaised: b.surfaceRaised,

  text: b.text,
  textMuted: rgba(b.text, 0.68),
  textSubtle: rgba(b.text, 0.45),

  accent: b.accent,
  accentLight: b.accentHover,
  accentDark: adjustBrightness(b.accent, -12),
  accentSoft: rgba(b.accent, 0.12),
  accentGlow: rgba(b.accent, 0.35),
  onAccent: b.onAccent,

  laneUp: b.accent,
  laneDown: b.laneDown,
  laneDownSoft: rgba(b.laneDown, 0.12),

  line: rgba(b.text, 0.12),
  lineStrong: rgba(b.text, 0.24),

  gridLine: rgba(b.text, b.gridAlpha),
  gridHighlight: rgba(b.accent, 0.55),
  gridMarker: rgba(b.accent, 0.5),

  judgePerfect: b.accent,
  judgeGreat: b.laneDown,
  judgeGood: b.text,
  judgeMiss: b.error,

  error: b.error,
  warning: b.warning,
  success: b.success,
});

export type Palette = ReturnType<typeof buildPalette>;

export const palettes: Record<ThemeMode, Palette> = {
  dark: buildPalette({
    bg: '#0E0E0F',
    surface: '#151517',
    surfaceRaised: '#1D1D20',
    text: PARCHMENT,
    accent: '#FF8A3D',
    accentHover: '#FFA061',
    onAccent: '#0E0E0F',
    laneDown: '#3CC8E8',
    error: '#FF5C5C',
    warning: '#FFC24B',
    success: '#7ED68A',
    gridAlpha: 0.16,
  }),
  light: buildPalette({
    bg: PARCHMENT,
    surface: '#FBF8F1',
    surfaceRaised: '#FFFFFF',
    text: INK,
    accent: '#C2560F',
    accentHover: '#A8480A',
    onAccent: '#FFFDF8',
    laneDown: '#0B7FA0',
    error: '#C62828',
    warning: '#9A5B00',
    success: '#2E7D32',
    gridAlpha: 0.14,
  }),
};

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

export const cssColors = Object.fromEntries(
  Object.keys(palettes.dark).map((key) => [key, `var(--color-${kebab(key)})`]),
) as Record<keyof Palette, string>;

/** Active palette (reads <html data-theme>) */
export const palette = (): Palette =>
  palettes[(document.documentElement.dataset.theme as ThemeMode) ?? DEFAULT_THEME] ?? palettes.dark;

// ============================================================================
// 2. TYPOGRAPHY
// ============================================================================
export const fonts = {
  mono: "'IBM Plex Mono', ui-monospace, 'Courier New', monospace",
} as const;

export const fontWeights = { light: 300, regular: 400, medium: 500, semiBold: 600, bold: 700 } as const;

export const fontSizes = {
  xxs: '0.6875rem',
  xs: '0.75rem',
  sm: '0.875rem',
  md: '1rem',
  lg: '1.125rem',
  xl: '1.375rem',
  h3: '1.75rem',
  h2: 'clamp(1.75rem, 1.2rem + 2vw, 2.5rem)',
  h1: 'clamp(2.25rem, 1.4rem + 3.2vw, 3.5rem)',
  display: 'clamp(2.75rem, 1.2rem + 6vw, 5.5rem)',
} as const;

export const lineHeights = { tight: 1.1, snug: 1.3, normal: 1.6, relaxed: 1.75 } as const;

export const letterSpacing = { tight: '-0.03em', normal: '0', wide: '0.04em', label: '0.14em' } as const;

// ============================================================================
// 3. SPACING & LAYOUT
// ============================================================================
export const SPACING_BASE = 8;

export const spacing = {
  xxs: `${SPACING_BASE * 0.5}px`,
  xs: `${SPACING_BASE}px`,
  sm: `${SPACING_BASE * 1.5}px`,
  md: `${SPACING_BASE * 2}px`,
  lg: `${SPACING_BASE * 3}px`,
  xl: `${SPACING_BASE * 5}px`,
  xxl: `${SPACING_BASE * 8}px`,
} as const;

export const layout = {
  maxWidth: '1200px',
  gutter: 'clamp(16px, 4vw, 40px)',
  navHeight: '56px',
} as const;

// ============================================================================
// 4. SHAPE (chamfered corners: top-right & bottom-left)
// ============================================================================
export const shape = {
  chamfer: '14px',
  chamferMd: '10px',
  chamferSm: '8px',
  chamferXs: '4px',
  borderWidth: '1px',
  hudLength: '10px',
  hudWidth: '2px',
  radius: 0,
} as const;

// ============================================================================
// 5. DECORATION
// ============================================================================
export const grid = {
  size: 56,
  dash: '1 5',
  spotlightRadius: 240,
} as const;

// ============================================================================
// 6. MOTION
// ============================================================================
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const motion = {
  fast: 0.15,
  base: 0.35,
  slow: 0.7,
  glitch: 0.28,
  draw: 0.9,
  page: 0.3,
  decode: 0.45,
  easing: `cubic-bezier(${EASE.join(', ')})`,
  revealDistance: 24,
} as const;

// ============================================================================
// 7. CSS VARIABLES (generated)
// ============================================================================
const toCssValue = (group: string, key: string, value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (group === 'motion') return key === 'revealDistance' ? `${value}px` : `${value}s`;
    if (group === 'grid') return `${value}px`;
    return String(value);
  }
  return null;
};

const toVariables = (groups: Record<string, Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(groups).flatMap(([group, values]) =>
      Object.entries(values)
        .map(([key, value]): [string, string | null] => [`--${group}-${kebab(key)}`, toCssValue(group, key, value)])
        .filter((entry): entry is [string, string] => entry[1] !== null),
    ),
  );

export const cssVariables = toVariables({
  font: fonts,
  weight: fontWeights,
  size: fontSizes,
  leading: lineHeights,
  tracking: letterSpacing,
  space: spacing,
  layout,
  shape,
  grid,
  motion,
});

export const themeVariables: Record<ThemeMode, Record<string, string>> = {
  dark: toVariables({ color: palettes.dark }),
  light: toVariables({ color: palettes.light }),
};

const declarations = (vars: Record<string, string>) =>
  Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`).join('\n');

export const themeStylesheet = (): string =>
  [
    `:root {\n${declarations(cssVariables)}\n}`,
    ...(Object.keys(themeVariables) as ThemeMode[]).map(
      (mode) => `:root[data-theme="${mode}"] {\n${declarations(themeVariables[mode])}\n  color-scheme: ${mode};\n}`,
    ),
  ].join('\n\n');

export const injectThemeVariables = (): void => {
  let style = document.getElementById('theme-tokens');
  if (!style) {
    style = document.createElement('style');
    style.id = 'theme-tokens';
    document.head.prepend(style);
  }
  style.textContent = themeStylesheet();
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = DEFAULT_THEME;
};
