import {
  ArrowLeft,
  Bot,
  CalendarX,
  Check,
  CircleDashed,
  CircleUser,
  Clock,
  Cog,
  Lightbulb,
  MessageSquareOff,
  MessageSquareText,
  Minus,
  ScrollText,
  StickyNote,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type {
  CaseDetail,
  CaseReasonView,
  CaseTimelineEntry,
  EscalationView,
} from '../../api/contract.ts';
import { ACTIVE_CASE_STATUSES } from '../../api/contract.ts';
import { useCase, useNow } from '../../api/queries.ts';
import {
  EscalationMeter,
  LayerChip,
  PriorityBadge,
  ReasonProtocol,
  StatusBadge,
  overdueTone,
} from '../../components/case-badges.tsx';
import { EvidenceExcerpt } from '../../components/evidence.tsx';
import { ErrorState } from '../../components/states.tsx';
import { Badge, Card, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { type Messages, useT } from '../../i18n/index.ts';
import { formatDate, formatDateTime, formatOverdue, formatRelative } from '../../lib/format.ts';
import { actorLabel } from '../../lib/labels.ts';
import { patientMeta } from '../inbox/case-row.tsx';
import { CASE_CLOSED_NOTICE_ID, CASE_TITLE_ID, CaseActions } from './case-actions.tsx';
import {
  CallTask,
  ContactFlagNotice,
  ContactTimeline,
  DismissalSummary,
} from './contact-panel.tsx';
import { FeedbackPanel } from './feedback-panel.tsx';
import { ReasonRuleVersion } from '../metrics/rule-version.tsx';
import { PlanItemReview } from '../plan-items/plan-item-review.tsx';
import { PatientDocumentsProvider, ViewDocumentsButton } from '../why/documents-drawer.tsx';
import { WhyThis } from '../why/why-this.tsx';

/** "Result — HbA1c"; just the display when it already names the type ("Clinical note of ..."). */
function sourceLabel(t: Messages, source: CaseReasonView['source']): string {
  const type = t.labels.sourceTypes[source.resourceType] ?? t.labels.sourceTypeFallback;
  return source.display.startsWith(type) ? source.display : t.labels.source(type, source.display);
}

function ReasonCard({
  reason,
  now,
}: {
  readonly reason: CaseReasonView;
  readonly now: Date;
}): ReactNode {
  const t = useT();
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <LayerChip layer={reason.layer} />
        <span className={cx('text-xs font-medium', overdueTone(reason.overdueDays))}>
          {formatOverdue(reason.overdueDays, reason.dueAt, now)}
        </span>
      </div>
      <div>
        <h3 className="text-[15px] font-semibold text-fg">{reason.label}</h3>
        <p className="mt-1 text-xs text-muted">
          {t.caseDetail.dueBefore(formatDate(reason.dueAt))}
          {t.common.separator}
          {t.caseDetail.origin(sourceLabel(t, reason.source))}
        </p>
      </div>
      <ReasonProtocol protocol={reason.protocol} />
      <ReasonRuleVersion
        ruleId={reason.ruleId}
        ruleVersion={reason.ruleVersion}
        protocol={reason.protocol}
      />
      {reason.evidence ? <EvidenceExcerpt evidence={reason.evidence} /> : null}
      {reason.planItem ? (
        <PlanItemReview
          expectationId={reason.expectationId}
          item={reason.planItem}
          dueAt={reason.dueAt}
        />
      ) : null}
      <WhyThis why={reason.why} label={reason.label} />
    </li>
  );
}

const ACTOR_ICONS = {
  rule: ScrollText,
  user: UserRound,
  patient: CircleUser,
  system: Cog,
} as const;

function Timeline({
  entries,
  now,
}: {
  readonly entries: readonly CaseTimelineEntry[];
  readonly now: Date;
}): ReactNode {
  const t = useT();
  return (
    <ol className="relative flex flex-col gap-4 pl-1">
      {entries.map((entry, index) => {
        const Icon = ACTOR_ICONS[entry.actor.type];
        return (
          <li key={`${entry.at}-${entry.type}-${String(index)}`} className="relative flex gap-3">
            {index < entries.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-8 bottom-[-12px] left-[13px] w-px bg-border"
              />
            ) : null}
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-muted">
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-sm text-fg">{entry.label}</p>
              {entry.note ? (
                <p className="mt-1.5 flex gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg">
                  <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden="true" />
                  <span>
                    <span className="sr-only">{t.caseDetail.internalNote}</span>
                    {entry.note}
                  </span>
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-muted">
                {actorLabel(t, entry.actor)}
                {t.common.separator}
                <time dateTime={entry.at}>{formatDateTime(entry.at)}</time> (
                {formatRelative(entry.at, now)})
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** What a step of the escalation meter says: done, skipped, or when it will run. */
function stepState(
  t: Messages,
  escalation: EscalationView,
  index: number,
  step: EscalationView['steps'][number],
  active: boolean,
): string {
  const copy = t.caseDetail;
  if (index < escalation.currentStep) {
    if (step.outcome === 'skipped') return copy.stepSkipped;
    return step.at ? copy.stepDoneOn(formatDate(step.at)) : copy.stepDone;
  }
  const isNext = index === escalation.currentStep && escalation.next;
  if (isNext && escalation.next) return copy.stepScheduled(formatDate(escalation.next.at));
  if (step.scheduledAt) return copy.stepPlanned(formatDate(step.scheduledAt));
  if (!active) return copy.stepNeverRan;
  return step.afterDays === 0 ? copy.stepOnEntry : copy.stepAfterDays(step.afterDays);
}

/** The case's escalation policy, step by step: what already happened, what was skipped, what comes next. */
function EscalationSteps({
  escalation,
  active,
}: {
  readonly escalation: EscalationView;
  readonly active: boolean;
}): ReactNode {
  const t = useT();
  return (
    <ol className="flex flex-col gap-2">
      {escalation.steps.map((step, index) => {
        const passed = index < escalation.currentStep;
        const isNext = !passed && index === escalation.currentStep && escalation.next;
        const state = stepState(t, escalation, index, step, active);
        const Icon = passed
          ? step.outcome === 'skipped'
            ? Minus
            : Check
          : isNext
            ? Clock
            : CircleDashed;
        return (
          <li key={`${step.action}-${String(index)}`} className="flex items-start gap-2.5">
            <span
              className={cx(
                'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full',
                passed && step.outcome !== 'skipped'
                  ? 'bg-primary-soft text-primary'
                  : isNext
                    ? 'bg-warning-soft text-warning'
                    : 'bg-surface-2 text-muted',
              )}
            >
              <Icon className="size-3" aria-hidden="true" />
            </span>
            <span className="min-w-0 text-sm">
              <span className={cx('font-medium', passed || isNext ? 'text-fg' : 'text-muted')}>
                {step.label}
              </span>
              <span className="block text-xs text-muted">{state}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ContactStatus({
  detail,
  now,
}: {
  readonly detail: CaseDetail;
  readonly now: Date;
}): ReactNode {
  const t = useT();
  const { patientContact } = detail;
  const blocked = !patientContact.allowed || patientContact.optedOut;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {blocked ? (
          <Badge tone="warning" icon={<MessageSquareOff className="size-3" aria-hidden="true" />}>
            {patientContact.optedOut ? t.caseDetail.noMessages : t.caseDetail.contactNotAllowed}
          </Badge>
        ) : (
          <Badge tone="success" icon={<MessageSquareText className="size-3" aria-hidden="true" />}>
            {t.caseDetail.contactAllowed}
          </Badge>
        )}
        <span className="text-muted">
          {patientContact.lastContactAt
            ? t.caseDetail.lastContact(formatRelative(patientContact.lastContactAt, now))
            : t.caseDetail.noContacts}
        </span>
      </div>
      {patientContact.contactFlag ? (
        <ContactFlagNotice flag={patientContact.contactFlag} now={now} />
      ) : null}
    </div>
  );
}

export function CaseDetailView({
  detail,
  backTo,
  embedded = false,
}: {
  readonly detail: CaseDetail;
  readonly backTo?: string;
  /**
   * Inside the patient card (HIP-141): the patient's header, contact status
   * and contact request are the card's; the case keeps its own actions.
   */
  readonly embedded?: boolean;
}): ReactNode {
  const t = useT();
  const now = useNow();
  const active = (ACTIVE_CASE_STATUSES as readonly string[]).includes(detail.status);
  const planReasons = detail.reasons.filter((reason) => reason.evidence).length;
  const heading = useRef<HTMLHeadingElement>(null);
  const closedNotice = useRef<HTMLDivElement>(null);
  const wasActive = useRef(active);

  // Resolving or dismissing removes the action buttons with their dialog:
  // the keyboard lands on what replaced them, not on <body>.
  useEffect(() => {
    if (wasActive.current && !active) closedNotice.current?.focus();
    wasActive.current = active;
  }, [active]);

  // Opening a case moves the keyboard focus to it (not left on the list row),
  // without scrolling the page away from the list unless the title is hidden.
  useEffect(() => {
    const element = heading.current;
    if (element === null || embedded) return;
    element.focus({ preventScroll: true });
    const { top, bottom } = element.getBoundingClientRect();
    if (top < 0 || bottom > globalThis.innerHeight) element.scrollIntoView({ block: 'nearest' });
  }, [detail.id, embedded]);

  const Wrapper = embedded ? 'div' : 'article';
  return (
    <PatientDocumentsProvider patientId={detail.patient.id} patientName={detail.patient.name}>
      <Wrapper
        {...(embedded ? {} : { 'aria-labelledby': CASE_TITLE_ID })}
        className="flex flex-col gap-4"
      >
        {backTo && !embedded ? (
          <Link
            to={backTo}
            className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg lg:hidden"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t.common.backToInbox}
          </Link>
        ) : null}

        {embedded ? null : (
          <Card className="flex flex-col gap-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2
                  id={CASE_TITLE_ID}
                  ref={heading}
                  tabIndex={-1}
                  className="text-lg font-semibold tracking-tight text-fg outline-none"
                >
                  {detail.patient.name}
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  {[
                    patientMeta(detail.patient, t),
                    detail.assignee ? t.caseDetail.owner(detail.assignee) : '',
                  ]
                    .filter(Boolean)
                    .join(t.common.separator)}
                </p>
              </div>
              <Link
                to={`/patients/${detail.patient.id}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
              >
                <UserRound className="size-3.5" aria-hidden="true" />
                {t.common.viewPatient}
              </Link>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={detail.status} />
              <PriorityBadge band={detail.priorityBand} priority={detail.priority} />
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
                <EscalationMeter escalation={detail.escalation} showLabel />
              </span>
              {detail.origin === 'backfill' ? (
                <Badge tone="info">{t.caseDetail.recovered}</Badge>
              ) : null}
              <span className="text-xs text-muted">
                {t.caseDetail.openedAgo(formatRelative(detail.openedAt, now))}
              </span>
            </div>
            <ContactStatus detail={detail} now={now} />
          </Card>
        )}

        {/* One primary action per view: a pending call comes first. */}
        {active && detail.callTask ? (
          <CallTask caseId={detail.id} task={detail.callTask} patientName={detail.patient.name} />
        ) : null}

        {active ? (
          <Card
            className={cx(
              'flex flex-col gap-4 p-5',
              detail.callTask === undefined && 'border-primary/30',
            )}
          >
            <div className="flex gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                <Lightbulb className="size-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-fg">{t.caseDetail.suggestedStep}</h3>
                <p className="mt-1 text-sm text-muted">{detail.suggestedAction}</p>
                {detail.status === 'snoozed' && detail.snoozedUntil ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                    <CalendarX className="size-3.5" aria-hidden="true" />
                    {t.caseDetail.snoozedUntil(formatDate(detail.snoozedUntil))}
                  </p>
                ) : null}
              </div>
            </div>
            <CaseActions detail={detail} withContactRequest={!embedded} />
          </Card>
        ) : (
          <Card className="p-0">
            <div
              ref={closedNotice}
              id={CASE_CLOSED_NOTICE_ID}
              tabIndex={-1}
              role="status"
              className="flex items-center gap-3 rounded-xl p-4 text-sm text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <StatusBadge status={detail.status} />
              {t.caseDetail.closedNotice(t.labels.statuses[detail.status].toLowerCase())}
            </div>
          </Card>
        )}

        <section aria-labelledby="reasons-title" className="flex flex-col gap-3">
          <SectionTitle
            id="reasons-title"
            count={detail.reasons.length}
            action={<ViewDocumentsButton />}
          >
            {t.caseDetail.reasons}
          </SectionTitle>
          {planReasons > 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Bot className="size-3.5 text-layer-plan" aria-hidden="true" />
              {t.caseDetail.quotesNote}
            </p>
          ) : null}
          <ul className="flex flex-col gap-3">
            {detail.reasons.map((reason) => (
              <ReasonCard key={reason.expectationId} reason={reason} now={now} />
            ))}
          </ul>
        </section>

        <Card className="flex flex-col gap-3 p-5" aria-labelledby="escalation-title">
          <SectionTitle id="escalation-title">{t.caseDetail.escalation}</SectionTitle>
          <p className="text-xs text-muted">{t.caseDetail.escalationIntro}</p>
          {detail.status === 'snoozed' && detail.snoozedUntil ? (
            <p className="flex items-start gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-fg">
              <CalendarX className="mt-px size-3.5 shrink-0 text-muted" aria-hidden="true" />
              {t.caseDetail.escalationSnoozed(formatDate(detail.snoozedUntil))}
            </p>
          ) : null}
          <EscalationSteps escalation={detail.escalation} active={active} />
        </Card>

        <ContactTimeline attempts={detail.contactAttempts} now={now} />

        {detail.status === 'dismissed' ? (
          detail.dismissal ? (
            <DismissalSummary dismissal={detail.dismissal} patientId={detail.patient.id} />
          ) : null
        ) : (
          <Card className="flex flex-col gap-3 p-5">
            <h3 className="text-sm font-semibold text-fg">{t.caseDetail.feedbackTitle}</h3>
            <FeedbackPanel caseId={detail.id} feedback={detail.feedback} />
          </Card>
        )}

        <Card className="flex flex-col gap-4 p-5" aria-labelledby="timeline-title">
          <SectionTitle id="timeline-title">{t.caseDetail.history}</SectionTitle>
          <Timeline entries={detail.timeline} now={now} />
        </Card>
      </Wrapper>
    </PatientDocumentsProvider>
  );
}

function CaseDetailSkeleton(): ReactNode {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t.caseDetail.loading} className="flex flex-col gap-4">
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
      <Skeleton className="h-56 rounded-xl" />
    </div>
  );
}

export function CaseDetailPanel({
  caseId,
  backTo,
}: {
  readonly caseId: string;
  readonly backTo?: string;
}): ReactNode {
  const t = useT();
  const query = useCase(caseId);
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) return <CaseDetailSkeleton />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={handleRetry}
        title={t.caseDetail.error}
        notFoundTitle={t.caseDetail.notFound}
      />
    );
  }
  return <CaseDetailView detail={query.data} {...(backTo ? { backTo } : {})} />;
}
