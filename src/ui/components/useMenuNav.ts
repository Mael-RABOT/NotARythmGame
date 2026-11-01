import { useEffect, type RefObject } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { settings } from '../../storage/settings';

/**
 * Keyboard / game-key navigation for menus (title, settings, pause, results).
 *   up-lane keys or ↑   → previous item        down-lane keys or ↓ → next item
 *   ← / →               → adjust the focused item (slider, segmented, toggle, select, tabs)
 *   Enter / Space       → activate (rows click their first control)
 *   Esc                 → onBack
 * Stops are `[data-nav]` elements inside the container, or its buttons when none are marked.
 */
const TEXT_INPUT = /^(text|search|number|email|password)$/;

const isTextField = (el: Element | null) =>
  !!el && ((el instanceof HTMLInputElement && TEXT_INPUT.test(el.type)) || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

const visible = (el: HTMLElement) => el.offsetParent !== null || el.getClientRects().length > 0;

export const focusStop = (el: HTMLElement) => {
  el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  el.scrollIntoView({ block: 'nearest' });
};

/** Sets a native input value so React's onChange fires */
const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};

/** ← / → on a stop: returns true when something changed */
export const adjustStop = (stop: HTMLElement, dir: 1 | -1): boolean => {
  const range = stop.matches('input[type=range]') ? (stop as HTMLInputElement) : stop.querySelector<HTMLInputElement>('input[type=range]');
  if (range) {
    const step = Number(range.step) || 1;
    const v = Math.min(Number(range.max), Math.max(Number(range.min), Number(range.value) + dir * step));
    setNativeValue(range, String(Math.round(v / step) * step));
    return true;
  }
  const group = stop.querySelector<HTMLElement>('[role=radiogroup], [role=tablist]') ?? (stop.matches('[role=radiogroup], [role=tablist]') ? stop : null);
  if (group) {
    const items = [...group.querySelectorAll<HTMLElement>('[role=radio], [role=tab]')];
    const cur = items.findIndex((b) => b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-selected') === 'true');
    const next = items[Math.max(0, Math.min(items.length - 1, cur + dir))];
    if (next && next !== items[cur]) {
      next.click();
      return true;
    }
    return false;
  }
  const sw = stop.matches('[role=switch]') ? stop : stop.querySelector<HTMLElement>('[role=switch]');
  if (sw) {
    const on = sw.getAttribute('aria-checked') === 'true';
    if ((dir > 0) !== on) sw.click();
    return true;
  }
  const select = stop.matches('select') ? (stop as HTMLSelectElement) : stop.querySelector('select');
  if (select) {
    const i = Math.max(0, Math.min(select.options.length - 1, select.selectedIndex + dir));
    if (i !== select.selectedIndex) setNativeValue(select, select.options[i].value);
    return true;
  }
  return false;
};

interface Options {
  onBack?: () => void;
  enabled?: boolean;
  /** focus the first stop on mount */
  autoFocus?: boolean;
}

export const useMenuNav = (ref: RefObject<HTMLElement | null>, { onBack, enabled = true, autoFocus = false }: Options = {}) => {
  useEffect(() => {
    if (!enabled) return;
    const stops = (): HTMLElement[] => {
      const root = ref.current;
      if (!root) return [];
      const marked = [...root.querySelectorAll<HTMLElement>('[data-nav]')];
      const list = marked.length ? marked : [...root.querySelectorAll<HTMLElement>('button')];
      return list.filter((el) => visible(el) && !(el as HTMLButtonElement).disabled);
    };
    if (autoFocus) {
      const first = stops()[0];
      if (first) first.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root || e.altKey || e.ctrlKey || e.metaKey) return;
      // a modal above us owns the keyboard
      const overlay = document.querySelector('.overlay');
      if (overlay && !overlay.contains(root)) return;
      const active = document.activeElement;
      if (isTextField(active)) return;
      const keys = settings().keys;
      const up = e.code === 'ArrowUp' || e.code === keys[0] || e.code === keys[1];
      const down = e.code === 'ArrowDown' || e.code === keys[2] || e.code === keys[3];
      const list = stops();
      const cur = list.findIndex((s) => s === active || s.contains(active));
      if (up || down) {
        if (!list.length) return;
        e.preventDefault();
        const next = cur < 0 ? (down ? 0 : list.length - 1) : (cur + (down ? 1 : -1) + list.length) % list.length;
        focusStop(list[next]);
        if (settings().uiSounds) audio.ui('uiHover');
        return;
      }
      if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && cur >= 0) {
        if (active instanceof HTMLInputElement && active.type === 'range') return; // native
        if (adjustStop(list[cur], e.code === 'ArrowRight' ? 1 : -1)) e.preventDefault();
        return;
      }
      if ((e.code === 'Enter' || e.code === 'Space') && cur >= 0 && list[cur] === active && !(active instanceof HTMLButtonElement)) {
        const target = list[cur].querySelector<HTMLElement>('button, [role=switch], input, select');
        if (target) {
          e.preventDefault();
          if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) focusStop(target);
          else target.click();
        }
        return;
      }
      if (e.code === 'Escape' && onBack) {
        e.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ref, onBack, enabled, autoFocus]);
};
