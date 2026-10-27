import { CheckCheck, Search, X } from 'lucide-react';
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
import { useParams, useSearchParams } from 'react-router';
import type { CaseListView } from '../../api/contract.ts';
import type { PatientQueueItem } from '../../api/patient-queue-contract.ts';
import { usePatientQueuePages } from '../../api/patient-queue-queries.ts';
import { useNow, useOwners } from '../../api/queries.ts';
import { EmptyState, ErrorState, fieldError, InlineError } from '../../components/states.tsx';
import { Button, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { INPUT_LIMITS } from '../../lib/limits.ts';
import { CaseRowSkeleton } from '../inbox/case-row.tsx';
import { patientQueueCopy } from './copy.ts';
import { isNewPatient, PatientRow } from './patient-row.tsx';

const copy = patientQueueCopy();

const VIEWS: readonly CaseListView[] = ['active', 'closed', 'all'];

function parseView(value: string | null): CaseListView {
  return VIEWS.find((view) => view === value) ?? 'active';
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
      aria-label={copy.list.viewsLabel}
      className="inline-flex rounded-lg bg-surface-2 p-0.5"
    >
      {VIEWS.map((view) => (
        <button
          key={view}
          type="button"
          value={view}
          aria-pressed={value === view}
          onClick={handleClick}
          className={cx(
            'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
            value === view ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
          )}
        >
          {copy.list.views[view]}
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

/** Whether the open case (the URL's) is one of this patient's. */
function holdsCase(item: PatientQueueItem, caseId: string | undefined): boolean {
  return caseId !== undefined && item.cases.some((view) => view.id === caseId);
}

/**
 * The inbox list (HIP-141): one card per patient, most urgent patient first,
 * with the view, search and owner filters, a patient count with the case
 * count second, and infinite scroll by patient.
 */
export function PatientQueueList(): ReactNode {
  const { caseId } = useParams();
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get('vista'));
  const assignee = searchParams.get('responsable') ?? '';
  // A shared link may carry a longer search than the box accepts.
  const [searchText, setSearchText] = useState(
    (searchParams.get('buscar') ?? '').slice(0, INPUT_LIMITS.search),
  );
  const search = useDebounced(searchText.trim(), SEARCH_DEBOUNCE_MS);
  const queue = usePatientQueuePages({
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
    void queue.refetch();
  }

  function handleLoadMore(): void {
    if (queue.hasNextPage && !queue.isFetchingNextPage) void queue.fetchNextPage();
  }

  const items = queue.data?.pages.flatMap((page) => page.items) ?? [];
  // An invalid search is shown under the box; the list stays as it was, not an error page.
  const searchError = fieldError(queue.error, 'q');
  const sentinel = useLoadMoreOnView(queue.hasNextPage, items.length, handleLoadMore);
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const total = queue.data?.pages[0]?.total;
  const totalCases = queue.data?.pages[0]?.totalCases;
  const ownerName = owners.data?.items.find((owner) => owner.id === assignee)?.name;
  const emptyCopy = search
    ? copy.list.noMatch(search)
    : assignee
      ? copy.list.noOwner(ownerName)
      : copy.list.empty[view].body;

  return (
    <section aria-labelledby="case-list-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="case-list-title" className="text-sm font-semibold text-fg">
            {copy.list.title}
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
            {copy.list.searchLabel}
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <input
            id="case-search"
            type="search"
            value={searchText}
            maxLength={INPUT_LIMITS.search}
            onChange={handleSearchChange}
            aria-invalid={searchError ? true : undefined}
            aria-describedby={searchError ? 'case-search-error' : undefined}
            autoComplete="off"
            placeholder={copy.list.searchPlaceholder}
            className={cx(INPUT_CLASS, 'h-9 py-0 pr-9 pl-9')}
          />
          {searchText ? (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label={copy.list.clearSearch}
              className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {searchError ? (
          <p id="case-search-error" role="alert" className="-mt-1 text-sm text-danger">
            {searchError}
          </p>
        ) : null}
        <label className="sr-only" htmlFor="assignee-filter">
          {copy.list.ownerLabel}
        </label>
        <select
          id="assignee-filter"
          value={assignee}
          onChange={handleAssigneeChange}
          className={cx(INPUT_CLASS, 'h-9 py-0')}
        >
          <option value="">{copy.list.allOwners}</option>
          {(owners.data?.items ?? []).map((owner) => (
            <option key={owner.id} value={owner.id}>
              {owner.name}
            </option>
          ))}
        </select>
      </div>

      {queue.isPending ? (
        <div aria-busy="true" aria-label={copy.list.loading} className="flex flex-col gap-1">
          {[0, 1, 2, 3, 4].map((key) => (
            <CaseRowSkeleton key={key} />
          ))}
        </div>
      ) : searchError && items.length === 0 ? null : queue.isError && items.length === 0 ? (
        <ErrorState error={queue.error} onRetry={handleRetry} title={copy.list.loadError} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<CheckCheck className="size-5" aria-hidden="true" />}
          title={search ? copy.list.noResults : copy.list.empty[view].title}
        >
          {emptyCopy}
        </EmptyState>
      ) : (
        <>
          <ul
            className={cx('flex min-w-0 flex-col gap-1', queue.isPlaceholderData && 'opacity-60')}
          >
            {items.map((item) => (
              <li key={item.patient.id} className="min-w-0">
                <PatientRow
                  item={item}
                  to={`/bandeja/${item.nextAction.caseId}${suffix}`}
                  selected={holdsCase(item, caseId)}
                  isNew={isNewPatient(item, now)}
                />
              </li>
            ))}
          </ul>
          <div ref={sentinel} className="flex flex-col items-center gap-2 py-2 text-xs text-muted">
            <p aria-live="polite">
              {total === undefined || totalCases === undefined
                ? null
                : copy.list.showing(items.length, total, totalCases)}
            </p>
            {queue.hasNextPage ? (
              <Button
                size="sm"
                onClick={handleLoadMore}
                loading={queue.isFetchingNextPage}
                disabled={queue.isFetchingNextPage}
              >
                {copy.list.loadMore}
              </Button>
            ) : null}
            {queue.isFetchNextPageError ? <InlineError error={queue.error} /> : null}
          </div>
        </>
      )}
    </section>
  );
}
