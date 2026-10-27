import { Eye, EyeOff, ListChecks, MousePointerClick, SlidersHorizontal } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useCallback } from 'react';
import { Link, Outlet, useParams, useSearchParams } from 'react-router';
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  type FindingCategory,
  type FindingMode,
  type FindingSeverity,
  type FindingView,
  type ReviewMetrics,
} from '../../api/reviewer-contract.ts';
import { useFindingPages, useReviewMetrics } from '../../api/queries.ts';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { Button, INPUT_CLASS, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatPercent, formatUsd } from '../../lib/format.ts';
import { CATEGORY_LABELS, REVIEW_COPY, SEVERITY_LABELS, SEVERITY_ORDER } from './copy.ts';

const COPY = REVIEW_COPY;
import { FindingRow, FindingRowSkeleton } from './finding-row.tsx';

type Tab = 'open' | 'reviewed';

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'open', label: REVIEW_COPY.list.tabOpen },
  { value: 'reviewed', label: REVIEW_COPY.list.tabReviewed },
];

const MODES: readonly { value: FindingMode; label: string }[] = [
  { value: 'shadow', label: REVIEW_COPY.list.modeShadow },
  { value: 'live', label: REVIEW_COPY.list.modeLive },
];

const PAGE_SIZE = 50;

function parseTab(value: string | null): Tab {
  return value === 'revisados' ? 'reviewed' : 'open';
}

function parseMode(value: string | null): FindingMode {
  return value === 'en-vivo' ? 'live' : 'shadow';
}

function parseCategory(value: string | null): FindingCategory | undefined {
  return FINDING_CATEGORIES.find((category) => category === value);
}

function parseSeverity(value: string | null): FindingSeverity | undefined {
  return FINDING_SEVERITIES.find((severity) => severity === value);
}

