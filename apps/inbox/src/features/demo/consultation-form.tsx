import { Sparkles, Wand2 } from 'lucide-react';
import {
  type ChangeEvent,
  type SubmitEvent,
  type MouseEvent,
  type ReactNode,
  useId,
  useMemo,
  useState,
} from 'react';
import type { DemoConsultationRequest, DemoConsultationResponse } from '../../api/contract.ts';
import { useDemoConsultation, useNoteReader, usePatientList } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, Card, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatLimit, INPUT_LIMITS } from '../../lib/limits.ts';
import { SPECIALTY_OPTIONS } from '../../lib/labels.ts';
import { EXAMPLE_NOTES, LAB_OPTIONS } from './example-notes.ts';

const NEW_PATIENT = '__new__';
const MIN_NOTE_LENGTH = 20;

interface FormErrors {
  patient?: string | undefined;
  note?: string | undefined;
}

export function ConsultationForm({
  onResult,
}: {
  readonly onResult: (result: DemoConsultationResponse, noteText: string) => void;
}): ReactNode {
  const ids = useId();
  const mutation = useDemoConsultation();
  const reader = useNoteReader();
  const patientList = usePatientList();
  const [patientId, setPatientId] = useState<string>(NEW_PATIENT);
  const [patientName, setPatientName] = useState('');
  const [specialty, setSpecialty] = useState<string>(SPECIALTY_OPTIONS[0].value);
  const [noteText, setNoteText] = useState('');
  const [orders, setOrders] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<FormErrors>({});
  const [exampleId, setExampleId] = useState<string>();

  // Every patient of the clinic, with or without a case.
  const patients = useMemo(
    () => [...(patientList.data?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [patientList.data],
  );

  function handleExample(event: MouseEvent<HTMLButtonElement>): void {
    const example = EXAMPLE_NOTES.find((note) => note.id === event.currentTarget.value);
    if (!example) return;
    setExampleId(example.id);
    setPatientId(NEW_PATIENT);
    setPatientName(example.patientName);
    setSpecialty(example.specialty);
    setNoteText(example.noteText);
    setOrders(new Set(example.orders.map((order) => order.loinc)));
    setErrors({});
  }

  function handlePatientChange(event: ChangeEvent<HTMLSelectElement>): void {
    setPatientId(event.target.value);
    setErrors((previous) => ({ ...previous, patient: undefined }));
  }

  function handlePatientNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setPatientName(event.target.value);
    setErrors((previous) => ({ ...previous, patient: undefined }));
    if (fieldError(mutation.error, 'patientName')) mutation.reset();
  }

  function handleSpecialtyChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSpecialty(event.target.value);
  }

  function handleNoteChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setNoteText(event.target.value);
    setExampleId(undefined);
    setErrors((previous) => ({ ...previous, note: undefined }));
    if (fieldError(mutation.error, 'noteText')) mutation.reset();
  }

  function handleOrderToggle(event: ChangeEvent<HTMLInputElement>): void {
    const { value, checked } = event.target;
    setOrders((previous) => {
      const next = new Set(previous);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextErrors: FormErrors = {};
    const isNew = patientId === NEW_PATIENT;
    if (isNew && !patientName.trim())
      nextErrors.patient = 'Escribe el nombre del paciente o elige uno existente.';
    else if (isNew && patientName.trim().length > INPUT_LIMITS.patientName)
      nextErrors.patient = `El nombre puede tener hasta ${formatLimit(INPUT_LIMITS.patientName)} caracteres.`;
    if (noteText.trim().length < MIN_NOTE_LENGTH) {
      nextErrors.note = 'Escribe la nota de la consulta (al menos 20 caracteres) o usa un ejemplo.';
    } else if (noteText.trim().length > INPUT_LIMITS.noteText) {
      nextErrors.note = `La nota puede tener hasta ${formatLimit(INPUT_LIMITS.noteText)} caracteres. Acórtala e intenta de nuevo.`;
    }
    setErrors(nextErrors);
    if (nextErrors.patient ?? nextErrors.note) return;

    const request: DemoConsultationRequest = {
      specialty,
      noteText: noteText.trim(),
      orders: LAB_OPTIONS.filter((option) => orders.has(option.loinc)),
      ...(isNew ? { patientName: patientName.trim() } : { patientId }),
    };
    mutation.mutate(request, {
      onSuccess: (result) => {
        onResult(result, request.noteText);
      },
    });
  }

  const patientError = errors.patient ?? fieldError(mutation.error, 'patientName');
  const noteError = errors.note ?? fieldError(mutation.error, 'noteText');

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold text-fg">Nueva consulta</h2>
        <p className="mt-1 text-sm text-muted">
          Simula que el médico guarda una consulta en el sistema del consultorio. El motor la recibe
          como FHIR y{' '}
          {reader.simulated
            ? 'la lee con reglas (lectura simulada, sin modelo)'
            : `${reader.name} lee la nota`}
          .
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted">Usar un ejemplo</p>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_NOTES.map((example) => (
            <button
              key={example.id}
              type="button"
              value={example.id}
              onClick={handleExample}
              aria-pressed={exampleId === example.id}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                exampleId === example.id
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border-strong text-fg hover:bg-surface-2',
              )}
            >
              <Wand2 className="size-3.5" aria-hidden="true" />
              {example.title}
            </button>
          ))}
        </div>
      </div>

      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        aria-label="Nueva consulta"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paciente" htmlFor={`${ids}-patient`}>
            <select
              id={`${ids}-patient`}
              value={patientId}
              onChange={handlePatientChange}
              className={INPUT_CLASS}
            >
              <option value={NEW_PATIENT}>Paciente nuevo</option>
              {patients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Especialidad" htmlFor={`${ids}-specialty`}>
            <select
              id={`${ids}-specialty`}
              value={specialty}
              onChange={handleSpecialtyChange}
              className={INPUT_CLASS}
            >
              {SPECIALTY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {patientId === NEW_PATIENT ? (
          <Field label="Nombre del paciente nuevo" htmlFor={`${ids}-name`} error={patientError}>
            <input
              id={`${ids}-name`}
              value={patientName}
              maxLength={INPUT_LIMITS.patientName}
              onChange={handlePatientNameChange}
              aria-invalid={patientError ? true : undefined}
              aria-describedby={patientError ? `${ids}-name-error` : undefined}
              autoComplete="off"
              className={INPUT_CLASS}
              placeholder="Nombre y apellido (ficticio)"
            />
          </Field>
        ) : null}

        <Field
          label="Nota de la consulta"
          htmlFor={`${ids}-note`}
          error={noteError}
          hint={`Escribe como lo haría el médico. Solo datos ficticios, hasta ${formatLimit(INPUT_LIMITS.noteText)} caracteres.`}
        >
          <textarea
            id={`${ids}-note`}
            rows={8}
            value={noteText}
            maxLength={INPUT_LIMITS.noteText}
            onChange={handleNoteChange}
            aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? `${ids}-note-error` : `${ids}-note-hint`}
            className={cx(INPUT_CLASS, 'resize-y leading-relaxed')}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-fg">
            Órdenes de laboratorio (opcional)
          </legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {LAB_OPTIONS.map((option) => (
              <label
                key={option.loinc}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm text-fg hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  value={option.loinc}
                  checked={orders.has(option.loinc)}
                  onChange={handleOrderToggle}
                  className="accent-[var(--primary)]"
                />
                {option.display}
              </label>
            ))}
          </div>
        </fieldset>

        <InlineError error={mutation.error} inlineFields={['patientName', 'noteText']} />

        <div>
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            icon={<Sparkles className="size-4" aria-hidden="true" />}
          >
            {mutation.isPending ? 'Leyendo la nota…' : 'Guardar consulta'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
