import { BarChart3 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useNow } from '../../api/queries.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { Card, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { BarChart, type BarRow, Legend, QuantileStrip, type SeriesTone } from './charts.tsx';
import {
  type ClinicMetricsView,
  METRICS_DISMISS_REASONS,
  ORIGIN_KEYS,
  type OriginKey,
  type OriginSplit,
} from './contract.ts';
import {
  type MetricsCopy,
  metricsCopy,
  metricsFormat,
  type MetricsLocale,
  METRICS_PRESETS,
  type MetricsPreset,
} from './copy.ts';
import { useMetrics } from './queries.ts';

const DAY_MS = 86_400_000;
const DEFAULT_PRESET: MetricsPreset = 30;
const TITLE_ID = 'metrics-title';

const ORIGIN_TONES: Readonly<Record<OriginKey, SeriesTone>> = {
  followUpCase: 'primary',
  patientContact: 'info',
  organic: 'neutral',
};

type Format = ReturnType<typeof metricsFormat>;

function presetOf(value: string | null): MetricsPreset {
  const days = Number(value);
  return (METRICS_PRESETS as readonly number[]).includes(days)
    ? (days as MetricsPreset)
    : DEFAULT_PRESET;
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
      <dd className="text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</dd>
      <dd className="text-xs text-muted">{hint}</dd>
    </div>
  );
}

function Panel({
  title,
  description,
  children,
  className,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <Card className={cx('flex flex-col gap-4 p-4 lg:p-5', className)}>
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="text-xs text-muted">{description}</p>
      </header>
      {children}
    </Card>
  );
}

function originSegments(split: OriginSplit, copy: MetricsCopy): BarRow['segments'] {
  return ORIGIN_KEYS.map((key) => ({
    key,
    label: copy.funnel.origin[key],
    value: split[key],
    tone: ORIGIN_TONES[key],
  }));
}

function originParts(split: OriginSplit, copy: MetricsCopy): string {
  return ORIGIN_KEYS.filter((key) => split[key] > 0)
    .map((key) => `${copy.funnel.origin[key]} ${String(split[key])}`)
    .join(', ');
}

function Tiles({
  metrics,
  copy,
  format,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
  readonly format: Format;
}): ReactNode {
  const { cases, bookings, timeToFirstAction, feedback, aiCost, backfill } = metrics;
  const median = timeToFirstAction.medianHours;
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label={copy.tiles.opened}
        value={format.integer(cases.opened)}
        hint={copy.tiles.openedHint(cases.live, cases.backfill)}
      />
      <Tile
        label={copy.tiles.booked}
        value={format.integer(bookings.booked.total)}
        hint={copy.tiles.bookedHint(format.percent(bookings.bookedRate))}
      />
      <Tile
        label={copy.tiles.attended}
        value={format.integer(bookings.attended.total)}
        hint={copy.tiles.attendedHint(format.percent(bookings.attendedRate))}
      />
      <Tile
        label={copy.tiles.firstAction}
        value={median === undefined ? copy.tiles.none : copy.hours(median)}
        hint={copy.tiles.firstActionHint(timeToFirstAction.measured, timeToFirstAction.pending)}
      />
      <Tile
        label={copy.tiles.useful}
        value={format.percent(feedback.usefulRate)}
        hint={copy.tiles.usefulHint(feedback.casesWithFeedback)}
      />
      <Tile
        label={copy.tiles.costPerCase}
        value={format.usd(aiCost.allInPerCaseUsd)}
        hint={copy.tiles.costPerCaseHint(format.usd(aiCost.totalUsd))}
      />
      <Tile
        label={copy.tiles.lost}
        value={format.integer(cases.lostToFollowUp)}
        hint={copy.tiles.lostHint(cases.dismissed)}
      />
      <Tile
        label={copy.tiles.recovered}
        value={format.integer(backfill.recoveredPatients)}
        hint={copy.tiles.recoveredHint(backfill.recoveredCases)}
      />
    </dl>
  );
}

function Funnel({
  metrics,
  copy,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
}): ReactNode {
  const { cases, bookings } = metrics;
  const rows: BarRow[] = [
    {
      key: 'opened',
      label: copy.funnel.opened,
      segments: [
        { key: 'opened', label: copy.funnel.opened, value: cases.opened, tone: 'neutral' },
      ],
    },
    { key: 'booked', label: copy.funnel.booked, segments: originSegments(bookings.booked, copy) },
    {
      key: 'attended',
      label: copy.funnel.attended,
      segments: originSegments(bookings.attended, copy),
    },
    {
      key: 'resolved',
      label: copy.funnel.resolvedByBooking,
      segments: originSegments(bookings.resolvedByBooking, copy),
    },
  ];
  const caption = [
    copy.funnel.summary(copy.funnel.opened, cases.opened, ''),
    copy.funnel.summary(
      copy.funnel.booked,
      bookings.booked.total,
      originParts(bookings.booked, copy),
    ),
    copy.funnel.summary(
      copy.funnel.attended,
      bookings.attended.total,
      originParts(bookings.attended, copy),
    ),
  ].join('. ');
  return (
    <Panel
      title={copy.funnel.title}
      description={copy.funnel.description}
      className="lg:col-span-2"
    >
      <BarChart rows={rows} caption={caption} />
      <Legend
        items={ORIGIN_KEYS.map((key) => ({
          key,
          label: copy.funnel.origin[key],
          tone: ORIGIN_TONES[key],
        }))}
      />
    </Panel>
  );
}

