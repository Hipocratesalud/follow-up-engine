import { FlaskConical, Plus, UserRound } from 'lucide-react';
import { type ChangeEvent, type MouseEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { LabPatient, LabPatientCreateRequest, Sex } from '../../api/contract.ts';
import { useCreateLabPatient, useLabPatients } from '../../api/queries.ts';
import { Dialog } from '../../components/dialog.tsx';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { Button, Card, Field, INPUT_CLASS, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { getLocale, INTL_LOCALES, useT } from '../../i18n/index.ts';
import { formatLimit, INPUT_LIMITS } from '../../lib/limits.ts';
import { SPECIALTIES } from '../../lib/labels.ts';

const SEX_OPTIONS = ['female', 'male', 'other', 'unknown'] as const;
const UNSPECIFIED_SEX = '__unspecified__';

interface NewPatientErrors {
  name?: string;
}

function NewPatientDialog({
  open,
  onOpenChange,
  returnFocus,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocus: () => HTMLElement | null;
  readonly onCreated: (patient: LabPatient) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const mutation = useCreateLabPatient();
  const [name, setName] = useState('');
  const [sex, setSex] = useState<string>(UNSPECIFIED_SEX);
  const [age, setAge] = useState('');
  const [specialty, setSpecialty] = useState<string>(SPECIALTIES[0]);
  const [errors, setErrors] = useState<NewPatientErrors>({});

  function reset(): void {
    setName('');
    setSex(UNSPECIFIED_SEX);
    setAge('');
    setSpecialty(SPECIALTIES[0]);
    setErrors({});
    mutation.reset();
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setName(event.target.value);
    setErrors({});
  }

  function handleSexChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSex(event.target.value);
  }

  function handleAgeChange(event: ChangeEvent<HTMLInputElement>): void {
    setAge(event.target.value);
  }

  function handleSpecialtyChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSpecialty(event.target.value);
  }

  function handleCancel(): void {
    handleOpenChange(false);
  }

  function handleCreate(): void {
    if (mutation.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setErrors({ name: t.validation.patientRequired });
      return;
    }
    if (trimmed.length > INPUT_LIMITS.patientName) {
      setErrors({ name: t.validation.patientNameTooLong(formatLimit(INPUT_LIMITS.patientName)) });
      return;
    }
    const age10 = age.trim() === '' ? undefined : Number(age);
    const request: LabPatientCreateRequest = {
      name: trimmed,
      specialty,
      ...(sex === UNSPECIFIED_SEX ? {} : { sex: sex as Sex }),
      ...(age10 === undefined || Number.isNaN(age10) ? {} : { age: age10 }),
    };
    mutation.mutate(request, {
      onSuccess: (patient) => {
        onCreated(patient);
        handleOpenChange(false);
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      returnFocus={returnFocus}
      title={t.lab.newPatientTitle}
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel}>
            {t.common.cancel}
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={mutation.isPending}
            onClick={handleCreate}
          >
            {mutation.isPending ? t.lab.creatingPatient : t.lab.createPatient}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t.lab.patientName} htmlFor={`${ids}-name`} error={errors.name}>
          <input
            id={`${ids}-name`}
            value={name}
            maxLength={INPUT_LIMITS.patientName}
            onChange={handleNameChange}
            autoComplete="off"
            autoFocus
            className={INPUT_CLASS}
            placeholder={t.lab.patientNamePlaceholder}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.patientSex} htmlFor={`${ids}-sex`}>
            <select
              id={`${ids}-sex`}
              value={sex}
              onChange={handleSexChange}
              className={INPUT_CLASS}
            >
              <option value={UNSPECIFIED_SEX}>{t.lab.patientSexUnspecified}</option>
              {SEX_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {t.labels.sexes[option]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.lab.patientAge} htmlFor={`${ids}-age`}>
            <input
              id={`${ids}-age`}
              type="number"
              min={0}
              max={120}
              value={age}
              onChange={handleAgeChange}
              className={INPUT_CLASS}
              placeholder={t.lab.patientAgeUnspecified}
            />
          </Field>
        </div>
        <Field label={t.lab.patientSpecialty} htmlFor={`${ids}-specialty`}>
          <select
            id={`${ids}-specialty`}
            value={specialty}
            onChange={handleSpecialtyChange}
            className={INPUT_CLASS}
          >
            {SPECIALTIES.map((option) => (
              <option key={option} value={option}>
                {t.labels.specialties[option]}
              </option>
            ))}
          </select>
        </Field>
        <InlineError error={mutation.error} inlineFields={['name']} />
      </div>
    </Dialog>
  );
}

export function PatientPicker({
  patientId,
  onSelect,
}: {
  readonly patientId: string | undefined;
  readonly onSelect: (patientId: string) => void;
}): ReactNode {
  const t = useT();
  const patients = useLabPatients();
  const [dialogOpen, setDialogOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);

  function handleOpenDialog(event: MouseEvent<HTMLButtonElement>): void {
    trigger.current = event.currentTarget;
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean): void {
    setDialogOpen(open);
  }

  function returnFocus(): HTMLElement | null {
    return trigger.current?.isConnected === true ? trigger.current : null;
  }

  function handleCreated(patient: LabPatient): void {
    onSelect(patient.id);
  }

  function handleRetry(): void {
    void patients.refetch();
  }

  function handleSelect(event: MouseEvent<HTMLButtonElement>): void {
    onSelect(event.currentTarget.value);
  }

  const items = [...(patients.data?.items ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, INTL_LOCALES[getLocale()]),
  );

  return (
    <Card className="flex flex-col gap-3 p-5">
      <SectionTitle count={items.length}>{t.lab.patientsTitle}</SectionTitle>
      {patients.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t.lab.loadingPatients}>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : patients.isError ? (
        <ErrorState error={patients.error} onRetry={handleRetry} title={t.lab.patientsError} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UserRound className="size-5" aria-hidden="true" />}
          title={t.lab.noPatients}
        >
          {t.lab.noPatientsBody}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((patient) => (
            <li key={patient.id}>
              <button
                type="button"
                value={patient.id}
                onClick={handleSelect}
                aria-pressed={patient.id === patientId}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  patient.id === patientId
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-fg hover:bg-surface-2',
                )}
              >
                <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate font-medium">{patient.name}</span>
                {patient.age !== undefined ? (
                  <span className="text-xs text-muted">{patient.age}</span>
                ) : null}
                {patient.sex ? (
                  <span className="text-xs text-muted">{t.labels.sexes[patient.sex]}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="secondary"
          onClick={handleOpenDialog}
          icon={<Plus className="size-4" aria-hidden="true" />}
        >
          {t.lab.newPatient}
        </Button>
      </div>
      <NewPatientDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        returnFocus={returnFocus}
        onCreated={handleCreated}
      />
    </Card>
  );
}
