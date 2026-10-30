import { Calendar, Check, CircleSlash, FlaskConical, MessageCircleQuestion } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import type { BeforeVisitView, FindingView } from '../../api/reviewer-contract.ts';
import { useBeforeVisit, useFindingReview } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, INPUT_CLASS, SectionTitle } from '../../components/ui.tsx';
import { CitationQuote } from '../../components/evidence.tsx';
import { useT } from '../../i18n/index.ts';
import { formatDate } from '../../lib/format.ts';
import { SeverityBadge } from './finding-row.tsx';

const REASON_LIMIT = 1000;

/** The panel only ever shows these two categories; a question gets its own icon. */
const CATEGORY_ICONS: Partial<Record<FindingView['category'], typeof MessageCircleQuestion>> = {
  pre_visit_question: MessageCircleQuestion,
  abnormal_result_no_followup: FlaskConical,
};

/**
 * "Asked" (relevant) / "Not relevant" on one finding of the before-visit
 * panel: the same feedback event the batch review records
 * ({@link useFindingReview}). Once rated, the finding drops off this panel
 * (the endpoint only returns `open` ones) on the next refetch.
 */
function QuickVerdict({ findingId }: { readonly findingId: string }): ReactNode {
  const t = useT();
  const COPY = t.review.beforeVisit;
  const ids = useId();
  const mutation = useFindingReview(findingId);
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const reasonMessage = reasonError ?? fieldError(mutation.error, 'reason');

  function handleAsked(): void {
    mutation.reset();
    mutation.mutate({ verdict: 'relevant' });
  }

  function handleNotRelevantClick(): void {
    mutation.reset();
    setAskingReason(true);
  }

  function handleReasonChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setReason(event.target.value);
    setReasonError(undefined);
  }

  function handleCancel(): void {
    setAskingReason(false);
    setReason('');
    setReasonError(undefined);
  }

  function handleSubmitNotRelevant(): void {
    if (mutation.isPending) return;
    const trimmed = reason.trim();
    if (trimmed === '') {
      setReasonError(COPY.reasonRequired);
      return;
    }
    mutation.mutate({ verdict: 'not_relevant', reason: trimmed });
  }

  if (!askingReason) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="success"
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onClick={handleAsked}
          icon={<Check className="size-3.5" aria-hidden="true" />}
        >
          {COPY.askedAction}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={mutation.isPending}
          onClick={handleNotRelevantClick}
          icon={<CircleSlash className="size-3.5" aria-hidden="true" />}
        >
          {COPY.notRelevantAction}
        </Button>
        <InlineError error={mutation.error} inlineFields={['reason']} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
      <label htmlFor={`${ids}-reason`} className="text-sm font-medium text-fg">
        {COPY.reasonLabel}
      </label>
      <textarea
        id={`${ids}-reason`}
        rows={2}
        value={reason}
        maxLength={REASON_LIMIT}
        onChange={handleReasonChange}
        aria-invalid={reasonMessage ? true : undefined}
        aria-describedby={reasonMessage ? `${ids}-reason-error` : undefined}
        className={INPUT_CLASS}
      />
      {reasonMessage ? (
        <p id={`${ids}-reason-error`} role="alert" className="text-sm text-danger">
          {reasonMessage}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          loading={mutation.isPending}
          disabled={mutation.isPending}
          onClick={handleSubmitNotRelevant}
        >
          {COPY.submit}
        </Button>
        <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={handleCancel}>
          {COPY.cancel}
        </Button>
      </div>
    </div>
  );
}

function BeforeVisitItem({ item }: { readonly item: FindingView }): ReactNode {
  const t = useT();
  const COPY = t.review.beforeVisit;
  const Icon = CATEGORY_ICONS[item.category] ?? FlaskConical;
  const citation = item.citations[0];
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary-soft/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-xs font-medium text-muted">{item.categoryLabel}</span>
        <SeverityBadge severity={item.severity} />
        {item.mode === 'shadow' ? <Badge tone="warning">{COPY.shadowBadge}</Badge> : null}
      </div>
      <div>
        <p className="text-sm font-semibold text-fg">{item.summary}</p>
        <p className="mt-0.5 text-sm text-muted">{item.rationale}</p>
      </div>
      {citation ? <CitationQuote citation={citation} /> : null}
      <QuickVerdict findingId={item.id} />
    </li>
  );
}

function BeforeVisitContent({ data }: { readonly data: BeforeVisitView }): ReactNode {
  const t = useT();
  const COPY = t.review.beforeVisit;
  const { nextAppointmentAt, items } = data;
  if (items.length === 0 && nextAppointmentAt === undefined) return null;
  return (
    <Card className="flex flex-col gap-4 p-5" aria-labelledby="before-visit-title">
      <SectionTitle id="before-visit-title" count={items.length}>
        {COPY.title}
      </SectionTitle>
      {nextAppointmentAt ? (
        <p className="flex items-center gap-1.5 text-sm text-fg">
          <Calendar className="size-4 shrink-0 text-primary" aria-hidden="true" />
          {COPY.appointmentOn(formatDate(nextAppointmentAt))}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm text-muted">{COPY.emptyWithAppointment}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <BeforeVisitItem key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * "Before the visit" (PRD V3, HIP-112): the patient's next appointment and
 * the open pre-visit questions and abnormal results worth raising then,
 * with their cited evidence. Shown on the patient page and in the case
 * detail; nothing renders when there is neither an appointment nor an item.
 * A shadow finding (demo and lab clinics only) is clearly marked as a
 * suggestion the clinical team has not validated yet.
 */
export function BeforeVisitPanel({ patientId }: { readonly patientId: string }): ReactNode {
  const query = useBeforeVisit(patientId);
  if (query.isPending || query.isError) return null;
  return <BeforeVisitContent data={query.data} />;
}
