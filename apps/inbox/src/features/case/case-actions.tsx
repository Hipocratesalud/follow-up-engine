import { BellRing, CheckCircle2, Clock, Info, Lock, ShieldAlert, XCircle } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  type CaseAction,
  type CaseActionRequest,
  type CaseDetail,
  DISMISS_REASONS,
  type DismissReason,
} from '../../api/contract.ts';
import { useCaseAction, useNow, useRefreshAfterConflict } from '../../api/queries.ts';
import { Dialog } from '../../components/dialog.tsx';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatLimit, INPUT_LIMITS } from '../../lib/limits.ts';
import { type Messages, useT } from '../../i18n/index.ts';
import { firstName, formatDate } from '../../lib/format.ts';

const SNOOZE_PRESETS = [3, 7, 14, 30] as const;
const MAX_SNOOZE_DAYS = 90;
const DAY_MS = 86_400_000;

export const CASE_TITLE_ID = 'case-title';
/** Where the keyboard lands when the dialog closes and its button is gone (the case closed). */
export const CASE_CLOSED_NOTICE_ID = 'case-closed-notice';

function dialogCopy(
  t: Messages,
  action: CaseAction,
): { title: string; confirm: string; done: string } {
  const copy = t.caseActions;
  switch (action) {
    case 'notify':
      return { title: copy.notifyTitle, confirm: copy.notifyConfirm, done: copy.notifyDone };
    case 'snooze':
      return { title: copy.snoozeTitle, confirm: copy.snoozeConfirm, done: copy.snoozeDone };
    case 'resolve':
      return { title: copy.resolveTitle, confirm: copy.resolveConfirm, done: copy.resolveDone };
    case 'dismiss':
      return { title: copy.dismissTitle, confirm: copy.dismissConfirm, done: copy.dismissDone };
  }
}

const ACTIONS: readonly CaseAction[] = ['notify', 'snooze', 'resolve', 'dismiss'];

function parseAction(value: string): CaseAction | undefined {
  return ACTIONS.find((action) => action === value);
}

/** The patient-facing message. Generic on purpose: no diagnosis, result or test name. */
export function patientMessagePreview(t: Messages, name: string): string {
  return t.caseActions.patientMessage(firstName(name));
}

