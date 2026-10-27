import {
  ArrowLeft,
  BellRing,
  ChevronDown,
  Lock,
  MessageSquareOff,
  MessageSquareText,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router';
import { ACTIVE_CASE_STATUSES, type CaseView } from '../../api/contract.ts';
import type { PatientQueueItem } from '../../api/patient-queue-contract.ts';
import { usePatientCard, useRequestPatientContact } from '../../api/patient-queue-queries.ts';
import { useCase, useNow } from '../../api/queries.ts';
import { isApiError } from '../../api/client.ts';
import {
  EscalationMeter,
  PriorityBadge,
  StatusBadge,
  overdueTone,
} from '../../components/case-badges.tsx';
import { Dialog } from '../../components/dialog.tsx';
import { ErrorState, fieldError, InlineError } from '../../components/states.tsx';
import {
  Badge,
  Button,
  Card,
  Field,
  INPUT_CLASS,
  SectionTitle,
  Skeleton,
} from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatOverdue, formatRelative } from '../../lib/format.ts';
import { formatLimit, INPUT_LIMITS } from '../../lib/limits.ts';
import { CASE_TITLE_ID, patientMessagePreview } from '../case/case-actions.tsx';
import { CaseDetailPanel, CaseDetailView } from '../case/case-detail.tsx';
import { ContactFlagNotice } from '../case/contact-panel.tsx';
import { useT } from '../../i18n/index.ts';
import { patientMeta } from '../inbox/case-row.tsx';

function isActive(view: Pick<CaseView, 'status'>): boolean {
  return (ACTIVE_CASE_STATUSES as readonly string[]).includes(view.status);
}

/** The patient's contact status: whether the clinic may write, and the last contact. */
function ContactStatus({
  card,
  now,
}: {
  readonly card: PatientQueueItem;
  readonly now: Date;
}): ReactNode {
  const t = useT();
  const { patientContact } = card;
  const blocked = !patientContact.allowed || patientContact.optedOut;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {blocked ? (
          <Badge tone="warning" icon={<MessageSquareOff className="size-3" aria-hidden="true" />}>
            {patientContact.optedOut ? t.patientCard.optedOut : t.patientCard.contactNotAllowed}
          </Badge>
        ) : (
          <Badge tone="success" icon={<MessageSquareText className="size-3" aria-hidden="true" />}>
            {t.patientCard.contactAllowed}
          </Badge>
        )}
        <span className="text-muted">
          {patientContact.lastContactAt
            ? t.patientCard.lastContact(formatRelative(patientContact.lastContactAt, now))
            : t.patientCard.noContacts}
        </span>
      </div>
      {patientContact.contactFlag ? (
        <ContactFlagNotice flag={patientContact.contactFlag} now={now} />
      ) : null}
    </div>
  );
}

/**
 * "Request contact" on the patient card: one request for the patient
 * whatever the number of their cases (the engine allows one message per
 * patient per contact window, across cases).
 */
function RequestContact({ card }: { readonly card: PatientQueueItem }): ReactNode {
  const t = useT();
  const ids = useId();
  const mutation = useRequestPatientContact(card.patient.id);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string>();
  const [done, setDone] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const blocked = !card.patientContact.allowed || card.patientContact.optedOut;
  const activeCases = card.cases.filter(isActive).length;

  function handleOpen(event: MouseEvent<HTMLButtonElement>): void {
    trigger.current = event.currentTarget;
    setNote('');
    setNoteError(undefined);
    setDone(undefined);
    mutation.reset();
    setOpen(true);
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
  }

  function handleClose(): void {
    setOpen(false);
  }

  function returnFocus(): HTMLElement | null {
    return trigger.current;
  }

  function handleNoteChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setNote(event.target.value);
    setNoteError(undefined);
  }

  function handleSend(): void {
    if (mutation.isPending) return;
    const trimmed = note.trim();
    if (trimmed.length > INPUT_LIMITS.note) {
      setNoteError(t.validation.noteTooLong(formatLimit(INPUT_LIMITS.note)));
      return;
    }
    mutation.mutate(trimmed ? { note: trimmed } : {}, {
      onSuccess: () => {
        setOpen(false);
        setDone(t.patientCard.done);
      },
    });
  }

  const noteMessage = noteError ?? fieldError(mutation.error, 'note');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={handleOpen}
          icon={<BellRing className="size-4" aria-hidden="true" />}
        >
          {t.patientCard.requestContact}
        </Button>
      </div>
      <p className="text-xs text-muted">{t.patientCard.requestHint}</p>
      <p aria-live="polite" className={cx('text-sm text-success', !done && 'sr-only')}>
        {done}
      </p>
      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        returnFocus={returnFocus}
        title={t.patientCard.requestTitle}
        footer={
          <>
            <Button variant="secondary" onClick={handleClose}>
              {blocked ? t.common.gotIt : t.common.cancel}
            </Button>
            {blocked ? null : (
              <Button
                variant="primary"
                loading={mutation.isPending}
                // Pending, not validation: one click sends one request.
                disabled={mutation.isPending}
                onClick={handleSend}
              >
                {t.patientCard.requestContact}
              </Button>
            )}
          </>
        }
      >
        {blocked ? (
          <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t.patientCard.blocked(card.patient.name)}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              {t.patientCard.requestBody(card.patient.name, activeCases)}
            </p>
            <div className="rounded-lg border border-border bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">{t.caseActions.messagePreview}</p>
              <p className="mt-1.5 text-sm text-fg">
                {patientMessagePreview(t, card.patient.name)}
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                <Lock className="size-3" aria-hidden="true" />
                {t.caseActions.messagePrivacy}
              </p>
            </div>
            <Field
              label={t.caseActions.noteOptional}
              htmlFor={`${ids}-note`}
              error={noteMessage}
              hint={t.caseActions.noteHint(formatLimit(INPUT_LIMITS.note))}
            >
              <textarea
                id={`${ids}-note`}
                rows={2}
                value={note}
                maxLength={INPUT_LIMITS.note}
                onChange={handleNoteChange}
                aria-invalid={noteMessage ? true : undefined}
                aria-describedby={noteMessage ? `${ids}-note-error` : `${ids}-note-hint`}
                className={INPUT_CLASS}
              />
            </Field>
            <InlineError error={mutation.error} inlineFields={['note']} />
          </>
        )}
      </Dialog>
    </div>
  );
}

