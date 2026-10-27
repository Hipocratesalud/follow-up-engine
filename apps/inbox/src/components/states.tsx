import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, RotateCw, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { isApiError } from '../api/client.ts';
import { cx } from '../lib/cx.ts';
import { Button } from './ui.tsx';

/**
 * What the team reads for API errors whose server message is meant for an
 * integrator (a scope name, a byte limit, a pagination cursor).
 */
const ERROR_COPY: Readonly<Record<string, string>> = {
  insufficient_scope:
    'Tu acceso no permite esta acción. Pide a quien administra el consultorio una clave con ese permiso.',
  rate_limited: 'Demasiadas solicitudes seguidas. Espera unos segundos e intenta de nuevo.',
  payload_too_large: 'El texto es demasiado largo. Acórtalo e intenta de nuevo.',
  invalid_cursor: 'La lista cambió mientras la recorrías. Vuelve a la primera página.',
};

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return ERROR_COPY[error.code] ?? error.message;
  return 'Algo salió mal. Intenta de nuevo.';
}

function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404;
}

/** Something that does not exist: no retry (it cannot succeed), a way back instead. */
export function NotFoundState({
  title,
  children,
  backTo = '/bandeja',
  backLabel = 'Ir a la bandeja',
  heading: Heading = 'h2',
  className,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly backTo?: string;
  readonly backLabel?: string;
  /** `h1` when it is the whole page (nothing else titles it). */
  readonly heading?: 'h1' | 'h2';
  readonly className?: string | undefined;
}): ReactNode {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-10 text-center',
        className,
      )}
    >
      <span className="grid size-10 place-items-center rounded-full bg-surface-2 text-muted">
        <SearchX className="size-5" aria-hidden="true" />
      </span>
      <div>
        <Heading className="font-semibold text-fg">{title}</Heading>
        {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
      </div>
      <Link
        to={backTo}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {backLabel}
      </Link>
    </div>
  );
}

/**
 * A failed load, always with a way out. A 404 offers the way back (retrying
 * cannot help); anything else retries in place and also every other query
 * that failed meanwhile (after an outage the shell's clinic name, clock and
 * counts come back too, not only this list).
 */
export function ErrorState({
  error,
  onRetry,
  title = 'No pudimos cargar esta información',
  notFoundTitle,
  notFoundHeading,
  className,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly title?: string;
  /** Title when the API answered 404 (the thing does not exist). */
  readonly notFoundTitle?: string;
  readonly notFoundHeading?: 'h1' | 'h2';
  readonly className?: string;
}): ReactNode {
  const queryClient = useQueryClient();
  function handleRetry(): void {
    onRetry();
    void queryClient.refetchQueries({ predicate: (query) => query.state.status === 'error' });
  }
  if (notFoundTitle !== undefined && isNotFound(error)) {
    return (
      <NotFoundState
        title={notFoundTitle}
        className={className}
        {...(notFoundHeading ? { heading: notFoundHeading } : {})}
      >
        Puede que el enlace esté mal o que ya no exista.
      </NotFoundState>
    );
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
