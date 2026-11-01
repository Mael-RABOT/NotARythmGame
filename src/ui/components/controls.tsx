import React, { useId } from 'react';
import { audio } from '../../core/audio/AudioEngine';
import { settings } from '../../storage/settings';

const uiSound = (name: 'uiHover' | 'uiConfirm' | 'uiBack' | 'uiToggle') => {
  if (settings().uiSounds) audio.ui(name);
};

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------------------------------------------------------------- Button
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  active?: boolean;
  kbd?: string;
  tip?: string;
  tipPos?: 'bottom' | 'right' | 'top';
  sound?: 'confirm' | 'back' | 'toggle' | 'none';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', active, kbd, tip, tipPos, sound = 'confirm', className, children, onClick, onMouseEnter, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'chamfer btn',
        variant !== 'default' && `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        active && 'btn--active',
        className,
      )}
      data-tip={tip}
      data-tip-pos={tipPos}
      aria-pressed={active}
      onMouseEnter={(e) => {
        if (!rest.disabled) uiSound('uiHover');
        onMouseEnter?.(e);
      }}
      onClick={(e) => {
        if (sound === 'confirm') uiSound('uiConfirm');
        else if (sound === 'back') uiSound('uiBack');
        else if (sound === 'toggle') uiSound('uiToggle');
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
});

// ---------------------------------------------------------------- Field wrapper
export const Field: React.FC<{ label: string; hint?: React.ReactNode; children: React.ReactNode; inline?: boolean; htmlFor?: string }> = ({
  label, hint, children, inline, htmlFor,
}) => (
  <div className="field" style={inline ? { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 } : undefined}>
    <label className="field__label" htmlFor={htmlFor}>{label}</label>
    {children}
    {hint && !inline && <span className="field__hint">{hint}</span>}
  </div>
);

// ---------------------------------------------------------------- Toggle
export const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label?: string }> = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className="chamfer toggle"
    onClick={() => {
      uiSound('uiToggle');
      onChange(!checked);
    }}
  >
    <span className="toggle__knob" />
  </button>
);

// ---------------------------------------------------------------- Slider
interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label?: string;
  hint?: React.ReactNode;
}

export const Slider: React.FC<SliderProps> = ({ value, min, max, step = 1, onChange, format, label, hint }) => {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  const input = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input
        id={id}
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="mono-num" style={{ minWidth: 64, textAlign: 'right', fontSize: 'var(--size-sm)' }}>
        {format ? format(value) : value}
      </span>
    </div>
  );
  return label ? <Field label={label} hint={hint} htmlFor={id}>{input}</Field> : input;
};

// ---------------------------------------------------------------- NumberField
interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  suffix?: string;
  width?: number;
}

export const NumberField: React.FC<NumberFieldProps> = ({ value, onChange, min, max, step = 1, label, suffix, width }) => {
  const id = useId();
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (raw: string) => {
    const v = Number(raw);
    if (isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
    setDraft(null);
  };
  const el = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className="chamfer field-box" style={width ? { width, flex: 'none' } : undefined}>
      <input
        id={id}
        className="input mono-num"
        type="text"
        inputMode="decimal"
        value={draft ?? String(Math.round(value * 1000) / 1000)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          if (e.key === 'Escape') setDraft(null);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : 1;
            commit(String(value + (e.key === 'ArrowUp' ? step : -step) * mult));
          }
        }}
      />
      </span>
      {suffix && <span className="muted" style={{ fontSize: 'var(--size-xs)' }}>{suffix}</span>}
    </div>
  );
  return label ? <Field label={label} htmlFor={id}>{el}</Field> : el;
};

// ---------------------------------------------------------------- TextField
export const TextField: React.FC<{ value: string; onChange: (v: string) => void; label?: string; placeholder?: string; autoFocus?: boolean }> = ({
  value, onChange, label, placeholder, autoFocus,
}) => {
  const id = useId();
  const el = (
    <span className="chamfer field-box">
      <input
        id={id}
        className="input"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </span>
  );
  return label ? <Field label={label} htmlFor={id}>{el}</Field> : el;
};

// ---------------------------------------------------------------- Select
export function Select<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  const id = useId();
  const el = (
    <span className="chamfer field-box">
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as T)} onKeyDown={(e) => e.stopPropagation()}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </span>
  );
  return label ? <Field label={label} htmlFor={id}>{el}</Field> : el;
}

// ---------------------------------------------------------------- Segmented
export function Segmented<T extends string | number>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: React.ReactNode; tip?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <Button key={String(o.value)} size="sm" active={o.value === value} tip={o.tip} sound="toggle" onClick={() => onChange(o.value)} role="radio" aria-checked={o.value === value}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Tabs
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          type="button"
          className="tab"
          aria-selected={t.value === value}
          onMouseEnter={() => uiSound('uiHover')}
          onClick={() => {
            uiSound('uiToggle');
            onChange(t.value);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="kbd">{children}</kbd>;

export { uiSound, cx };
