import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { audio } from '../../core/audio/AudioEngine';
import { settings } from '../../storage/settings';
import { Eyebrow } from './decor';

// ---------------------------------------------------------------- Modal
interface ModalProps {
  open: boolean;
  onClose: () => void;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number;
}

export const Modal: React.FC<ModalProps> = ({ open, onClose, eyebrow, title, children, actions, width }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('button, input, select, [tabindex]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (settings().uiSounds) audio.ui('uiBack');
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="chamfer modal" role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 className="modal__title">{title}</h2>
        {children}
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- Toasts
type ToastKind = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  leaving?: boolean;
}

interface ToastStore {
  items: ToastItem[];
  push: (text: string, kind?: ToastKind, ms?: number) => void;
}

let nextId = 1;
export const useToasts = create<ToastStore>((set) => ({
  items: [],
  push: (text, kind = 'info', ms = 3200) => {
    const id = nextId++;
    set((s) => ({ items: [...s.items.slice(-3), { id, kind, text }] }));
    setTimeout(() => set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })), ms);
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), ms + 400);
  },
}));

export const toast = (text: string, kind: ToastKind = 'info', ms?: number) => useToasts.getState().push(text, kind, ms);

export const Toasts: React.FC = () => {
  const items = useToasts((s) => s.items);
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`chamfer toast toast--${t.kind} ${t.leaving ? 'is-leaving' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
};