function Timing({
  metrics,
  copy,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
}): ReactNode {
  const { medianHours, p75Hours, p90Hours } = metrics.timeToFirstAction;
  const markers =
    medianHours === undefined || p75Hours === undefined || p90Hours === undefined
      ? undefined
      : [
          { key: 'median', label: copy.timing.median, value: medianHours },
          { key: 'p75', label: copy.timing.p75, value: p75Hours },
          { key: 'p90', label: copy.timing.p90, value: p90Hours },
        ].map((marker) => ({ ...marker, display: copy.hours(marker.value) }));
  return (
    <Panel title={copy.timing.title} description={copy.timing.description}>
      {markers === undefined ? (
        <p className="text-sm text-muted">{copy.timing.none}</p>
      ) : (
        <QuantileStrip
          markers={markers}
          caption={copy.timing.title}
          summary={copy.timing.summary(
            markers[0]?.display ?? '',
            markers[1]?.display ?? '',
            markers[2]?.display ?? '',
          )}
        />
      )}
    </Panel>
  );
}

function Dismissals({
  metrics,
  copy,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
}): ReactNode {
  const { dismissals } = metrics;
  const rows: BarRow[] = METRICS_DISMISS_REASONS.map((reason): BarRow => ({
    key: reason,
    label: copy.dismissals.reasons[reason],
    segments: [
      {
        key: reason,
        label: copy.dismissals.reasons[reason],
        value: dismissals.byReason[reason],
        tone: 'warning',
      },
    ],
  }))
    .filter((row) => (row.segments[0]?.value ?? 0) > 0)
    .sort((left, right) => (right.segments[0]?.value ?? 0) - (left.segments[0]?.value ?? 0));
  return (
    <Panel
      title={copy.dismissals.title}
      description={copy.dismissals.description(dismissals.total)}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{copy.dismissals.none}</p>
      ) : (
        <BarChart rows={rows} caption={copy.dismissals.title} />
      )}
    </Panel>
  );
}

function Extraction({
  metrics,
  copy,
  format,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
  readonly format: Format;
}): ReactNode {
  const { conditions, planItems } = metrics.extractionReviews;
  const rows: BarRow[] = [
    {
      key: 'conditions',
      label: copy.extraction.conditions,
      segments: [
        {
          key: 'confirmed',
          label: copy.extraction.confirmed,
          value: conditions.confirmed,
          tone: 'success',
        },
        {
          key: 'rejected',
          label: copy.extraction.rejected,
          value: conditions.rejected,
          tone: 'danger',
        },
        {
          key: 'pending',
          label: copy.extraction.pending,
          value: conditions.pendingReview,
          tone: 'neutral',
        },
      ],
    },
  ];
  return (
    <Panel title={copy.extraction.title} description={copy.extraction.description}>
      <BarChart rows={rows} caption={copy.extraction.conditions} />
      <Legend
        items={[
          { key: 'confirmed', label: copy.extraction.confirmed, tone: 'success' },
          { key: 'rejected', label: copy.extraction.rejected, tone: 'danger' },
          { key: 'pending', label: copy.extraction.pending, tone: 'neutral' },
        ]}
      />
      <p className="text-xs text-muted">
        {conditions.reviewed === 0
          ? copy.tiles.none
          : copy.extraction.corrections(format.percent(conditions.rejectRate))}
      </p>
      <div className="flex flex-col gap-0.5 border-t border-border pt-3">
        <h3 className="text-xs font-medium text-fg">{copy.extraction.planItems}</h3>
        <p className="text-xs text-muted">
          {planItems.total === 0
            ? copy.extraction.planItemsNone
            : copy.extraction.planItemsCounts(
                planItems.confirmed,
                planItems.corrected,
                planItems.rejected,
              )}
        </p>
      </div>
    </Panel>
  );
}

