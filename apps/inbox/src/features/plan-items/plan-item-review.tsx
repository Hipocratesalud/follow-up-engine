import { Check, PencilLine, Sparkles, X } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useRef, useState } from 'react';
import {
  PLAN_ITEM_KINDS,
  type PlanItemCorrectionRequest,
  type PlanItemView,
  type PlanItemViewKind,
} from '../../api/plan-item-contract.ts';
import { usePlanItemReview } from '../../api/patient-queue-queries.ts';
import { Dialog } from '../../components/dialog.tsx';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Badge, Button, Field, INPUT_CLASS, type Tone } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDate } from '../../lib/format.ts';
import { planItemCopy } from './copy.ts';

const copy = planItemCopy();

const REVIEW_TONES: Record<PlanItemView['review'], Tone> = {
  pending: 'warning',
  confirmed: 'success',
  corrected: 'neutral',
  rejected: 'neutral',
};

function stateLabel(item: PlanItemView): string {
  switch (item.review) {
    case 'pending':
      return copy.states.pending;
    case 'confirmed':
      return item.correctionOf === undefined
        ? copy.states.confirmed(item.confirmedBy)
        : copy.states.correction(item.confirmedBy);
    case 'corrected':
      return copy.states.corrected;
    case 'rejected':
      return copy.states.rejected;
  }
}

/** `YYYY-MM-DD` of an ISO instant (the calendar day the API stores a corrected date on). */
function calendarDay(iso: string): string {
  return iso.slice(0, 10);
}

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function parseKind(value: string): PlanItemViewKind | undefined {
  return PLAN_ITEM_KINDS.find((kind) => kind === value);
}

type Dialogs = 'correct' | 'reject';

/**
 * One-click review of a plan item the AI read from the note (HIP-141):
 * confirm it, correct its date or kind, or reject it. Shown under a
 * doctor's-plan reason (case evidence) and expectation (patient page).
 */
