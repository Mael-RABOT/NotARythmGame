import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cssColors, grid, motion } from '../theme/tokens';
import { useSettings } from '../../storage/settings';
import './decor.css';

// ---------------------------------------------------------------- reduced motion
const QUERY = '(prefers-reduced-motion: reduce)';
const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
};

/** OS preference, overridden by the in-game setting */
export const useReducedMotion = (): boolean => {
  const system = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false);
  const pref = useSettings((s) => s.reducedMotion);
  return pref === 'system' ? system : pref === 'on';
};

export const prefersReducedMotion = (): boolean => {
  const pref = useSettings.getState().reducedMotion;
  return pref === 'system' ? window.matchMedia(QUERY).matches : pref === 'on';
};

// ---------------------------------------------------------------- GlitchText
export const GlitchText: React.FC<{ text: string; onLoad?: boolean; loop?: boolean; delay?: number; className?: string }> = ({
  text, onLoad = false, loop = false, delay = 0, className,
}) => (
  <span
    className={`glitch ${onLoad ? 'glitch--load' : ''} ${loop ? 'glitch--loop' : ''} ${className ?? ''}`}
    data-text={text}
    style={{ '--glitch-delay': `${delay}s` } as React.CSSProperties}
  >
    {text}
  </span>
);

// ---------------------------------------------------------------- DecodeText
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/#_';
const KEEP = /[\s·/\-|.:]/;

/** Characters scramble, then settle left to right (monospace labels) */
export const DecodeText: React.FC<{ text: string; delay?: number; className?: string }> = ({ text, delay = 0.15, className }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const chars = [...text];
    const duration = motion.decode * 1000;
    let timer = 0;
    const start = performance.now() + delay * 1000;
    const tick = () => {
      const t = Math.min(Math.max(0, performance.now() - start) / duration, 1);
      const settled = Math.ceil(t * chars.length);
      el.textContent = chars.map((c, i) => (i < settled || KEEP.test(c) ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
      if (t < 1) timer = window.setTimeout(tick, 40);
    };
    timer = window.setTimeout(tick, 0);
    return () => {
      clearTimeout(timer);
      el.textContent = text;
    };
  }, [text, delay, reduce]);
  return <span ref={ref} className={className}>{text}</span>;
};

// ---------------------------------------------------------------- labels
export const Eyebrow: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span className={`eyebrow ${className ?? ''}`}>{children}</span>
);

export const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span className={`section-label ${className ?? ''}`}>{children}</span>
);

// ---------------------------------------------------------------- AngleFrame
const FRAME_SIZE = grid.size * 2;
const CUT = 14;
const BRACKET = `M 0.5 ${FRAME_SIZE} V ${CUT} L ${CUT} 0.5 H ${FRAME_SIZE}`;

/** Chamfered corner brackets (top-left, bottom-right) around a positioned parent */
export const AngleFrame: React.FC<{ delay?: number; inset?: number }> = ({ delay = 0, inset = 24 }) => (
  <span className="angle-frame" style={{ '--frame-delay': `${delay}s`, inset: -inset } as React.CSSProperties} aria-hidden="true">
    {(['start', 'end'] as const).map((corner) => (
      <svg key={corner} className={`angle-frame__corner angle-frame__corner--${corner}`} width={FRAME_SIZE} height={FRAME_SIZE}>
        <path d={BRACKET} pathLength={1} fill="none" strokeWidth={1} style={{ stroke: cssColors.accent }} />
      </svg>
    ))}
  </span>
);

// ---------------------------------------------------------------- GridBackground
const MARKERS: Array<[number, number]> = [[2, 3], [9, 2], [16, 6], [4, 11], [21, 10], [12, 14], [25, 4], [7, 18], [30, 12], [18, 17]];

const GridPattern: React.FC<{ id: string; stroke: string }> = ({ id, stroke }) => (
  <pattern id={id} width={grid.size} height={grid.size} patternUnits="userSpaceOnUse">
    <path d={`M ${grid.size} 0 L 0 0 0 ${grid.size}`} fill="none" style={{ stroke }} strokeWidth={1} strokeDasharray={grid.dash} />
  </pattern>
);

/** Global beat signal for the background (set by whatever is playing music) */
let beatListener: ((strength: number) => void) | null = null;
export const pulseGrid = (strength = 1): void => beatListener?.(strength);

/**
 * Fixed dotted grid with a pointer spotlight (from the portfolio), plus a beat
 * pulse: `pulseGrid()` flashes the lit grid briefly, so menus breathe with the music.
 */
export const GridBackground: React.FC<{ dim?: boolean }> = ({ dim }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const [spotlight, setSpotlight] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || reduce) return;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    let frame = 0;
    let pointer = { x: -9999, y: -9999 };
    const render = () => {
      frame = 0;
      root.style.setProperty('--mx', `${pointer.x}px`);
      root.style.setProperty('--my', `${pointer.y}px`);
    };
    const onPointerMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(render);
    };
    if (finePointer) {
      setSpotlight(true);
      window.addEventListener('pointermove', onPointerMove, { passive: true });
    }
    // Web Animations API: restarts without forcing a style/layout flush
    const pulseLayer = root.querySelector<SVGElement>('.grid-bg__pulse');
    beatListener = (s) => {
      pulseLayer?.animate([{ opacity: 0.55 * s }, { opacity: 0 }], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    };
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      beatListener = null;
    };
  }, [reduce]);

  return (
    <div ref={rootRef} className={`grid-bg ${dim ? 'grid-bg--dim' : ''}`} aria-hidden="true">
      <svg className="grid-bg__layer">
        <defs><GridPattern id="grid-base" stroke={cssColors.gridLine} /></defs>
        <rect width="100%" height="100%" fill="url(#grid-base)" />
        {MARKERS.map(([cx, cy], i) => (
          <path
            key={`${cx}-${cy}`}
            className="grid-bg__marker"
            d={`M ${cx * grid.size - 5} ${cy * grid.size} h 10 M ${cx * grid.size} ${cy * grid.size - 5} v 10`}
            pathLength={1}
            style={{ stroke: cssColors.gridMarker, '--i': i } as React.CSSProperties}
            strokeWidth={1}
          />
        ))}
      </svg>
      <svg className="grid-bg__layer grid-bg__pulse">
        <defs><GridPattern id="grid-pulse" stroke={cssColors.gridHighlight} /></defs>
        <rect width="100%" height="100%" fill="url(#grid-pulse)" />
      </svg>
      {spotlight && (
        <svg className="grid-bg__layer grid-bg__spotlight">
          <defs><GridPattern id="grid-lit" stroke={cssColors.gridHighlight} /></defs>
          <rect width="100%" height="100%" fill="url(#grid-lit)" />
        </svg>
      )}
    </div>
  );
};