/** Highest severity first; within a severity, the API's order (newest first). */
export function bySeverity(items: readonly FindingView[]): FindingView[] {
  return [...items].sort(
    (left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity],
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { value: T; label: string }[];
  readonly value: T;
  readonly onChange: (value: string) => void;
}): ReactNode {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    onChange(event.currentTarget.value);
  }
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex w-fit max-w-full rounded-lg bg-surface-2 p-0.5"
    >
      {options.map((option) => (
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

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0">
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</p>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </dd>
    </div>
  );
}

function MetricsTiles({ metrics }: { readonly metrics: ReviewMetrics }): ReactNode {
  return (
    <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Tile
        label={COPY.metrics.patients}
        value={String(metrics.patientsReviewed)}
        hint={COPY.metrics.patientsHint(metrics.runs)}
      />
      <Tile
        label={COPY.metrics.per100}
        value={metrics.findingsPer100Patients.toLocaleString('es')}
        hint={COPY.metrics.per100Hint(metrics.discarded)}
      />
      <Tile
        label={COPY.metrics.cost}
        value={formatUsd(metrics.avgCostUsd)}
        hint={COPY.metrics.costHint(metrics.avgToolCalls.toLocaleString('es'))}
      />
      <Tile
        label={COPY.metrics.precision}
        value={
          metrics.precision === undefined ? COPY.metrics.empty : formatPercent(metrics.precision)
        }
        hint={
          metrics.reviewed === 0
            ? COPY.metrics.precisionNone
            : COPY.metrics.precisionHint(metrics.reviewed)
        }
      />
    </dl>
  );
}

function Metrics(): ReactNode {
  const metrics = useReviewMetrics();
  function handleRetry(): void {
    void metrics.refetch();
  }
  if (metrics.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
        aria-busy="true"
        aria-label={COPY.metrics.loading}
      >
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[84px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (metrics.isError) {
    return <ErrorState error={metrics.error} onRetry={handleRetry} title={COPY.metrics.error} />;
  }
  return (
    <section aria-label={COPY.metrics.ariaLabel}>
      <MetricsTiles metrics={metrics.data} />
    </section>
  );
}

function LiveBanner(): ReactNode {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-xl border border-info/40 bg-info-soft px-4 py-3 text-sm text-info"
    >
      <Eye className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">{COPY.banner.liveStrong}</strong> {COPY.banner.liveRest}
      </p>
    </div>
  );
}

export function ShadowBanner(): ReactNode {
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
    >
      <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">{COPY.banner.shadowStrong}</strong>{' '}
        {COPY.banner.shadowRest}
      </p>
    </div>
  );
}

function FindingList(): ReactNode {
  const { findingId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('estado'));
  const mode = parseMode(searchParams.get('modo'));
  const category = parseCategory(searchParams.get('categoria'));
  const severity = parseSeverity(searchParams.get('severidad'));
  const findings = useFindingPages({
    mode,
    status: tab === 'open' ? 'open' : 'reviewed',
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    limit: PAGE_SIZE,
  });

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

  function handleTab(value: string): void {
    updateParam('estado', value === 'reviewed' ? 'revisados' : 'por-revisar', 'por-revisar');
  }
  function handleMode(value: string): void {
    updateParam('modo', value === 'live' ? 'en-vivo' : 'sombra', 'sombra');
  }
  function handleCategory(event: ChangeEvent<HTMLSelectElement>): void {
    updateParam('categoria', event.target.value, '');
  }
  function handleSeverity(event: ChangeEvent<HTMLSelectElement>): void {
    updateParam('severidad', event.target.value, '');
  }
  function handleRetry(): void {
    void findings.refetch();
  }
  function handleLoadMore(): void {
    if (findings.hasNextPage && !findings.isFetchingNextPage) void findings.fetchNextPage();
  }

  const items = bySeverity(findings.data?.pages.flatMap((page) => page.items) ?? []);
  const counts = findings.data?.pages[0]?.counts;
  const suffix = searchParams.toString() ? `?${searchParams.toString()}` : '';
  const tabCount = counts
    ? tab === 'open'
      ? (counts.byStatus.open ?? 0)
      : (counts.byStatus.relevant ?? 0) +
        (counts.byStatus.already_known ?? 0) +
        (counts.byStatus.not_relevant ?? 0)
    : undefined;

  return (
    <section aria-labelledby="finding-list-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="finding-list-title" className="text-sm font-semibold text-fg">
            {COPY.list.title}
            {tabCount === undefined ? null : (
              <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">
                {tabCount}
              </span>
            )}
          </h2>
          <Segmented
            label={COPY.list.modeGroup}
            options={MODES}
            value={mode}
            onChange={handleMode}
          />
        </div>
        <Segmented label={COPY.list.statusGroup} options={TABS} value={tab} onChange={handleTab} />
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <div>
            <label className="sr-only" htmlFor="finding-category">
              {COPY.list.categoryLabel}
            </label>
            <select
              id="finding-category"
              value={category ?? ''}
              onChange={handleCategory}
              className={cx(INPUT_CLASS, 'h-9 py-0')}
            >
              <option value="">{COPY.list.allCategories}</option>
              {FINDING_CATEGORIES.filter((item) => item !== 'similar_patients').map((item) => (
                <option key={item} value={item}>
                  {COPY.list.optionWithCount(CATEGORY_LABELS[item], counts?.byCategory[item] ?? 0)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="sr-only" htmlFor="finding-severity">
              {COPY.list.severityLabel}
            </label>
            <select
              id="finding-severity"
              value={severity ?? ''}
              onChange={handleSeverity}
              className={cx(INPUT_CLASS, 'h-9 py-0')}
            >
              <option value="">{COPY.list.allSeverities}</option>
              {FINDING_SEVERITIES.map((item) => (
                <option key={item} value={item}>
                  {COPY.list.optionWithCount(SEVERITY_LABELS[item], counts?.bySeverity[item] ?? 0)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {findings.isPending ? (
        <div aria-busy="true" aria-label={COPY.list.loading} className="flex flex-col gap-1">
          {[0, 1, 2, 3].map((key) => (
            <FindingRowSkeleton key={key} />
          ))}
        </div>
      ) : findings.isError && items.length === 0 ? (
        <ErrorState error={findings.error} onRetry={handleRetry} title={COPY.list.error} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListChecks className="size-5" aria-hidden="true" />}
          title={COPY.list.emptyTitle}
        >
          {tab === 'open' ? COPY.list.emptyOpen : COPY.list.emptyReviewed}
        </EmptyState>
      ) : (
        <>
          <ul
            className={cx(
              'flex min-w-0 flex-col gap-1',
              findings.isPlaceholderData && 'opacity-60',
            )}
          >
            {items.map((item) => (
              <li key={item.id} className="min-w-0">
                <FindingRow
                  item={item}
                  to={`/revision-clinica/${item.id}${suffix}`}
                  selected={item.id === findingId}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-col items-center gap-2 py-2 text-xs text-muted">
            {findings.hasNextPage ? (
              <Button
                size="sm"
                onClick={handleLoadMore}
                loading={findings.isFetchingNextPage}
                disabled={findings.isFetchingNextPage}
              >
                {COPY.list.loadMore}
              </Button>
            ) : null}
            {findings.isFetchNextPageError ? <InlineError error={findings.error} /> : null}
          </div>
        </>
      )}
    </section>
  );
}

export function ReviewPage(): ReactNode {
  const { findingId } = useParams();
  const [searchParams] = useSearchParams();
  const live = parseMode(searchParams.get('modo')) === 'live';
  const hasSelection = findingId !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <header
        className={cx(
          'flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap',
          hasSelection && 'sr-only lg:not-sr-only',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1 className="text-xl font-semibold tracking-tight text-fg">{COPY.page.title}</h1>
          <p className="text-sm text-muted">{COPY.page.intro}</p>
        </div>
        <Link
          to="/revision-clinica/categorias"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {COPY.page.categoriesLink}
        </Link>
      </header>
      <div className={cx('flex flex-col gap-4', hasSelection && 'hidden lg:flex')}>
        {live ? <LiveBanner /> : <ShadowBanner />}
        <Metrics />
      </div>
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
        <div className={cx('min-w-0', hasSelection && 'hidden lg:block')}>
          <FindingList />
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
                title={COPY.page.selectTitle}
              >
                {COPY.page.selectBody}
              </EmptyState>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
