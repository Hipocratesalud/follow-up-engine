import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cx } from '../lib/cx.ts';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'sm' | 'md';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover shadow-card',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2 shadow-card',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  danger: 'bg-surface text-danger border border-border-strong hover:bg-danger-soft shadow-card',
  success: 'bg-surface text-success border border-border-strong hover:bg-success-soft shadow-card',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps): ReactNode {
  return (
    <button
      type={type}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none',
        'disabled:cursor-not-allowed disabled:opacity-60 aria-busy:cursor-progress',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }: { readonly className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { readonly children?: ReactNode }): ReactNode {
  return (
    <section
      className={cx('rounded-xl border border-border bg-surface shadow-card', className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  children,
  count,
  action,
  id,
}: {
  readonly children: ReactNode;
  readonly count?: number | undefined;
  readonly action?: ReactNode;
  readonly id?: string;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="flex items-center gap-2 text-sm font-semibold text-fg">
        {children}
        {count === undefined ? null : (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">
            {count}
          </span>
        )}
      </h2>
      {action}
    </div>
  );
}

export type Tone = 'neutral' | 'primary' | 'danger' | 'warning' | 'success' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
  info: 'bg-info-soft text-info',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
  title,
}: {
  readonly tone?: Tone;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export function Skeleton({ className }: { readonly className?: string }): ReactNode {
  return <div aria-hidden="true" className={cx('skeleton', className)} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  readonly label: ReactNode;
  readonly htmlFor: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const INPUT_CLASS =
  'w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle shadow-card transition-colors focus-visible:border-ring aria-invalid:border-danger';
