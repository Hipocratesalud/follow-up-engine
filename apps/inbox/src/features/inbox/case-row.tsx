import { ChevronRight, History } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { CaseView, Layer } from '../../api/contract.ts';
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
import { useNow } from '../../api/queries.ts';
import { type Messages, messages, useT } from '../../i18n/index.ts';
import { daysAgo, formatOverdue, formatShortDate, initials } from '../../lib/format.ts';

/** A live case opened this recently (API clock) is marked "New". */
export const NEW_CASE_DAYS = 7;

/**
 * New to the team: opened by the engine from a recent consultation in the
 * last {@link NEW_CASE_DAYS} days. Backfill cases are history, never new.
 */
export function isNewCase(item: CaseView, now: Date): boolean {
  return item.origin === 'live' && daysAgo(item.openedAt, now) <= NEW_CASE_DAYS;
}

const AVATAR_TONES: Record<CaseView['priorityBand'], string> = {
  urgent: 'bg-danger-soft text-danger',
  high: 'bg-warning-soft text-warning',
  medium: 'bg-info-soft text-info',
  low: 'bg-surface-2 text-muted',
};

/** "58 y · F": age and sex, as short as a list row needs. */
export function patientMeta(patient: CaseView['patient'], t: Messages = messages()): string {
  const parts: string[] = [];
  if (patient.age !== undefined) parts.push(t.caseRow.age(patient.age));
  if (patient.sex === 'female') parts.push(t.labels.sexShort.female);
  if (patient.sex === 'male') parts.push(t.labels.sexShort.male);
  return parts.join(t.common.separator);
}

/**
 * When a held case enters the inbox: "Enters the inbox tomorrow (Jan 6)",
 * "… on Jan 9". A held case with no release day is too old to notify: it
 * waits here until the team picks it.
 */
export function releaseLabel(t: Messages, releaseAt: string | undefined, now: Date): string {
  if (releaseAt === undefined) return t.caseRow.releaseNever;
  const days = daysAgo(now.toISOString(), new Date(releaseAt));
  const date = formatShortDate(releaseAt);
  if (days <= 0) return t.caseRow.releaseToday(date);
  if (days === 1) return t.caseRow.releaseTomorrow(date);
  return t.caseRow.releaseOn(date);
}

function uniqueLayers(item: CaseView): Layer[] {
  return [...new Set(item.reasons.map((reason) => reason.layer))];
}

/** One of the case's reasons comes from a protocol the clinical team has not validated yet. */
function hasDraftProtocol(item: CaseView): boolean {
  return item.reasons.some((reason) => isDraftProtocol(reason.protocol));
}

export function CaseRow({
  item,
  to,
  selected = false,
  showRelease = false,
  isNew = false,
}: {
  readonly item: CaseView;
  readonly to: string;
  readonly selected?: boolean;
  readonly showRelease?: boolean;
  readonly isNew?: boolean;
}): ReactNode {
  const t = useT();
  const now = useNow();
  const top = item.reasons[0];
  const extra = item.reasons.length - 1;
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
          {uniqueLayers(item).map((layer) => (
            <LayerChip key={layer} layer={layer} />
          ))}
          {hasDraftProtocol(item) ? <DraftProtocolBadge describe={false} /> : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {top ? (
            <span className={cx('font-medium', overdueTone(top.overdueDays))}>
              {formatOverdue(top.overdueDays, top.dueAt, now)}
            </span>
          ) : null}
          <StatusBadge status={item.status} />
          {item.escalation.currentStep > 0 ? (
            <EscalationMeter escalation={item.escalation} />
          ) : null}
          {showRelease ? (
            <span className="inline-flex items-center gap-1 font-medium text-info">
              <History className="size-3" aria-hidden="true" />
              {releaseLabel(t, item.releaseAt, now)}
            </span>
          ) : null}
          {item.assignee ? (
            <span className="max-w-full min-w-0 truncate text-muted">{item.assignee}</span>
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

export function CaseRowSkeleton(): ReactNode {
  return (
    <div className="flex gap-3 px-3.5 py-3" aria-hidden="true">
      <div className="skeleton size-9 rounded-full" />
      <div className="flex flex-1 flex-col gap-2">
        <div className="skeleton h-4 w-2/5" />
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-4 w-3/5" />
      </div>
    </div>
  );
}
