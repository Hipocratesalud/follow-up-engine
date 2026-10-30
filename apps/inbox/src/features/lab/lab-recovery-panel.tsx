import { History, PartyPopper } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CaseView } from '../../api/contract.ts';
import { useLabClock, useLabRecovery, useNow } from '../../api/queries.ts';
import { LayerChip, PriorityBadge } from '../../components/case-badges.tsx';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { Badge, Card, Skeleton } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { releaseLabel } from '../inbox/case-row.tsx';

function RecoveryRow({ item, now }: { readonly item: CaseView; readonly now: Date }): ReactNode {
  const t = useT();
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-fg">
          <span className="font-medium">{item.patient.name}</span>
          <Badge tone="info">{t.lab.history.originBackfill}</Badge>
        </span>
        <PriorityBadge band={item.priorityBand} priority={item.priority} />
      </div>
      <ul className="flex flex-col gap-1">
        {item.reasons.map((reason) => (
          <li key={reason.expectationId} className="flex flex-wrap items-center gap-2 text-sm">
            <LayerChip layer={reason.layer} />
            <span className="text-fg">{reason.label}</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 font-medium text-info">
          <History className="size-3" aria-hidden="true" />
          {releaseLabel(t, item.releaseAt, now)}
        </span>
      </p>
    </li>
  );
}

/**
 * The lab's "To recover" (the inbox's recovery list, for the evaluator's
 * sandbox): cases from imported history still held, with the day the
 * daily cap releases each one, counted on the lab's own date.
 */
export function LabRecoveryPanel(): ReactNode {
  const t = useT();
  const clock = useLabClock();
  const recovery = useLabRecovery();
  const fallback = useNow();
  // Release days count on the lab's own date, never the shared demo's.
  const now = clock.data === undefined ? fallback : new Date(clock.data.now);

  function handleRetry(): void {
    void recovery.refetch();
  }

  return (
    <Card className="flex flex-col gap-3 p-5" aria-labelledby="lab-recovery-title">
      <div>
        <h2
          id="lab-recovery-title"
          className="flex items-center gap-2 text-base font-semibold text-fg"
        >
          <History className="size-4 text-info" aria-hidden="true" />
          {t.lab.history.recoveryTitle}
          {recovery.data && recovery.data.total > 0 ? (
            <Badge tone="info">{t.lab.history.recoveryCount(recovery.data.total)}</Badge>
          ) : null}
        </h2>
        <p className="mt-1 text-sm text-muted">{t.lab.history.recoveryIntro}</p>
      </div>
      {recovery.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
        </div>
      ) : recovery.isError ? (
        <ErrorState error={recovery.error} onRetry={handleRetry} className="py-4" />
      ) : recovery.data.items.length === 0 ? (
        <EmptyState
          icon={<PartyPopper className="size-5" aria-hidden="true" />}
          title={t.lab.history.recoveryEmpty}
          className="py-6"
        >
          {t.lab.history.recoveryEmptyBody}
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {recovery.data.items.map((item) => (
            <RecoveryRow key={item.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </Card>
  );
}
