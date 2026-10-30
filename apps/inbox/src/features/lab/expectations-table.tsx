import type { ReactNode } from 'react';
import type { ExpectationStatus, LabExpectationView } from '../../api/contract.ts';
import { LayerChip } from '../../components/case-badges.tsx';
import { EmptyState } from '../../components/states.tsx';
import { Badge, type Tone } from '../../components/ui.tsx';
import { ClipboardList } from 'lucide-react';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';

const STATUS_TONES: Record<ExpectationStatus, Tone> = {
  open: 'info',
  expired: 'danger',
  fulfilled: 'success',
  superseded: 'neutral',
  cancelled: 'neutral',
};

/** A row's change since the evaluator's previous action, for the highlight. */
export type ExpectationChange = 'new' | 'updated' | 'unchanged';

function changeOf(
  item: LabExpectationView,
  previous: ReadonlyMap<string, ExpectationStatus> | undefined,
): ExpectationChange {
  if (previous === undefined) return 'unchanged';
  const was = previous.get(item.id);
  if (was === undefined) return 'new';
  return was === item.status ? 'unchanged' : 'updated';
}

/**
 * The lab patient's expectations (docs/deploy.md#hosted-demo), with what
 * changed since the evaluator's previous action highlighted: new rows (not
 * seen before) and rows whose status changed carry a badge and a tinted
 * background; everything else reads plainly.
 */
export function ExpectationsTable({
  items,
  previousStatuses,
}: {
  readonly items: readonly LabExpectationView[];
  readonly previousStatuses: ReadonlyMap<string, ExpectationStatus> | undefined;
}): ReactNode {
  const t = useT();
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList className="size-5" aria-hidden="true" />}
        title={t.lab.expectationsEmpty}
      />
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {items.map((item) => {
        const change = changeOf(item, previousStatuses);
        return (
          <li
            key={item.id}
            className={cx(
              'flex flex-col gap-1.5 px-3 py-2.5',
              change === 'new' && 'bg-primary-soft/40',
              change === 'updated' && 'bg-warning-soft/40',
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap items-center gap-2 text-sm text-fg">
                <LayerChip layer={item.layer} />
                {item.label}
                {change === 'new' ? <Badge tone="primary">{t.common.newBadge}</Badge> : null}
                {change === 'updated' ? (
                  <Badge tone="warning">{t.common.updatedBadge}</Badge>
                ) : null}
                {item.origin === 'backfill' ? (
                  <Badge tone="info">{t.lab.history.originBackfill}</Badge>
                ) : null}
              </span>
              <Badge tone={STATUS_TONES[item.status]}>
                {t.labels.expectationStatuses[item.status]}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>{t.lab.due(formatDate(item.dueAt))}</span>
              {item.closedReasonLabel ? (
                <span className="font-medium text-fg">{item.closedReasonLabel}</span>
              ) : null}
              <span>{item.ruleId}</span>
              {item.ruleVersion ? <span>{t.lab.ruleVersion(item.ruleVersion)}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