export function PlanItemReview({
  expectationId,
  item,
  dueAt,
}: {
  readonly expectationId: string;
  readonly item: PlanItemView;
  readonly dueAt: string;
}): ReactNode {
  const ids = useId();
  const mutation = usePlanItemReview(expectationId);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [kind, setKind] = useState<PlanItemViewKind>(item.kind);
  const [dueDate, setDueDate] = useState(calendarDay(dueAt));
  const [formError, setFormError] = useState<string>();
  const [done, setDone] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);

  function openDialog(event: MouseEvent<HTMLButtonElement>): void {
    const next = event.currentTarget.value === 'reject' ? 'reject' : 'correct';
    trigger.current = event.currentTarget;
    setKind(item.kind);
    setDueDate(calendarDay(dueAt));
    setFormError(undefined);
    mutation.reset();
    setDone(undefined);
    setDialog(next);
  }

  function handleOpenChange(open: boolean): void {
    if (!open) setDialog(null);
  }

  function handleClose(): void {
    setDialog(null);
  }

  function returnFocus(): HTMLElement | null {
    return trigger.current?.isConnected === true ? trigger.current : null;
  }

  function handleConfirm(): void {
    if (mutation.isPending) return;
    setDone(undefined);
    mutation.mutate(
      { command: 'confirm' },
      {
        onSuccess: () => {
          setDone(copy.confirmed);
        },
      },
    );
  }

  function handleKindChange(event: ChangeEvent<HTMLSelectElement>): void {
    setKind(parseKind(event.target.value) ?? item.kind);
    setFormError(undefined);
  }

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDueDate(event.target.value);
    setFormError(undefined);
  }

  function handleSaveCorrection(): void {
    if (mutation.isPending) return;
    // Validated on click, never by disabling the button.
    if (!isCalendarDay(dueDate)) {
      setFormError(copy.invalidDate);
      return;
    }
    const correction: PlanItemCorrectionRequest = {
      ...(kind === item.kind ? {} : { kind }),
      ...(dueDate === calendarDay(dueAt) ? {} : { dueDate }),
    };
    if (correction.kind === undefined && correction.dueDate === undefined) {
      setFormError(copy.nothingChanged);
      return;
    }
    mutation.mutate(
      { command: 'correct', correction },
      {
        onSuccess: () => {
          setDialog(null);
          setDone(copy.correctedDone);
        },
      },
    );
  }

  function handleReject(): void {
    if (mutation.isPending) return;
    mutation.mutate(
      { command: 'reject' },
      {
        onSuccess: () => {
          setDialog(null);
          setDone(copy.rejectedDone);
        },
      },
    );
  }

  const dateError = formError ?? fieldError(mutation.error, 'dueDate');
  const pending = item.review === 'pending';
  return (
    <div
      className={cx(
        'flex flex-col gap-2 rounded-lg border px-3 py-2.5',
        pending ? 'border-warning/40 bg-warning-soft/30' : 'border-border bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <Sparkles className="size-3.5 text-layer-plan" aria-hidden="true" />
          <span>
            {copy.readingLabel}: <span className="font-medium text-fg">{item.kindLabel}</span> ·{' '}
            {formatDate(dueAt)}
          </span>
        </p>
        <Badge tone={REVIEW_TONES[item.review]}>{stateLabel(item)}</Badge>
      </div>
      {pending ? <p className="text-xs text-muted">{copy.question}</p> : null}
      {pending || item.actionable ? (
        <div className="flex flex-wrap gap-2">
          {pending ? (
            <Button
              size="sm"
              variant="success"
              onClick={handleConfirm}
              loading={mutation.isPending && mutation.variables.command === 'confirm'}
              icon={<Check className="size-3.5" aria-hidden="true" />}
            >
              {copy.confirm}
            </Button>
          ) : null}
          {item.actionable ? (
            <>
              <Button
                size="sm"
                variant={pending ? 'secondary' : 'ghost'}
                value="correct"
                onClick={openDialog}
                icon={<PencilLine className="size-3.5" aria-hidden="true" />}
              >
                {copy.correct}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                value="reject"
                onClick={openDialog}
                icon={<X className="size-3.5" aria-hidden="true" />}
              >
                {copy.reject}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <p aria-live="polite" className={cx('text-xs text-success', !done && 'sr-only')}>
        {done}
      </p>
      {dialog === null ? <InlineError error={mutation.error} /> : null}

      <Dialog
        open={dialog !== null}
        onOpenChange={handleOpenChange}
        returnFocus={returnFocus}
        title={dialog === 'reject' ? copy.rejectTitle : copy.correctTitle}
        description={dialog === 'reject' ? copy.rejectIntro : copy.correctIntro}
        footer={
          <>
            <Button variant="secondary" onClick={handleClose}>
              {copy.cancel}
            </Button>
            <Button
              variant={dialog === 'reject' ? 'danger' : 'primary'}
              loading={mutation.isPending}
              // Pending, not validation: one click sends one request.
              disabled={mutation.isPending}
              onClick={dialog === 'reject' ? handleReject : handleSaveCorrection}
            >
              {dialog === 'reject' ? copy.rejectConfirm : copy.saveCorrection}
            </Button>
          </>
        }
      >
        {dialog === 'correct' ? (
          <>
            <Field label={copy.kindLabel} htmlFor={`${ids}-kind`}>
              <select
                id={`${ids}-kind`}
                value={kind}
                onChange={handleKindChange}
                className={INPUT_CLASS}
              >
                {PLAN_ITEM_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {copy.kinds[option]}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={copy.dueDateLabel}
              htmlFor={`${ids}-due`}
              hint={copy.dueDateHint}
              error={dateError}
            >
              <input
                id={`${ids}-due`}
                type="date"
                value={dueDate}
                onChange={handleDateChange}
                aria-invalid={dateError ? true : undefined}
                aria-describedby={dateError ? `${ids}-due-error` : `${ids}-due-hint`}
                className={INPUT_CLASS}
              />
            </Field>
          </>
        ) : null}
        {dialog === null ? null : (
          <InlineError error={mutation.error} inlineFields={['dueDate', 'kind']} />
        )}
      </Dialog>
    </div>
  );
}
