import { CheckCheck, MousePointerClick } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useMemo } from 'react';
import { Outlet, useParams, useSearchParams } from 'react-router';
import type { CaseListView } from '../../api/contract.ts';
import { useCases } from '../../api/queries.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { StatsBar } from '../../components/stats-bar.tsx';
import { INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { CaseRow, CaseRowSkeleton } from './case-row.tsx';

const VIEW_OPTIONS: readonly { value: CaseListView; label: string }[] = [
  { value: 'active', label: 'Activos' },
  { value: 'closed', label: 'Cerrados' },
  { value: 'all', label: 'Todos' },
];

const EMPTY_COPY: Record<CaseListView, { title: string; body: string }> = {
  active: {
    title: 'No hay casos activos',
    body: 'Todos los pacientes tienen su seguimiento al día. Los casos nuevos aparecen aquí apenas una expectativa vence.',
  },
  closed: {
    title: 'Aún no hay casos cerrados',
    body: 'Los casos resueltos o descartados aparecen aquí.',
  },
  all: {
    title: 'Aún no hay casos',
    body: 'Los casos aparecen cuando una expectativa vence sin cumplirse.',
  },
};

function parseView(value: string | null): CaseListView {
  return VIEW_OPTIONS.find((option) => option.value === value)?.value ?? 'active';
}

function ViewFilter({
  value,
  onChange,
}: {
  readonly value: CaseListView;
  readonly onChange: (view: CaseListView) => void;
}): ReactNode {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    onChange(parseView(event.currentTarget.value));
  }
  return (
    <div
      role="group"
      aria-label="Estado de los casos"
      className="inline-flex rounded-lg bg-surface-2 p-0.5"
    >
      {VIEW_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          value={option.value}
          aria-pressed={value === option.value}
          onClick={handleClick}
          className={cx(
            'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
            value === option.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CaseList(): ReactNode {
  const { caseId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get('vista'));
  const assignee = searchParams.get('responsable') ?? '';
  const cases = useCases({ view, ...(assignee ? { assignee } : {}), limit: 200 });
  const everyone = useCases({ view: 'all', limit: 200 });

  const assignees = useMemo(
    () =>
      [
        ...new Set(
          (everyone.data?.items ?? []).flatMap((item) => (item.assignee ? [item.assignee] : [])),
        ),
      ].sort((a, b) => a.localeCompare(b, 'es')),
    [everyone.data],
  );

  function updateParam(key: string, value: string, fallback: string): void {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value === fallback) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  function handleViewChange(next: CaseListView): void {
    updateParam('vista', next, 'active');
  }

  function handleAssigneeChange(event: ChangeEvent<HTMLSelectElement>): void {
    updateParam('responsable', event.target.value, '');
  }

  function handleRetry(): void {
    void cases.refetch();
  }

  const search = searchParams.toString();
  const suffix = search ? `?${search}` : '';
  const items = cases.data?.items ?? [];

  return (
    <section aria-labelledby="case-list-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="flex items-center justify-between gap-2">
          <h2 id="case-list-title" className="text-sm font-semibold text-fg">
            Casos
            {cases.data ? (
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">
                {items.length}
              </span>
            ) : null}
          </h2>
          <ViewFilter value={view} onChange={handleViewChange} />
        </div>
        <label className="sr-only" htmlFor="assignee-filter">
          Responsable
        </label>
        <select
          id="assignee-filter"
          value={assignee}
          onChange={handleAssigneeChange}
          className={cx(INPUT_CLASS, 'h-9 py-0')}
        >
          <option value="">Todos los responsables</option>
          {assignees.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {cases.isPending ? (
        <div aria-busy="true" aria-label="Cargando casos" className="flex flex-col gap-1">
          {[0, 1, 2, 3, 4].map((key) => (
            <CaseRowSkeleton key={key} />
          ))}
        </div>
      ) : cases.isError ? (
        <ErrorState error={cases.error} onRetry={handleRetry} title="No pudimos cargar los casos" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CheckCheck className="size-5" aria-hidden="true" />}
          title={EMPTY_COPY[view].title}
        >
          {assignee ? `No hay casos de ${assignee} en esta vista.` : EMPTY_COPY[view].body}
        </EmptyState>
      ) : (
        <ul className={cx('flex flex-col gap-1', cases.isPlaceholderData && 'opacity-60')}>
          {items.map((item) => (
            <li key={item.id}>
              <CaseRow
                item={item}
                to={`/bandeja/${item.id}${suffix}`}
                selected={item.id === caseId}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function InboxPage(): ReactNode {
  const { caseId } = useParams();
  const hasSelection = caseId !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <header className={cx('flex flex-col gap-0.5', hasSelection && 'hidden lg:flex')}>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Bandeja de seguimiento</h1>
        <p className="text-sm text-muted">
          Pacientes con algo pendiente, ordenados por prioridad. Cada caso reúne todos los motivos
          de un paciente.
        </p>
      </header>
      <div className={cx(hasSelection && 'hidden lg:block')}>
        <StatsBar />
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className={cx(hasSelection && 'hidden lg:block')}>
          <CaseList />
        </div>
        <div
          className={cx(
            'min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:rounded-xl',
            !hasSelection && 'hidden lg:block',
          )}
        >
          {hasSelection ? (
            <Outlet />
          ) : (
            <div className="rounded-xl border border-dashed border-border-strong">
              <EmptyState
                icon={<MousePointerClick className="size-5" aria-hidden="true" />}
                title="Elige un caso de la lista"
              >
                Verás todos los motivos del paciente, la evidencia citada de la nota y el siguiente
                paso sugerido.
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
