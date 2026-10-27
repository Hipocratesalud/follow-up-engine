import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import {
  FEEDBACK_REASONS,
  type CaseFeedbackView,
  type FeedbackReason,
  type FeedbackRequest,
} from '../../api/contract.ts';
import { useCaseFeedback } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatLimit, INPUT_LIMITS } from '../../lib/limits.ts';
import { useT } from '../../i18n/index.ts';
import { verdictReasonLabel } from '../../lib/labels.ts';

function parseReason(value: string): FeedbackReason | undefined {
  return FEEDBACK_REASONS.find((reason) => reason === value);
}

function FeedbackSummary({
  feedback,
  onChange,
}: {
  readonly feedback: CaseFeedbackView;
  readonly onChange: () => void;
}): ReactNode {
  const t = useT();
  function handleChange(): void {
    onChange();
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-center gap-2 text-sm text-fg">
        {feedback.useful ? (
          <ThumbsUp className="size-4 text-success" aria-hidden="true" />
        ) : (
          <ThumbsDown className="size-4 text-danger" aria-hidden="true" />
        )}
        <span>
          {feedback.useful ? t.feedback.markedUseful : t.feedback.markedNotUseful}
          {!feedback.useful && feedback.reason
            ? t.feedback.reasonSuffix(verdictReasonLabel(t, feedback.reason))
            : null}
          {feedback.comment ? (
            <span className="text-muted"> {t.common.quoted(feedback.comment)}</span>
          ) : null}
        </span>
      </p>
      <Button size="sm" variant="ghost" onClick={handleChange}>
        {t.common.change}
      </Button>
    </div>
  );
}

/**
 * "Was this useful?" The clinician's verdict is the ground truth for rule
 * tuning, so a "not useful" always needs a reason.
 */
export function FeedbackPanel({
  caseId,
  feedback,
}: {
  readonly caseId: string;
  readonly feedback: CaseFeedbackView | undefined;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const mutation = useCaseFeedback(caseId);
  const [editing, setEditing] = useState(false);
  const [notUseful, setNotUseful] = useState(false);
  const [reason, setReason] = useState<FeedbackReason>();
  const [comment, setComment] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [commentError, setCommentError] = useState<string>();
  const commentMessage = commentError ?? fieldError(mutation.error, 'comment');

  function submit(request: FeedbackRequest): void {
    if (mutation.isPending) return;
    mutation.mutate(request, {
      onSuccess: () => {
        setEditing(false);
        setNotUseful(false);
        setReason(undefined);
        setComment('');
      },
    });
  }

  function handleUseful(): void {
    setNotUseful(false);
    submit({ useful: true });
  }

  function handleNotUseful(): void {
    mutation.reset();
    setNotUseful(true);
  }

  function handleReasonChange(event: ChangeEvent<HTMLInputElement>): void {
    setReason(parseReason(event.target.value));
    setReasonError(undefined);
  }

  function handleCommentChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setComment(event.target.value);
    setCommentError(undefined);
    if (fieldError(mutation.error, 'comment')) mutation.reset();
  }

  function handleSubmitNotUseful(): void {
    if (!reason) {
      setReasonError(t.validation.feedbackReasonRequired);
      return;
    }
    if (comment.trim().length > INPUT_LIMITS.comment) {
      setCommentError(t.validation.commentTooLong(formatLimit(INPUT_LIMITS.comment)));
      return;
    }
    submit({ useful: false, reason, ...(comment.trim() ? { comment: comment.trim() } : {}) });
  }

  function handleEdit(): void {
    setEditing(true);
  }

  if (feedback && !editing) {
    return <FeedbackSummary feedback={feedback} onChange={handleEdit} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={handleUseful}
          loading={mutation.isPending && !notUseful}
          disabled={mutation.isPending}
          icon={<ThumbsUp className="size-3.5" aria-hidden="true" />}
        >
          {t.feedback.useful}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={notUseful}
          onClick={handleNotUseful}
          className={cx(notUseful && 'border-danger text-danger')}
          icon={<ThumbsDown className="size-3.5" aria-hidden="true" />}
        >
          {t.feedback.notUseful}
        </Button>
      </div>

      {notUseful ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <fieldset
            aria-describedby={reasonError ? `${ids}-reason-error` : undefined}
            aria-invalid={reasonError ? true : undefined}
          >
            <legend className="mb-2 text-sm font-medium text-fg">{t.feedback.whyNot}</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {FEEDBACK_REASONS.map((value) => (
                <label
                  key={value}
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm transition-colors',
                    reason === value
                      ? 'border-primary text-fg'
                      : 'border-border text-muted hover:text-fg',
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-reason`}
                    value={value}
                    checked={reason === value}
                    onChange={handleReasonChange}
                    className="accent-[var(--primary)]"
                  />
                  {t.labels.feedbackReasons[value]}
                </label>
              ))}
            </div>
            {reasonError ? (
              <p id={`${ids}-reason-error`} role="alert" className="mt-2 text-sm text-danger">
                {reasonError}
              </p>
            ) : null}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-comment`} className="text-sm font-medium text-fg">
              {t.feedback.comment}
            </label>
            <textarea
              id={`${ids}-comment`}
              rows={2}
              value={comment}
              maxLength={INPUT_LIMITS.comment}
              onChange={handleCommentChange}
              aria-invalid={commentMessage ? true : undefined}
              aria-describedby={commentMessage ? `${ids}-comment-error` : undefined}
              className={INPUT_CLASS}
            />
            {commentMessage ? (
              <p id={`${ids}-comment-error`} role="alert" className="text-sm text-danger">
                {commentMessage}
              </p>
            ) : null}
          </div>
          <div>
            <Button
              size="sm"
              variant="primary"
              loading={mutation.isPending}
              disabled={mutation.isPending}
              onClick={handleSubmitNotUseful}
            >
              {t.feedback.send}
            </Button>
          </div>
        </div>
      ) : null}
      <InlineError error={mutation.error} inlineFields={['comment']} />
    </div>
  );
}
