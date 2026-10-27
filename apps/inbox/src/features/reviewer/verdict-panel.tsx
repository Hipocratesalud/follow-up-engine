import { CheckCircle2, CircleSlash, History } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useState } from 'react';
import {
  FINDING_VERDICTS,
  type FindingReviewView,
  type FindingVerdict,
} from '../../api/reviewer-contract.ts';
import { useFindingReview } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDateTime } from '../../lib/format.ts';
import { REVIEW_COPY, VERDICT_LABELS } from './copy.ts';

const COPY = REVIEW_COPY.verdict;

const REASON_LIMIT = 1000;

const VERDICT_ICONS = {
  relevant: CheckCircle2,
  already_known: History,
  not_relevant: CircleSlash,
} as const;

function parseVerdict(value: string): FindingVerdict | undefined {
  return FINDING_VERDICTS.find((verdict) => verdict === value);
}

function VerdictSummary({
  review,
  onChange,
}: {
  readonly review: FindingReviewView;
  readonly onChange: () => void;
}): ReactNode {
  const Icon = VERDICT_ICONS[review.verdict];
  function handleChange(): void {
    onChange();
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-start gap-2 text-sm text-fg">
        <Icon
          className={cx(
            'mt-0.5 size-4 shrink-0',
            review.verdict === 'relevant' ? 'text-success' : 'text-muted',
          )}
          aria-hidden="true"
        />
        <span>
          {COPY.summaryPrefix}
          <strong>{VERDICT_LABELS[review.verdict].toLowerCase()}</strong>
          {COPY.summaryBy(review.reviewedBy, formatDateTime(review.reviewedAt))}
          {review.reason ? <span className="text-muted"> «{review.reason}»</span> : null}
        </span>
      </p>
      <Button size="sm" variant="ghost" onClick={handleChange}>
        {COPY.change}
      </Button>
    </div>
  );
}

/**
 * The clinician's verdict on a finding: the ground truth of the shadow
 * review. "No relevante" needs a reason (what to fix in the reviewer).
 */
export function VerdictPanel({
  findingId,
  review,
}: {
  readonly findingId: string;
  readonly review: FindingReviewView | undefined;
}): ReactNode {
  const ids = useId();
  const mutation = useFindingReview(findingId);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<FindingVerdict>();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const reasonMessage = reasonError ?? fieldError(mutation.error, 'reason');

  function handleChoose(event: MouseEvent<HTMLButtonElement>): void {
    const verdict = parseVerdict(event.currentTarget.value);
    if (verdict === undefined) return;
    mutation.reset();
    setChoice(verdict);
    setReasonError(undefined);
  }

  function handleReasonChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setReason(event.target.value);
    setReasonError(undefined);
  }

  function handleSubmit(): void {
    if (choice === undefined || mutation.isPending) return;
    const trimmed = reason.trim();
    if (choice === 'not_relevant' && trimmed === '') {
      setReasonError(COPY.reasonRequired);
      return;
    }
    if (trimmed.length > REASON_LIMIT) {
      setReasonError(COPY.reasonTooLong(REASON_LIMIT.toLocaleString('es')));
      return;
    }
    mutation.mutate(
      { verdict: choice, ...(trimmed === '' ? {} : { reason: trimmed }) },
      {
        onSuccess: () => {
          setEditing(false);
          setChoice(undefined);
          setReason('');
        },
      },
    );
  }

  function handleEdit(): void {
    setEditing(true);
  }

  if (review && !editing) return <VerdictSummary review={review} onChange={handleEdit} />;

  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label={COPY.groupLabel} className="flex flex-wrap gap-2">
        {FINDING_VERDICTS.map((verdict) => {
          const Icon = VERDICT_ICONS[verdict];
          return (
            <Button
              key={verdict}
              size="sm"
              variant="secondary"
              value={verdict}
              aria-pressed={choice === verdict}
              onClick={handleChoose}
              className={cx(choice === verdict && 'border-primary text-primary')}
              icon={<Icon className="size-3.5" aria-hidden="true" />}
            >
              {VERDICT_LABELS[verdict]}
            </Button>
          );
        })}
      </div>
      {choice ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-reason`} className="text-sm font-medium text-fg">
              {choice === 'not_relevant' ? COPY.reasonRequiredLabel : COPY.commentLabel}
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
          </div>
          <div>
            <Button
              size="sm"
              variant="primary"
              loading={mutation.isPending}
              disabled={mutation.isPending}
              onClick={handleSubmit}
            >
              {COPY.submit}
            </Button>
          </div>
        </div>
      ) : null}
      <InlineError error={mutation.error} inlineFields={['reason']} />
    </div>
  );
}
