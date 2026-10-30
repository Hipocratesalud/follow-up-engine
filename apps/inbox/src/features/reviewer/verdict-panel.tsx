import { CheckCircle2, CircleSlash, History } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useState } from 'react';
import {
  FINDING_VERDICTS,
  type FindingReviewView,
  type FindingVerdict,
  type FindingView,
  type ReviewerScope,
} from '../../api/reviewer-contract.ts';
import { useFindingReview } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { formatDateTime, formatNumber } from '../../lib/format.ts';

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
  const t = useT();
  const COPY = t.review.verdict;
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
          <strong>{t.review.verdicts[review.verdict].toLowerCase()}</strong>
          {COPY.summaryBy(review.reviewedBy, formatDateTime(review.reviewedAt))}
          {review.reason ? (
            <span className="text-muted"> {t.common.quoted(review.reason)}</span>
          ) : null}
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
 * review. "Not relevant" needs a reason (what to fix in the reviewer).
 * The same three actions rate a live finding card of the doctor's inbox.
 */
export function VerdictPanel({
  findingId,
  review,
  scope = 'clinic',
  onReviewed,
}: {
  readonly findingId: string;
  readonly review: FindingReviewView | undefined;
  /** The clinic of the API key, or the evaluator's lab. */
  readonly scope?: ReviewerScope;
  /** After the verdict is saved (an inbox card announces that it left the queue). */
  readonly onReviewed?: (view: FindingView) => void;
}): ReactNode {
  const t = useT();
  const COPY = t.review.verdict;
  const ids = useId();
  const mutation = useFindingReview(findingId, scope);
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
      setReasonError(COPY.reasonTooLong(formatNumber(REASON_LIMIT)));
      return;
    }
    mutation.mutate(
      { verdict: choice, ...(trimmed === '' ? {} : { reason: trimmed }) },
      {
        onSuccess: (view) => {
          setEditing(false);
          setChoice(undefined);
          setReason('');
          onReviewed?.(view);
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
              {t.review.verdicts[verdict]}
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
