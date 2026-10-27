import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { LAYERS, type InboxStats } from '../api/contract.ts';
import { useStats } from '../api/queries.ts';
import { formatPercent, formatUsd } from '../lib/format.ts';
import { LAYER_LABELS, noteReader } from '../lib/labels.ts';
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

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function StatsTiles({ stats }: { readonly stats: InboxStats }): ReactNode {
  const escalated = stats.byStatus['escalated'] ?? 0;
  const snoozed = stats.byStatus['snoozed'] ?? 0;
  return (
    <dl className="grid grid-cols-2 gap-3 xl:grid-cols-[0.9fr_1.5fr_1fr_1.3fr]">
      <Tile label="Casos activos">
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {stats.activeCases}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {plural(escalated, 'escalado', 'escalados')} ·{' '}
          {plural(snoozed, 'pospuesto', 'pospuestos')}
        </p>
      </Tile>
      <Tile label="Por capa" className="order-last col-span-2 xl:order-none xl:col-span-1">
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          {LAYERS.map((layer) => (
            <li key={layer} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${LAYER_DOT[layer]}`}
              />
              <span className="min-w-0 flex-1 truncate text-muted">{LAYER_LABELS[layer]}</span>
              <span className="font-semibold text-fg tabular-nums">{stats.byLayer[layer]}</span>
            </li>
          ))}
        </ul>
      </Tile>
      <Tile label="Utilidad según el equipo">
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {formatPercent(stats.feedback.usefulRate)}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          de {stats.feedback.total} casos calificados como útiles
        </p>
      </Tile>
      <Tile
        className="col-span-2 xl:col-span-1"
        label={
          <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            Costo de IA del mes
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-layer-plan-soft px-1.5 py-0.5 text-[11px] font-medium text-layer-plan">
              <Sparkles className="size-3" aria-hidden="true" />
              {noteReader(stats.llm).label}
            </span>
          </span>
        }
      >
        <p className="text-xl font-semibold tracking-tight text-fg tabular-nums">
          {formatUsd(stats.llm.monthCostUsd)}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {stats.llm.calls} notas leídas · {formatUsd(stats.llm.avgCostPerNoteUsd)} por nota
        </p>
      </Tile>
    </dl>
  );
}

export function StatsBar(): ReactNode {
  const stats = useStats();
  function handleRetry(): void {
    void stats.refetch();
  }
  if (stats.isPending) {
    return (
      <div
        className="grid grid-cols-2 gap-3 xl:grid-cols-4"
        aria-busy="true"
        aria-label="Cargando resumen"
      >
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-[84px] rounded-xl" />
        ))}
      </div>
    );
  }
  if (stats.isError) {
    return (
      <ErrorState error={stats.error} onRetry={handleRetry} title="No pudimos cargar el resumen" />
    );
  }
  return (
    <section aria-label="Resumen">
      <StatsTiles stats={stats.data} />
    </section>
  );
}
