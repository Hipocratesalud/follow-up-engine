import { CheckCheck, MousePointerClick, Search, X } from 'lucide-react';
import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Outlet, useParams, useSearchParams } from 'react-router';
import type { CaseListView } from '../../api/contract.ts';
import { useCasePages, useNow, useOwners } from '../../api/queries.ts';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { StatsBar } from '../../components/stats-bar.tsx';
import { Button, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { CaseRow, CaseRowSkeleton, isNewCase } from './case-row.tsx';

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

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/** `value`, once it stopped changing for `delayMs` (a search box should not query per keystroke). */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return debounced;
}

/** Loads the next page when the end of the list scrolls into view (the button stays as a fallback). */
function useLoadMoreOnView(
  enabled: boolean,
  loaded: number,
  onView: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onView);
  useEffect(() => {
    callback.current = onView;
  });
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback.current();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
    // A new page moves the sentinel: observe again so a still-visible end loads the next one.
  }, [enabled, loaded]);
  return ref;
}

function CaseList(): ReactNode {
  const { caseId } = useParams();
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get('vista'));
  const assignee = searchParams.get('responsable') ?? '';
  const [searchText, setSearchText] = useState(searchParams.get('buscar') ?? '');
  const search = useDebounced(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const cases = useCasePages({
    view,
    ...(assignee ? { assignee } : {}),
    ...(search ? { q: search } : {}),
    limit: PAGE_SIZE,
  });
  const owners = useOwners();

  const updateParam = useCallback(
    (key: string, value: string, fallback: string): void => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value === fallback) next.delete(key);
          else next.set(key, value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(() => {
    updateParam('buscar', search, '');
  }, [search, updateParam]);

  function handleViewChange(next: CaseListView): void {
    updateParam('vista', next, 'active');
  }

  function handleAssigneeChange(event: ChangeEvent<HTMLSelectElement>): void {
    updateParam('responsable', event.target.value, '');
  }

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>): void {
    setSearchText(event.target.value);
  }

  function handleClearSearch(): void {
    setSearchText('');
  }

  function handleRetry(): void {
    void cases.refetch();
  }

  function handleLoadMore(): void {
    if (cases.hasNextPage && !cases.isFetchingNextPage) void cases.fetchNextPage();
  }

  const items = cases.data?.pages.flatMap((page) => page.items) ?? [];
  const sentinel = useLoadMoreOnView(cases.hasNextPage, items.length, handleLoadMore);
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const total = cases.data?.pages[0]?.total;
  const ownerName = owners.data?.items.find((owner) => owner.id === assignee)?.name;
  const emptyCopy = search
    ? `No hay casos de pacientes que coincidan con «${search}» en esta vista.`
    : assignee
      ? `No hay casos de ${ownerName ?? 'este responsable'} en esta vista.`
      : EMPTY_COPY[view].body;

  return (
    <section aria-labelledby="case-list-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="case-list-title" className="text-sm font-semibold text-fg">
            Casos
            {total === undefined ? null : (
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">
                {total}
              </span>
            )}
          </h2>
          <ViewFilter value={view} onChange={handleViewChange} />
        </div>
        <div className="relative">
          <label className="sr-only" htmlFor="case-search">
            Buscar paciente
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            id="case-search"
            type="search"
            value={searchText}
            onChange={handleSearchChange}
            autoComplete="off"
            placeholder="Buscar paciente por nombre"
            className={cx(INPUT_CLASS, 'h-9 py-0 pr-9 pl-9')}
          />
          {searchText ? (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label="Borrar búsqueda"
              className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
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
          {(owners.data?.items ?? []).map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
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
      ) : cases.isError && items.length === 0 ? (
        <ErrorState error={cases.error} onRetry={handleRetry} title="No pudimos cargar los casos" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CheckCheck className="size-5" aria-hidden="true" />}
          title={search ? 'Sin resultados' : EMPTY_COPY[view].title}
        >
          {emptyCopy}
        </EmptyState>
      ) : (
        <>
          <ul
            className={cx('flex min-w-0 flex-col gap-1', cases.isPlaceholderData && 'opacity-60')}
          >
            {items.map((item) => (
              <li key={item.id} className="min-w-0">
                <CaseRow
                  item={item}
                  to={`/bandeja/${item.id}${suffix}`}
                  selected={item.id === caseId}
                  isNew={isNewCase(item, now)}
                />
              </li>
            ))}
          </ul>
          <div ref={sentinel} className="flex flex-col items-center gap-2 py-2 text-xs text-muted">
            <p aria-live="polite">
              {total === undefined
                ? null
                : `Mostrando ${String(items.length)} de ${String(total)} ${total === 1 ? 'caso' : 'casos'}`}
            </p>
            {cases.hasNextPage ? (
              <Button
                size="sm"
                onClick={handleLoadMore}
                loading={cases.isFetchingNextPage}
                disabled={cases.isFetchingNextPage}
              >
                Cargar más casos
              </Button>
            ) : null}
            {cases.isFetchNextPageError ? <InlineError error={cases.error} /> : null}
          </div>
        </>
      )}
    </section>
  );
}

export function InboxPage(): ReactNode {
  const { caseId } = useParams();
  const hasSelection = caseId !== undefined;
  return (
    <div className="flex flex-col gap-4">
      {/* With a case open on a phone the header is visually hidden, but the page keeps its h1. */}
      <header className={cx('flex flex-col gap-0.5', hasSelection && 'sr-only lg:not-sr-only')}>
        <h1 className="text-xl font-semibold tracking-tight text-fg">Bandeja de seguimiento</h1>
        <p className="text-sm text-muted">
          Pacientes con algo pendiente, ordenados por prioridad. Cada caso reúne los motivos de un
          paciente por un mismo tipo de seguimiento: si tiene pendientes de distinto tipo, aparece
          en más de un caso.
        </p>
      </header>
      <div className={cx(hasSelection && 'hidden lg:block')}>
        <StatsBar />
      </div>
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className={cx('min-w-0', hasSelection && 'hidden lg:block')}>
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
