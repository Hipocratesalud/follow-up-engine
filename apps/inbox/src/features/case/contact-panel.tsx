import {
  CalendarCheck,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  PhoneCall,
  PhoneOff,
  ShieldAlert,
  ShieldOff,
  UserX,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  CALL_OUTCOMES,
  type CallOutcome,
  type CallTaskView,
  type ContactAttemptStatus,
  type ContactAttemptView,
  type ContactChannel,
  type ContactFlagView,
  type DismissalView,
} from '../../api/contract.ts';
import { useCallOutcome } from '../../api/queries.ts';
import { InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, SectionTitle, type Tone } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { formatDate, formatDateTime, formatRelative } from '../../lib/format.ts';

const CHANNEL_ICONS: Record<ContactChannel | 'host', typeof Phone> = {
  whatsapp: MessageCircle,
  phone_call: Phone,
  sms: MessageSquare,
  email: Mail,
  host: MessageSquare,
};

const ATTEMPT_TONES: Record<ContactAttemptStatus, Tone> = {
  waiting: 'info',
  answered: 'success',
  unreached: 'warning',
  unanswered: 'warning',
  pending_call: 'primary',
  closed: 'neutral',
};

/** The outcomes of a call, as buttons: what the team picks after calling. */
const CALL_OUTCOME_ICONS: Record<CallOutcome, typeof Phone> = {
  booked: CalendarCheck,
  treated_elsewhere: PhoneCall,
  no_answer: PhoneOff,
  wrong_number: ShieldAlert,
  declined: UserX,
};

/** The patient's contact data is flagged: a warning, not an action. */
export function ContactFlagNotice({
  flag,
  now,
}: {
  readonly flag: ContactFlagView;
  readonly now: Date;
}): ReactNode {
  const t = useT();
  return (
    <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-fg">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <span>
        <span className="font-semibold text-warning">{flag.label}</span>{' '}
        {t.contact.flagBody(formatRelative(flag.raisedAt, now))}
      </span>
    </p>
  );
}