function AiCost({
  metrics,
  copy,
  format,
}: {
  readonly metrics: ClinicMetricsView;
  readonly copy: MetricsCopy;
  readonly format: Format;
}): ReactNode {
  const { aiCost } = metrics;
  // Calls carry the scale: a free provider (the demo's fake) still shows the work done.
  const rows: BarRow[] = aiCost.byTask.map((usage) => ({
    key: usage.task,
    label: copy.ai.tasks[usage.task] ?? usage.task,
    segments: [
      {
        key: usage.task,
        label: copy.ai.calls(usage.calls),
        value: usage.calls,
        tone: 'primary',
      },
    ],
    display: format.usd(usage.costUsd),
  }));
  return (
    <Panel title={copy.ai.title} description={copy.ai.description}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{copy.ai.none}</p>
      ) : (
        <>
          <BarChart rows={rows} caption={copy.ai.title} />
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {aiCost.byTask.map((usage) => (
              <li key={usage.task}>
                {copy.ai.tasks[usage.task] ?? usage.task}: {copy.ai.calls(usage.calls)} ·{' '}
                {copy.ai.tokens(format.integer(usage.inputTokens + usage.outputTokens))}
              </li>
            ))}
            <li>
              {copy.ai.attributed(
                format.usd(aiCost.attributedToCasesUsd),
                aiCost.casesWithAttributedCost,
              )}
            </li>
            {aiCost.reviewRuns === 0 ? null : (
              <li>{copy.ai.perReviewRun(format.usd(aiCost.perReviewRunUsd), aiCost.reviewRuns)}</li>
            )}
          </ul>
        </>
      )}
    </Panel>
  );
}

function MetricsSkeleton({ copy }: { readonly copy: MetricsCopy }): ReactNode {
  return (
    <div aria-busy="true" aria-label={copy.loading} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((key) => (
          <Skeleton key={key} className="h-[86px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

/**
 * "Metrics" (HIP-141): what happened to the cases of a period, as tiles and
 * small to-scale charts. The period presets count back from the API's
 * clock (the simulated date in the demo).
 */
export function MetricsPage({ locale }: { readonly locale?: MetricsLocale }): ReactNode {
  const copy = metricsCopy(locale);
  const format = metricsFormat(locale);
  const now = useNow();
  const [searchParams, setSearchParams] = useSearchParams();
  const preset = presetOf(searchParams.get('days'));
  // Whole minutes: on a real clock the query key moves once a minute, not every render.
  const anchor = Math.floor(now.getTime() / 60_000) * 60_000;
  const from = new Date(anchor - preset * DAY_MS).toISOString();
  const metrics = useMetrics({ from });

  function handlePreset(event: MouseEvent<HTMLButtonElement>): void {
    const days = event.currentTarget.dataset['days'];
    if (days !== undefined) setSearchParams({ days }, { replace: true });
  }
  function handleRetry(): void {
    void metrics.refetch();
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex max-w-2xl flex-col gap-1">
          <h1 id={TITLE_ID} className="text-xl font-semibold tracking-tight text-fg">
            {copy.title}
          </h1>
          <p className="text-sm text-muted">{copy.subtitle}</p>
        </div>
        <div className="flex flex-col gap-1.5 lg:items-end">
          <div
            role="group"
            aria-label={copy.periodLegend}
            className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1 shadow-card"
          >
            {METRICS_PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                data-days={days}
                aria-pressed={preset === days}
                onClick={handlePreset}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
                  preset === days
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted hover:bg-surface-2 hover:text-fg',
                )}
              >
                {copy.preset(days)}
              </button>
            ))}
          </div>
          {metrics.data ? (
            <p className="text-xs text-muted tabular-nums">
              {copy.periodRange(
                format.date(metrics.data.period.from),
                format.date(metrics.data.asOf),
              )}
            </p>
          ) : null}
        </div>
      </header>

      {metrics.isPending ? (
        <MetricsSkeleton copy={copy} />
      ) : metrics.isError ? (
        <ErrorState error={metrics.error} onRetry={handleRetry} title={copy.errorTitle} />
      ) : (
        <div
          className={cx(
            'flex flex-col gap-4 transition-opacity',
            metrics.isPlaceholderData && 'opacity-60',
          )}
        >
          <Tiles metrics={metrics.data} copy={copy} format={format} />
          {metrics.data.cases.opened === 0 ? (
            <EmptyState
              icon={<BarChart3 className="size-5" aria-hidden="true" />}
              title={copy.empty.title}
            >
              {copy.empty.body}
            </EmptyState>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <Funnel metrics={metrics.data} copy={copy} />
            <Timing metrics={metrics.data} copy={copy} />
            <Dismissals metrics={metrics.data} copy={copy} />
            <Extraction metrics={metrics.data} copy={copy} format={format} />
            <AiCost metrics={metrics.data} copy={copy} format={format} />
          </div>
        </div>
      )}
    </div>
  );
}