/** The open case's own detail inside the card: its reasons, actions, escalation and history. */
function FocusedCase({ caseId }: { readonly caseId: string }): ReactNode {
  const t = useT();
  const query = useCase(caseId);
  const now = useNow();
  function handleRetry(): void {
    void query.refetch();
  }
  if (query.isPending) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={handleRetry} title={t.patientCard.caseError} />;
  }
  const detail = query.data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-xs text-muted">
          <EscalationMeter escalation={detail.escalation} showLabel />
        </span>
        {detail.origin === 'backfill' ? <Badge tone="info">{t.caseDetail.recovered}</Badge> : null}
        <span className="text-xs text-muted">
          {t.caseDetail.openedAgo(formatRelative(detail.openedAt, now))}
        </span>
      </div>
      <CaseDetailView detail={detail} embedded />
    </div>
  );
}

/**
 * One case of the patient: a summary row that opens it. The open case (the
 * one the URL names) shows its full detail under its row; one at a time, so
 * the patient card reads as one patient, not a stack of case pages.
 */
function CaseSection({
  view,
  focused,
  to,
}: {
  readonly view: CaseView;
  readonly focused: boolean;
  readonly to: string;
}): ReactNode {
  const t = useT();
  const now = useNow();
  const ids = useId();
  const section = useRef<HTMLElement>(null);
  const top = view.reasons[0];

  // The case a link opened is the one in view, inside the patient card.
  useEffect(() => {
    if (!focused) return;
    const element = section.current;
    if (element === null) return;
    const { top: offset, bottom } = element.getBoundingClientRect();
    if (offset < 0 || bottom > globalThis.innerHeight) element.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  return (
    <section
      ref={section}
      aria-labelledby={`${ids}-title`}
      className={cx(
        'flex flex-col rounded-xl border bg-surface shadow-card',
        focused ? 'border-primary/50' : 'border-border',
      )}
    >
      <Link
        to={to}
        aria-current={focused ? 'true' : undefined}
        className="flex w-full items-start justify-between gap-3 rounded-xl p-4 hover:bg-surface-2/60"
      >
        <span className="flex min-w-0 flex-col gap-1.5">
          <span id={`${ids}-title`} className="text-[15px] font-semibold break-words text-fg">
            {top?.label ?? view.suggestedAction}
          </span>
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs">
            <StatusBadge status={view.status} />
            <PriorityBadge band={view.priorityBand} priority={view.priority} />
            <span className="text-muted">{t.patientCard.reasons(view.reasons.length)}</span>
            {top ? (
              <span className={cx('font-medium', overdueTone(top.overdueDays))}>
                {formatOverdue(top.overdueDays, top.dueAt, now)}
              </span>
            ) : null}
            {view.escalation.currentStep > 0 ? (
              <EscalationMeter escalation={view.escalation} />
            ) : null}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cx(
            'mt-1 size-4 shrink-0 text-muted transition-transform',
            focused ? 'rotate-180' : '-rotate-90',
          )}
        />
      </Link>
      {focused ? (
        <div className="border-t border-border p-3 sm:p-4">
          <FocusedCase caseId={view.id} />
        </div>
      ) : null}
    </section>
  );
}

function PatientCasesView({
  card,
  focusedCaseId,
  backTo,
  caseLink,
}: {
  readonly card: PatientQueueItem;
  readonly focusedCaseId: string;
  readonly backTo?: string;
  readonly caseLink: (caseId: string) => string;
}): ReactNode {
  const t = useT();
  const now = useNow();
  const heading = useRef<HTMLHeadingElement>(null);
  const active = card.cases.filter(isActive);
  const closed = card.cases.filter((view) => !isActive(view));

  // Opening a card moves the keyboard focus to it (not left on the list row),
  // without scrolling the page away from the list unless the title is hidden.
  useEffect(() => {
    const element = heading.current;
    if (element === null) return;
    element.focus({ preventScroll: true });
    const { top, bottom } = element.getBoundingClientRect();
    if (top < 0 || bottom > globalThis.innerHeight) element.scrollIntoView({ block: 'nearest' });
  }, [card.patient.id]);

  return (
    <article aria-labelledby={CASE_TITLE_ID} className="flex flex-col gap-4">
      {backTo ? (
        <Link
          to={backTo}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg lg:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t.common.backToInbox}
        </Link>
      ) : null}

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id={CASE_TITLE_ID}
              ref={heading}
              tabIndex={-1}
              className="text-lg font-semibold tracking-tight text-fg outline-none"
            >
              {card.patient.name}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              {[
                patientMeta(card.patient, t),
                card.assignees.length > 0 ? t.patientCard.owners(card.assignees.join(', ')) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <Link
            to={`/patients/${card.patient.id}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium text-fg hover:bg-surface-2"
          >
            <UserRound className="size-3.5" aria-hidden="true" />
            {t.common.viewPatient}
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={card.status} />
          <PriorityBadge band={card.priorityBand} priority={card.priority} />
          {active.length > 0 ? (
            <Badge tone="neutral">{t.patientCard.activeCases(active.length)}</Badge>
          ) : null}
        </div>
        <ContactStatus card={card} now={now} />
        {active.length > 0 ? <RequestContact card={card} /> : null}
      </Card>

      {active.length > 0 ? (
        <section aria-labelledby="patient-cases-title" className="flex flex-col gap-3">
          <SectionTitle id="patient-cases-title" count={active.length}>
            {t.patientCard.casesTitle}
          </SectionTitle>
          {active.map((view) => (
            <CaseSection
              key={view.id}
              view={view}
              focused={view.id === focusedCaseId}
              to={caseLink(view.id)}
            />
          ))}
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section aria-labelledby="patient-closed-title" className="flex flex-col gap-3">
          <SectionTitle id="patient-closed-title" count={closed.length}>
            {t.patientCard.closedTitle}
          </SectionTitle>
          {closed.map((view) => (
            <CaseSection
              key={view.id}
              view={view}
              focused={view.id === focusedCaseId}
              to={caseLink(view.id)}
            />
          ))}
        </section>
      ) : null}
    </article>
  );
}

function PanelSkeleton(): ReactNode {
  const t = useT();
  return (
    <div aria-busy="true" aria-label={t.patientCard.loading} className="flex flex-col gap-4">
      <Skeleton className="h-36 rounded-xl" />
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}

/**
 * The patient card the inbox opens for a case (HIP-141): every case of the
 * patient as a section, the one the link named open and in view; patient
 * level actions (one contact request) on top, case actions in each section.
 * A case outside the inbox (held for its release day) falls back to its own
 * detail.
 */
export function PatientCasesPanel({
  caseId,
  backTo,
  caseLink,
}: {
  readonly caseId: string;
  readonly backTo?: string;
  /** Where a case of the card opens (the inbox route, keeping its filters). */
  readonly caseLink: (caseId: string) => string;
}): ReactNode {
  const t = useT();
  const focused = useCase(caseId);
  const card = usePatientCard(focused.data?.patient.id);
  function handleRetry(): void {
    void focused.refetch();
    void card.refetch();
  }
  if (focused.isPending) return <PanelSkeleton />;
  if (focused.isError) {
    return (
      <ErrorState
        error={focused.error}
        onRetry={handleRetry}
        title={t.patientCard.error}
        notFoundTitle={t.caseDetail.notFound}
      />
    );
  }
  if (card.isError) {
    return isApiError(card.error) && card.error.status === 404 ? (
      <CaseDetailPanel caseId={caseId} {...(backTo ? { backTo } : {})} />
    ) : (
      <ErrorState error={card.error} onRetry={handleRetry} title={t.patientCard.error} />
    );
  }
  if (card.data === undefined) return <PanelSkeleton />;
  return (
    <PatientCasesView
      card={card.data}
      focusedCaseId={caseId}
      caseLink={caseLink}
      {...(backTo ? { backTo } : {})}
    />
  );
}