function AttemptItem({
  attempt,
  now,
}: {
  readonly attempt: ContactAttemptView;
  readonly now: Date;
}): ReactNode {
  const t = useT();
  const Icon = CHANNEL_ICONS[attempt.channel ?? 'host'];
  const reports = attempt.communications.filter((communication) => communication.outcomeLabel);
  return (
    <li className="flex gap-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-muted">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-fg">
            {t.contact.attemptTitle(attempt.attempt, attempt.channelLabel)}
          </span>
          <Badge tone={ATTEMPT_TONES[attempt.status]}>{attempt.statusLabel}</Badge>
        </div>
        <p className="text-xs text-muted">
          {t.contact.triggers[attempt.trigger]}
          {attempt.requestedBy ? ` (${attempt.requestedBy})` : ''}
          {t.common.separator}
          <time dateTime={attempt.requestedAt}>{formatDateTime(attempt.requestedAt)}</time>
          {t.common.separator}
          {attempt.status === 'waiting' || attempt.status === 'pending_call'
            ? t.contact.waitsUntil(formatDate(attempt.dueBy))
            : t.contact.answerWindow(formatDate(attempt.dueBy))}
        </p>
        {attempt.outcomeLabel && attempt.outcomeAt ? (
          <p className="text-sm text-fg">
            {t.contact.outcomePrefix} <span className="font-medium">{attempt.outcomeLabel}</span>{' '}
            <span className="text-xs text-muted">({formatRelative(attempt.outcomeAt, now)})</span>
          </p>
        ) : null}
        {reports.length > 1 ? (
          <ol className="flex flex-col gap-0.5 border-l border-border pl-3 text-xs text-muted">
            {reports.map((communication) => (
              <li key={communication.id}>
                <time dateTime={communication.at}>{formatDateTime(communication.at)}</time>:{' '}
                {communication.outcomeLabel}
                {communication.sender === 'user'
                  ? `${t.common.separator}${communication.senderName ?? t.contact.senderTeam}`
                  : `${t.common.separator}${t.contact.senderHost}`}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </li>
  );
}

/** Every attempt to reach the patient about the case, with the channel and what came of it. */
export function ContactTimeline({
  attempts,
  now,
}: {
  readonly attempts: readonly ContactAttemptView[];
  readonly now: Date;
}): ReactNode {
  const t = useT();
  return (
    <Card className="flex flex-col gap-4 p-5" aria-labelledby="contact-title">
      <SectionTitle id="contact-title" count={attempts.length}>
        {t.contact.title}
      </SectionTitle>
      {attempts.length === 0 ? (
        <p className="text-sm text-muted">{t.contact.empty}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {attempts.map((attempt) => (
            <AttemptItem key={attempt.id} attempt={attempt} now={now} />
          ))}
        </ol>
      )}
    </Card>
  );
}

/** "Llamar al paciente": the call the team has to make, and what came of it in one click. */
export function CallTask({
  caseId,
  task,
  patientName,
}: {
  readonly caseId: string;
  readonly task: CallTaskView;
  readonly patientName: string;
}): ReactNode {
  const t = useT();
  const mutation = useCallOutcome(caseId);
  const [picked, setPicked] = useState<CallOutcome>();

  function handleOutcome(event: MouseEvent<HTMLButtonElement>): void {
    const outcome = CALL_OUTCOMES.find((candidate) => candidate === event.currentTarget.value);
    if (!outcome || mutation.isPending) return;
    setPicked(outcome);
    mutation.mutate({ outcome, requestId: task.requestId });
  }

  return (
    <Card className="flex flex-col gap-3 border-primary/30 p-5" aria-labelledby="call-task-title">
      <div className="flex gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
          <PhoneCall className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="call-task-title" className="text-sm font-semibold text-fg">
            {t.contact.callTitle}
          </h3>
          <p className="mt-1 text-sm text-muted">
            {task.trigger === 'wrong_number'
              ? t.contact.callWrongNumber(patientName)
              : t.contact.callUnanswered(patientName)}{' '}
            <span className={cx(task.overdue && 'font-medium text-warning')}>
              {task.overdue
                ? t.contact.callOverdue(formatDate(task.dueBy))
                : t.contact.callDue(formatDate(task.dueBy))}
            </span>
          </p>
        </div>
      </div>
      <div role="group" aria-label={t.contact.callOutcomesGroup} className="flex flex-wrap gap-2">
        {task.outcomes.map(({ outcome, label }) => {
          const Icon = CALL_OUTCOME_ICONS[outcome];
          return (
            <Button
              key={outcome}
              size="sm"
              value={outcome}
              variant={outcome === 'booked' ? 'success' : 'secondary'}
              loading={mutation.isPending && picked === outcome}
              disabled={mutation.isPending}
              onClick={handleOutcome}
              icon={<Icon className="size-3.5" aria-hidden="true" />}
            >
              {label || t.labels.callOutcomes[outcome]}
            </Button>
          );
        })}
      </div>
      <InlineError error={mutation.error} />
    </Card>
  );
}

/** Why a dismissed case was dismissed, and the reminders it stopped for the patient. */
export function DismissalSummary({
  dismissal,
  patientId,
}: {
  readonly dismissal: DismissalView;
  readonly patientId: string;
}): ReactNode {
  const t = useT();
  return (
    <Card className="flex flex-col gap-3 p-5" aria-labelledby="dismissal-title">
      <SectionTitle id="dismissal-title">{t.contact.dismissalTitle}</SectionTitle>
      <p className="text-sm text-fg">
        <span className="font-medium">{dismissal.reasonLabel}</span>
        <span className="text-muted">
          {t.common.separator}
          {dismissal.by ? `${dismissal.by}, ` : ''}
          {formatDate(dismissal.at)}
        </span>
      </p>
      {dismissal.note ? (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg">{dismissal.note}</p>
      ) : null}
      <p className="text-xs text-muted">{t.contact.dismissalFeedbackNote}</p>
      {dismissal.suppressions.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-fg">
            <ShieldOff className="size-4 text-muted" aria-hidden="true" />
            {t.contact.suppressedTitle}
          </p>
          <ul className="flex flex-col gap-0.5 text-sm text-fg">
            {dismissal.suppressions.map((suppression) => (
              <li key={suppression.id}>
                {suppression.label}
                {suppression.active ? '' : t.contact.reactivatedSuffix}
              </li>
            ))}
          </ul>
          <Link
            to={`/patients/${patientId}`}
            className="w-fit text-xs font-medium text-primary underline underline-offset-2"
          >
            {t.contact.dismissalPatientLink}
          </Link>
        </div>
      ) : null}
    </Card>
  );
}
