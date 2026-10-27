import { ChevronRight, Layers3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PatientQueueItem } from '../../api/patient-queue-contract.ts';
import { useNow } from '../../api/queries.ts';
import {
  DraftProtocolBadge,
  EscalationMeter,
  LayerChip,
  PriorityBadge,
  StatusBadge,
  isDraftProtocol,
  overdueTone,
} from '../../components/case-badges.tsx';
import { Badge } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { daysAgo, formatOverdue, initials } from '../../lib/format.ts';
import { useT } from '../../i18n/index.ts';
import { NEW_CASE_DAYS, patientMeta } from '../inbox/case-row.tsx';

const AVATAR_TONES: Record<PatientQueueItem['priorityBand'], string> = {
  urgent: 'bg-danger-soft text-danger',
  high: 'bg-warning-soft text-warning',
  medium: 'bg-info-soft text-info',
  low: 'bg-surface-2 text-muted',
};

/**
 * New to the team: a live case of the patient opened in the last
 * {@link NEW_CASE_DAYS} days. Backfill cases are history, never new.
 */
export function isNewPatient(item: PatientQueueItem, now: Date): boolean {
  return item.origin === 'live' && daysAgo(item.latestOpenedAt, now) <= NEW_CASE_DAYS;
}

/** The case whose escalation the card's meter shows: the one furthest along. */
function furthestEscalation(item: PatientQueueItem) {
  return [...item.cases].sort(
    (left, right) => right.escalation.currentStep - left.escalation.currentStep,
  )[0]?.escalation;
}

/**
 * One card of the inbox: a patient with every reason of every active case
 * (HIP-141). The title is the most urgent reason; badges name every layer and
 * protocol behind the reasons.
 */
export function PatientRow({
  item,
  to,
  selected = false,
  isNew = false,
}: {
  readonly item: PatientQueueItem;
  readonly to: string;
  readonly selected?: boolean;
  readonly isNew?: boolean;
}): ReactNode {
  const t = useT();
  const now = useNow();
  const top = item.topReason;
  const extra = item.reasonCount - 1;
  const escalation = furthestEscalation(item);
  const draft = item.protocols.some((protocol) => isDraftProtocol(protocol));
  const named = item.protocols.filter((protocol) => protocol.name !== undefined);
  return (
    <Link
      to={to}
      aria-current={selected ? 'page' : undefined}
      className={cx(
        'group relative flex gap-3 rounded-xl border px-3.5 py-3 transition-colors',
        selected
          ? 'border-primary/50 bg-primary-soft/60 shadow-card'
          : isNew
            ? 'border-primary/30 bg-primary-soft/25 hover:bg-surface'
            : 'border-transparent hover:border-border hover:bg-surface',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold',
          AVATAR_TONES[item.priorityBand],
        )}
      >
        {initials(item.patient.name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-fg">
              {item.patient.name}
            </span>
            <span className="block text-xs text-muted">{patientMeta(item.patient, t)}</span>
          </span>
          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {isNew ? <Badge tone="primary">{t.common.newBadge}</Badge> : null}
            <PriorityBadge band={item.priorityBand} priority={item.priority} />
          </span>
        </span>
        {top ? (
          <span className="text-sm break-words text-fg">
            {top.label}
            {extra > 0 ? (
              <span className="ml-1.5 text-xs font-medium whitespace-nowrap text-muted">
                {t.caseRow.moreReasons(extra)}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="flex flex-wrap items-center gap-1.5">
          {item.caseCount > 1 ? (
            <Badge tone="neutral" icon={<Layers3 className="size-3" aria-hidden="true" />}>
              {t.patientCard.cases(item.caseCount)}
            </Badge>
          ) : null}
          {item.layers.map((layer) => (
            <LayerChip key={layer} layer={layer} />
          ))}
          {named.map((protocol) => (
            <span
              key={protocol.id}
              className="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted"
            >
              {protocol.name}
            </span>
          ))}
          {draft ? <DraftProtocolBadge describe={false} /> : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {top ? (
            <span className={cx('font-medium', overdueTone(top.overdueDays))}>
              {formatOverdue(top.overdueDays, top.dueAt, now)}
            </span>
          ) : null}
          <StatusBadge status={item.status} />
          {escalation !== undefined && escalation.currentStep > 0 ? (
            <EscalationMeter escalation={escalation} />
          ) : null}
          {item.assignees.length > 0 ? (
            <span className="max-w-full min-w-0 truncate text-muted">
              {item.assignees.join(', ')}
            </span>
          ) : null}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="mt-2 size-4 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 lg:hidden"
      />
    </Link>
  );
}
