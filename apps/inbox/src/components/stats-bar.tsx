import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { LAYERS, type InboxStats } from '../api/contract.ts';
import { useStats } from '../api/queries.ts';
import { useT } from '../i18n/index.ts';
import { formatPercent, formatUsd } from '../lib/format.ts';
import { noteReader } from '../lib/labels.ts';
import { LAYER_DOT } from './case-badges.tsx';
import { ErrorState } from './states.tsx';
import { Skeleton } from './ui.tsx';

function Tile({
  label,
  children,
  className,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={`${className ?? ''} flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-surface px-4 py-3 shadow-card`}
    >
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function StatsTiles({ stats }: { readonly stats: InboxStats }): ReactNode {
  const t = useT();
  const reader = noteReader(t, stats.llm);
  const escalated = stats.byStatus['escalated'] ?? 0;
  const snoozed = stats.byStatus['snoozed'] ?? 0;
  return (
    <dl className="grid grid-cols-2 gap-3 xl:grid-cols-[0.9fr_1.5fr_1fr_1.3fr]">
      <Tile label={t.stats.activePatients}>
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {stats.activePatients}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t.stats.cases(stats.activeCases)}
          {t.common.separator}
          {t.stats.escalated(escalated)}
          {t.common.separator}
          {t.stats.snoozed(snoozed)}
        </p>
      </Tile>
      <Tile label={t.stats.byLayer} className="order-last col-span-2 xl:order-none xl:col-span-1">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {LAYERS.map((layer) => (
            <li key={layer} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${LAYER_DOT[layer]}`}
              />
              <span className="min-w-0 flex-1 truncate text-muted">{t.labels.layers[layer]}</span>
              <span className="font-semibold text-fg tabular-nums">{stats.byLayer[layer]}</span>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile label={t.stats.usefulness}>
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {stats.feedback.total === 0 ? t.common.noValue : formatPercent(stats.feedback.usefulRate)}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {stats.feedback.total === 0 ? t.stats.noFeedback : t.stats.usefulOf(stats.feedback.total)}
        </p>
      </Tile>
      <Tile
        className="col-span-2 xl:col-span-1"
        label={
          <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            {reader.simulated ? t.stats.readingCost : t.stats.aiCost}
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-layer-plan-soft px-1.5 py-0.5 text-[11px] font-medium text-layer-plan">
              <Sparkles className="size-3" aria-hidden="true" />
              {reader.label}
            </span>
          </span>
        }
      >
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {formatUsd(stats.llm.monthCostUsd)}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {t.stats.notesRead(stats.llm.calls)}
          {t.common.separator}
          {t.stats.perNote(formatUsd(stats.llm.avgCostPerNoteUsd))}
        </p>
      </Tile>
    </dl>
  );
}

export function StatsBar(): ReactNode {
  const t = useT();
  const stats = useStats();
  function handleRetry(): void {
    void stats.refetch();
  }
  if (stats.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
        aria-busy="true"
        aria-label={t.stats.loading}
      >
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[84px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (stats.isError) {
    return <ErrorState error={stats.error} onRetry={handleRetry} title={t.stats.error} />;
  }
  return (
    <section aria-label={t.stats.region}>
      <StatsTiles stats={stats.data} />
    </section>
  );
}
