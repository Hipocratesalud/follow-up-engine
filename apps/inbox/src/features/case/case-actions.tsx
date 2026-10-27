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
import { firstName, formatDate } from '../../lib/format.ts';
import { DISMISS_COPY, DISMISS_REASON_HINTS, VALIDATION_COPY } from '../../lib/copy.ts';
import { DISMISS_REASON_LABELS } from '../../lib/labels.ts';

const SNOOZE_PRESETS = [3, 7, 14, 30] as const;
const MAX_SNOOZE_DAYS = 90;
const DAY_MS = 86_400_000;

export const CASE_TITLE_ID = 'case-title';
/** Where the keyboard lands when the dialog closes and its button is gone (the case closed). */
export const CASE_CLOSED_NOTICE_ID = 'case-closed-notice';

const DIALOG_COPY: Record<CaseAction, { title: string; confirm: string; done: string }> = {
  notify: {
    title: 'Pedir contacto con el paciente',
    confirm: 'Pedir contacto',
    done: 'Listo: le pedimos al sistema del consultorio que contacte al paciente.',
  },
  snooze: { title: 'Posponer el caso', confirm: 'Posponer', done: 'Caso pospuesto.' },
  resolve: { title: 'Resolver el caso', confirm: 'Resolver caso', done: 'Caso resuelto.' },
  dismiss: { title: 'Descartar el caso', confirm: 'Descartar caso', done: 'Caso descartado.' },
};

const ACTIONS: readonly CaseAction[] = ['notify', 'snooze', 'resolve', 'dismiss'];

function parseAction(value: string): CaseAction | undefined {
  return ACTIONS.find((action) => action === value);
}

/** The patient-facing message. Generic on purpose: no diagnosis, result or test name. */
export function patientMessagePreview(name: string): string {
  return `Hola, ${firstName(name)}. Tienes un control pendiente con tu equipo de salud. Responde este mensaje para agendar tu cita.`;
}

export function CaseActions({ detail }: { readonly detail: CaseDetail }): ReactNode {
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
      setNoteError(
        `La nota puede tener hasta ${formatLimit(INPUT_LIMITS.note)} caracteres. Acórtala e intenta de nuevo.`,
      );
      return;
    }
    const request: CaseActionRequest = { action, ...(note.trim() ? { note: note.trim() } : {}) };
    if (action === 'dismiss') {
      // Validated on click, never by disabling the button: every missing input gets its message.
      const missingReason = dismissReason === undefined;
      const missingNote = dismissReason === 'other' && !note.trim();
      if (missingReason) setReasonError(VALIDATION_COPY.dismissReasonRequired);
      if (missingNote) setNoteError(VALIDATION_COPY.dismissNoteRequired);
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
        setValidationError(`Indica un número de días entre 1 y ${String(MAX_SNOOZE_DAYS)}.`);
        return;
      }
      request.snoozeDays = effectiveSnoozeDays;
    }
    const done = DIALOG_COPY[action].done;
    mutation.mutate(request, {
      onSuccess: () => {
        setAction(null);
        setDoneMessage(done);
      },
    });
  }

  const copy = action ? DIALOG_COPY[action] : undefined;
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
          Pedir contacto
        </Button>
        <Button
          value="snooze"
          onClick={handleOpen}
          icon={<Clock className="size-4" aria-hidden="true" />}
        >
          Posponer
        </Button>
        <Button
          variant="success"
          value="resolve"
          onClick={handleOpen}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
        >
          Resolver
        </Button>
        <Button
          variant="ghost"
          value="dismiss"
          onClick={handleOpen}
          icon={<XCircle className="size-4" aria-hidden="true" />}
        >
          Descartar
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
              {showConfirm ? 'Cancelar' : 'Entendido'}
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
              {detail.patient.name} no acepta mensajes del consultorio. Contáctalo por otra vía y
              luego resuelve el caso.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted">
                Enviaremos un aviso al sistema del consultorio para que contacte a{' '}
                {detail.patient.name} por su canal habitual.
              </p>
              <div className="rounded-lg border border-border bg-surface-2 p-3">
                <p className="text-xs font-medium text-muted">Mensaje que recibirá el paciente</p>
                <p className="mt-1.5 text-sm text-fg">
                  {patientMessagePreview(detail.patient.name)}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  <Lock className="size-3" aria-hidden="true" />
                  Sin diagnósticos, resultados ni nombres de exámenes.
                </p>
              </div>
            </>
          )
        ) : null}

        {action === 'snooze' ? (
          <div className="flex flex-col gap-3">
            <div role="group" aria-label="Posponer por" className="flex flex-wrap gap-2">
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
                  {days} días
                </button>
              ))}
            </div>
            <Field
              label="Otro plazo (días)"
              htmlFor={`${ids}-days`}
              error={daysMessage}
              hint={`Volverá a la bandeja el ${formatDate(snoozeUntil)}.`}
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
                placeholder="Por ejemplo, 10"
              />
            </Field>
          </div>
        ) : null}

        {action === 'dismiss' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted">{DISMISS_COPY.intro}</p>
            <fieldset
              className="flex flex-col gap-2"
              aria-describedby={reasonMessage ? `${ids}-reason-error` : undefined}
            >
              <legend className="mb-1 text-sm font-medium text-fg">
                {DISMISS_COPY.reasonLegend}
              </legend>
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
                      {DISMISS_REASON_LABELS[reason]}
                    </span>
                    <span className="block text-xs text-muted">{DISMISS_REASON_HINTS[reason]}</span>
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
                        {DISMISS_COPY.suppressLabel}
                      </span>
                      <span className="block text-xs text-muted">
                        {DISMISS_COPY.suppressHint(detail.patient.name)}
                      </span>
                    </span>
                  </label>
                  <div id={`${ids}-suppress-list`} className="pl-6.5 text-xs text-muted">
                    <p className="font-medium text-fg">{DISMISS_COPY.suppressListTitle}</p>
                    <ul className="mt-0.5 list-disc pl-4">
                      {suppressible.map((label) => (
                        <li key={label}>{label}</li>
                      ))}
                    </ul>
                    {kept.length > 0 ? (
                      <p className="mt-1.5">{DISMISS_COPY.suppressKept(kept)}</p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-muted">
                  <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {DISMISS_COPY.nothingSuppressible}
                </p>
              )
            ) : null}
            {dismissReason === 'wrong_diagnosis' ? (
              <p className="flex gap-2 rounded-lg bg-info-soft px-3 py-2.5 text-sm text-fg">
                <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                <span>
                  {DISMISS_COPY.wrongDiagnosisBefore}{' '}
                  <Link
                    to={`/pacientes/${detail.patient.id}`}
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    {DISMISS_COPY.wrongDiagnosisLink}
                  </Link>
                  {DISMISS_COPY.wrongDiagnosisAfter}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        {action && showConfirm ? (
          <Field
            label={noteRequired ? DISMISS_COPY.noteLabelRequired : 'Nota interna (opcional)'}
            htmlFor={`${ids}-note`}
            error={noteMessage}
            hint={`Solo la ve el equipo. Hasta ${formatLimit(INPUT_LIMITS.note)} caracteres.`}
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
              placeholder={
                action === 'resolve'
                  ? 'Por ejemplo: trajo el resultado, ya está cargado'
                  : undefined
              }
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