export function CaseActions({ detail }: { readonly detail: CaseDetail }): ReactNode {
  const t = useT();
  const mutation = useCaseAction(detail.id);
  const refreshAfterConflict = useRefreshAfterConflict(detail.id);
  const now = useNow();
  const ids = useId();
  const [action, setAction] = useState<CaseAction | null>(null);
  const [note, setNote] = useState('');
  const [snoozeDays, setSnoozeDays] = useState<number>(7);
  const [customDays, setCustomDays] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const [noteError, setNoteError] = useState<string>();
  const [dismissReason, setDismissReason] = useState<DismissReason>();
  const [reasonError, setReasonError] = useState<string>();
  const [suppress, setSuppress] = useState(false);
  const [doneMessage, setDoneMessage] = useState<string>();
  const trigger = useRef<HTMLButtonElement | null>(null);

  const contactBlocked = !detail.patientContact.allowed || detail.patientContact.optedOut;
  const canSuppress = detail.reasons.some((reason) => reason.suppressible);
  const effectiveSnoozeDays = customDays ? Number(customDays) : snoozeDays;

  function reset(): void {
    setNote('');
    setCustomDays('');
    setSnoozeDays(7);
    setValidationError(undefined);
    setNoteError(undefined);
    setDismissReason(undefined);
    setReasonError(undefined);
    setSuppress(false);
    mutation.reset();
  }

  function returnFocus(): HTMLElement | null {
    const button = trigger.current;
    if (button?.isConnected) return button;
    return document.getElementById(CASE_CLOSED_NOTICE_ID) ?? document.getElementById(CASE_TITLE_ID);
  }

  function handleOpen(event: MouseEvent<HTMLButtonElement>): void {
    const next = parseAction(event.currentTarget.value);
    if (!next) return;
    trigger.current = event.currentTarget;
    reset();
    setDoneMessage(undefined);
    setAction(next);
  }

  function close(): void {
    setAction(null);
    // The case changed meanwhile (409): once the message was read, show its current state.
    refreshAfterConflict(mutation.error);
  }

  function handleOpenChange(open: boolean): void {
    if (!open) close();
  }

  function handleClose(): void {
    close();
  }

  function handleNoteChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setNote(event.target.value);
    setNoteError(undefined);
    if (fieldError(mutation.error, 'note')) mutation.reset();
  }

  function handleReasonChange(event: ChangeEvent<HTMLInputElement>): void {
    const next = DISMISS_REASONS.find((reason) => reason === event.target.value);
    setDismissReason(next);
    setReasonError(undefined);
    if (next !== 'other') setNoteError(undefined);
    if (next !== 'not_applicable_to_patient') setSuppress(false);
    if (fieldError(mutation.error, 'reason') || fieldError(mutation.error, 'suppress')) {
      mutation.reset();
    }
  }

  function handleSuppressChange(event: ChangeEvent<HTMLInputElement>): void {
    setSuppress(event.target.checked);
  }

  function handlePresetClick(event: MouseEvent<HTMLButtonElement>): void {
    setSnoozeDays(Number(event.currentTarget.value));
    setCustomDays('');
    setValidationError(undefined);
  }

  function handleCustomDaysChange(event: ChangeEvent<HTMLInputElement>): void {
    setCustomDays(event.target.value);
    setValidationError(undefined);
  }

  function handleConfirm(): void {
    if (!action || mutation.isPending) return;
    if (note.trim().length > INPUT_LIMITS.note) {
      setNoteError(t.validation.noteTooLong(formatLimit(INPUT_LIMITS.note)));
      return;
    }
    const request: CaseActionRequest = { action, ...(note.trim() ? { note: note.trim() } : {}) };
    if (action === 'dismiss') {
      // Validated on click, never by disabling the button: every missing input gets its message.
      const missingReason = dismissReason === undefined;
      const missingNote = dismissReason === 'other' && !note.trim();
      if (missingReason) setReasonError(t.validation.dismissReasonRequired);
      if (missingNote) setNoteError(t.validation.dismissNoteRequired);
      if (missingReason || missingNote) return;
      request.reason = dismissReason;
      if (dismissReason === 'not_applicable_to_patient' && suppress && canSuppress) {
        request.suppress = true;
      }
    }
    if (action === 'snooze') {
      if (
        !Number.isInteger(effectiveSnoozeDays) ||
        effectiveSnoozeDays < 1 ||
        effectiveSnoozeDays > MAX_SNOOZE_DAYS
      ) {
        setValidationError(t.validation.snoozeDays(MAX_SNOOZE_DAYS));
        return;
      }
      request.snoozeDays = effectiveSnoozeDays;
    }
    const done = dialogCopy(t, action).done;
    mutation.mutate(request, {
      onSuccess: () => {
        setAction(null);
        setDoneMessage(done);
      },
    });
  }

  const copy = action ? dialogCopy(t, action) : undefined;
  const showConfirm = !(action === 'notify' && contactBlocked);
  const snoozeUntil = new Date(now.getTime() + (effectiveSnoozeDays || 0) * DAY_MS).toISOString();
  const noteMessage = noteError ?? fieldError(mutation.error, 'note');
  const daysMessage = validationError ?? fieldError(mutation.error, 'snoozeDays');
  const reasonMessage =
    reasonError ?? fieldError(mutation.error, 'reason') ?? fieldError(mutation.error, 'suppress');
  const noteRequired = action === 'dismiss' && dismissReason === 'other';
  // Only protocol items and the visit pattern can be stopped for the patient.
  const suppressible = [
    ...new Set(detail.reasons.filter((reason) => reason.suppressible).map((r) => r.label)),
  ];
  const kept = [
    ...new Set(detail.reasons.filter((reason) => !reason.suppressible).map((r) => r.label)),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          // A pending call is the case's primary action: asking for contact steps back.
          variant={detail.callTask ? 'secondary' : 'primary'}
          value="notify"
          onClick={handleOpen}
          icon={<BellRing className="size-4" aria-hidden="true" />}
        >
          {t.caseActions.notify}
        </Button>
        <Button
          value="snooze"
          onClick={handleOpen}
          icon={<Clock className="size-4" aria-hidden="true" />}
        >
          {t.caseActions.snooze}
        </Button>
        <Button
          variant="success"
          value="resolve"
          onClick={handleOpen}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
        >
          {t.caseActions.resolve}
        </Button>
        <Button
          variant="ghost"
          value="dismiss"
          onClick={handleOpen}
          icon={<XCircle className="size-4" aria-hidden="true" />}
        >
          {t.caseActions.dismiss}
        </Button>
      </div>
      <p aria-live="polite" className={cx('text-sm text-success', !doneMessage && 'sr-only')}>
        {doneMessage}
      </p>

      <Dialog
        open={action !== null}
        onOpenChange={handleOpenChange}
        returnFocus={returnFocus}
        title={copy?.title ?? ''}
        footer={
          <>
            <Button variant="secondary" onClick={handleClose}>
              {showConfirm ? t.common.cancel : t.common.gotIt}
            </Button>
            {showConfirm ? (
              <Button
                variant={action === 'dismiss' ? 'danger' : 'primary'}
                loading={mutation.isPending}
                // Pending, not validation: one click sends one request.
                disabled={mutation.isPending}
                onClick={handleConfirm}
              >
                {copy?.confirm}
              </Button>
            ) : null}
          </>
        }
      >
        {action === 'notify' ? (
          contactBlocked ? (
            <p className="flex gap-2 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {t.caseActions.noMessages(detail.patient.name)}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">{t.caseActions.notifyBody(detail.patient.name)}</p>
              <div className="rounded-lg border border-border bg-surface-2 p-3">
                <p className="text-xs font-medium text-muted">{t.caseActions.messagePreview}</p>
                <p className="mt-1.5 text-sm text-fg">
                  {patientMessagePreview(t, detail.patient.name)}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <Lock className="size-3" aria-hidden="true" />
                  {t.caseActions.messagePrivacy}
                </p>
              </div>
            </>
          )
        ) : null}

        {action === 'snooze' ? (
          <div className="flex flex-col gap-3">
            <div role="group" aria-label={t.caseActions.snoozeFor} className="flex flex-wrap gap-2">
              {SNOOZE_PRESETS.map((days) => (
                <button
                  key={days}
                  type="button"
                  value={days}
                  aria-pressed={!customDays && snoozeDays === days}
                  onClick={handlePresetClick}
                  className={cx(
                    'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                    !customDays && snoozeDays === days
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border-strong text-fg hover:bg-surface-2',
                  )}
                >
                  {t.time.days(days)}
                </button>
              ))}
            </div>
            <Field
              label={t.caseActions.snoozeOther}
              htmlFor={`${ids}-days`}
              error={daysMessage}
              hint={t.caseActions.snoozeBack(formatDate(snoozeUntil))}
            >
              <input
                id={`${ids}-days`}
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_SNOOZE_DAYS}
                value={customDays}
                onChange={handleCustomDaysChange}
                aria-invalid={daysMessage ? true : undefined}
                aria-describedby={daysMessage ? `${ids}-days-error` : `${ids}-days-hint`}
                className={INPUT_CLASS}
                placeholder={t.caseActions.snoozePlaceholder}
              />
            </Field>
          </div>
        ) : null}

        {action === 'dismiss' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t.dismiss.intro}</p>
            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={reasonMessage ? `${ids}-reason-error` : undefined}
            >
              <legend className="mb-1 text-sm font-medium text-fg">{t.dismiss.reasonLegend}</legend>
              {DISMISS_REASONS.map((reason) => (
                <label
                  key={reason}
                  className={cx(
                    'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                    dismissReason === reason
                      ? 'border-primary bg-primary-soft'
                      : 'border-border-strong hover:bg-surface-2',
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-reason`}
                    value={reason}
                    checked={dismissReason === reason}
                    onChange={handleReasonChange}
                    className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">
                      {t.labels.dismissReasons[reason]}
                    </span>
                    <span className="block text-xs text-muted">
                      {t.dismiss.reasonHints[reason]}
                    </span>
                  </span>
                </label>
              ))}
              {reasonMessage ? (
                <p id={`${ids}-reason-error`} role="alert" className="text-sm text-danger">
                  {reasonMessage}
                </p>
              ) : null}
            </fieldset>
            {dismissReason === 'not_applicable_to_patient' ? (
              suppressible.length > 0 ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                  <label className="flex cursor-pointer gap-2.5">
                    <input
                      type="checkbox"
                      checked={suppress}
                      onChange={handleSuppressChange}
                      aria-describedby={`${ids}-suppress-list`}
                      className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg">
                        {t.dismiss.suppressLabel}
                      </span>
                      <span className="block text-xs text-muted">
                        {t.dismiss.suppressHint(detail.patient.name)}
                      </span>
                    </span>
                  </label>
                  <div id={`${ids}-suppress-list`} className="pl-6.5 text-xs text-muted">
                    <p className="font-medium text-fg">{t.dismiss.suppressListTitle}</p>
                    <ul className="mt-0.5 list-disc pl-4">
                      {suppressible.map((label) => (
                        <li key={label}>{label}</li>
                      ))}
                    </ul>
                    {kept.length > 0 ? (
                      <p className="mt-1.5">{t.dismiss.suppressKept(kept)}</p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-muted">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {t.dismiss.nothingSuppressible}
                </p>
              )
            ) : null}
            {dismissReason === 'wrong_diagnosis' ? (
              <p className="flex gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-sm text-fg">
                <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                <span>
                  {t.dismiss.wrongDiagnosisBefore}{' '}
                  <Link
                    to={`/patients/${detail.patient.id}`}
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    {t.dismiss.wrongDiagnosisLink}
                  </Link>
                  {t.dismiss.wrongDiagnosisAfter}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {action && showConfirm ? (
          <Field
            label={noteRequired ? t.dismiss.noteLabelRequired : t.caseActions.noteOptional}
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
              placeholder={action === 'resolve' ? t.caseActions.resolvePlaceholder : undefined}
            />
          </Field>
        ) : null}

        <InlineError
          error={mutation.error}
          inlineFields={['note', 'snoozeDays', 'reason', 'suppress']}
        />
      </Dialog>
    </div>
  );
}
