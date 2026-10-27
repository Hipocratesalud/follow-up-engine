import { BellRing, CheckCircle2, Clock, Lock, ShieldAlert, XCircle } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useState } from 'react';
import type { CaseAction, CaseActionRequest, CaseDetail } from '../../api/contract.ts';
import { useCaseAction, useNow, useRefreshAfterConflict } from '../../api/queries.ts';
import { Dialog } from '../../components/dialog.tsx';
import { InlineError } from '../../components/states.tsx';
import { Button, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { firstName, formatDate } from '../../lib/format.ts';

const SNOOZE_PRESETS = [3, 7, 14, 30] as const;
const MAX_SNOOZE_DAYS = 90;
const DAY_MS = 86_400_000;

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
  const [doneMessage, setDoneMessage] = useState<string>();

  const contactBlocked = !detail.patientContact.allowed || detail.patientContact.optedOut;
  const effectiveSnoozeDays = customDays ? Number(customDays) : snoozeDays;

  function reset(): void {
    setNote('');
    setCustomDays('');
    setSnoozeDays(7);
    setValidationError(undefined);
    mutation.reset();
  }

  function handleOpen(event: MouseEvent<HTMLButtonElement>): void {
    const next = parseAction(event.currentTarget.value);
    if (!next) return;
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
    const request: CaseActionRequest = { action, ...(note.trim() ? { note: note.trim() } : {}) };
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
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
              error={validationError}
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
                aria-invalid={validationError ? true : undefined}
                className={INPUT_CLASS}
                placeholder="Por ejemplo, 10"
              />
            </Field>
          </div>
        ) : null}

        {action === 'dismiss' ? (
          <p className="text-sm text-muted">
            Descarta el caso si no corresponde hacer seguimiento. Si la regla se equivocó, cuéntanos
            en «¿Te sirvió este caso?» para mejorarla.
          </p>
        ) : null}

        {action && showConfirm ? (
          <Field
            label="Nota interna (opcional)"
            htmlFor={`${ids}-note`}
            hint="Solo la ve el equipo."
          >
            <textarea
              id={`${ids}-note`}
              rows={2}
              value={note}
              onChange={handleNoteChange}
              className={INPUT_CLASS}
              placeholder={
                action === 'resolve'
                  ? 'Por ejemplo: trajo el resultado, ya está cargado'
                  : undefined
              }
            />
          </Field>
        ) : null}

        <InlineError error={mutation.error} />
      </Dialog>
    </div>
  );
}
