import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { isApiError } from '../api/client.ts';
import { cx } from '../lib/cx.ts';
import { Button } from './ui.tsx';

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  return 'Algo salió mal. Intenta de nuevo.';
}

/** A failed load, always with a way out: retry in place. */
export function ErrorState({
  error,
  onRetry,
  title = 'No pudimos cargar esta información',
  className,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly title?: string;
  readonly className?: string;
}): ReactNode {
  function handleRetry(): void {
    onRetry();
  }
  return (
    <div
      role="alert"
      className={cx(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center',
        className,
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-danger-soft text-danger">
        <AlertTriangle className="size-5" aria-hidden="true" />
      </span>
      <div>
        <p className="font-medium text-fg">{title}</p>
        <p className="mt-1 text-sm text-muted">{errorMessage(error)}</p>
      </div>
      <Button
        size="sm"
        icon={<RotateCw className="size-3.5" aria-hidden="true" />}
        onClick={handleRetry}
      >
        Reintentar
      </Button>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={cx('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      <span className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary">
        {icon}
      </span>
      <div className="max-w-sm">
        <p className="font-semibold text-fg">{title}</p>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      </div>
    </div>
  );
}

export function InlineError({ error }: { readonly error: unknown }): ReactNode {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {errorMessage(error)}
    </p>
  );
}
