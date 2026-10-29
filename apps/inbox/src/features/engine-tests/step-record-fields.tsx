import { type ChangeEvent, type ReactNode, useId } from 'react';
import type { RecordStepValue } from '../../api/engine-tests-contract.ts';
import { Field, INPUT_CLASS } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { ICD10_OPTIONS, ICD10_OTHER } from '../lab/icd10-options.ts';

export interface RecordStepFieldsProps {
  readonly value: RecordStepValue;
  readonly onChange: (next: RecordStepValue) => void;
  readonly maxDate: string | undefined;
}

/**
 * One guided step's structured record (order/result/prescription/visit/
 * diagnosis/appointment): the same field set the Lab page's "Add something
 * without a document" form uses, pre-filled by the scenario and fully
 * editable. Unlike the Lab page, the record's *kind* is fixed by the
 * step itself — the physician edits this one action's own fields, not a
 * free "choose a type" menu.
 */
export function RecordStepFields({ value, onChange, maxDate }: RecordStepFieldsProps): ReactNode {
  const t = useT();
  const ids = useId();
  const entry = value.entry;

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange({ ...value, recordDate: event.target.value });
  }

  function handleOrderLoincChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'order') return;
    onChange({ ...value, entry: { ...entry, loinc: event.target.value } });
  }

  function handleOrderDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'order') return;
    onChange({ ...value, entry: { ...entry, display: event.target.value } });
  }

  function handleResultLoincChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'result') return;
    onChange({ ...value, entry: { ...entry, loinc: event.target.value } });
  }

  function handleResultDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'result') return;
    onChange({ ...value, entry: { ...entry, display: event.target.value } });
  }

  function handleResultValueChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'result') return;
    const raw = event.target.value;
    onChange({ ...value, entry: { ...entry, value: raw === '' ? undefined : Number(raw) } });
  }

  function handleResultUnitChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'result') return;
    onChange({ ...value, entry: { ...entry, unit: event.target.value } });
  }

  function handleResultInterpretationChange(event: ChangeEvent<HTMLSelectElement>): void {
    if (entry.kind !== 'result') return;
    const next = event.target.value;
    onChange({
      ...value,
      entry: {
        ...entry,
        interpretation: next === '' ? undefined : (next as 'normal' | 'abnormal'),
      },
    });
  }

  function handlePrescriptionTextChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'prescription') return;
    onChange({ ...value, entry: { ...entry, text: event.target.value } });
  }

  function handlePrescriptionDurationChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'prescription') return;
    const raw = event.target.value;
    onChange({ ...value, entry: { ...entry, durationDays: raw === '' ? undefined : Number(raw) } });
  }

  function handleDiagnosisIcd10Change(event: ChangeEvent<HTMLSelectElement>): void {
    if (entry.kind !== 'diagnosis') return;
    onChange({ ...value, entry: { ...entry, icd10: event.target.value } });
  }

  function handleDiagnosisDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'diagnosis') return;
    onChange({ ...value, entry: { ...entry, display: event.target.value } });
  }

  function handleAppointmentScheduledForChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'appointment_booked' && entry.kind !== 'appointment_cancelled') return;
    onChange({ ...value, entry: { ...entry, scheduledFor: event.target.value } });
  }

  function handleAppointmentSpecialtyChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'appointment_booked') return;
    onChange({ ...value, entry: { ...entry, specialty: event.target.value } });
  }

  function handleAppointmentIdChange(event: ChangeEvent<HTMLInputElement>): void {
    if (entry.kind !== 'appointment_cancelled') return;
    onChange({ ...value, entry: { ...entry, appointmentId: event.target.value } });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.lab.date} htmlFor={`${ids}-date`} hint={t.lab.dateHint}>
          <input
            id={`${ids}-date`}
            type="date"
            value={value.recordDate}
            max={maxDate}
            onChange={handleDateChange}
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      {entry.kind === 'order' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.orderLoinc} htmlFor={`${ids}-loinc`}>
            <input
              id={`${ids}-loinc`}
              value={entry.loinc}
              onChange={handleOrderLoincChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.orderDisplay} htmlFor={`${ids}-display`}>
            <input
              id={`${ids}-display`}
              value={entry.display}
              onChange={handleOrderDisplayChange}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      ) : null}

      {entry.kind === 'result' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.orderLoinc} htmlFor={`${ids}-loinc`}>
            <input
              id={`${ids}-loinc`}
              value={entry.loinc}
              onChange={handleResultLoincChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.orderDisplay} htmlFor={`${ids}-display`}>
            <input
              id={`${ids}-display`}
              value={entry.display}
              onChange={handleResultDisplayChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.resultValue} htmlFor={`${ids}-value`}>
            <input
              id={`${ids}-value`}
              type="number"
              value={entry.value ?? ''}
              onChange={handleResultValueChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.resultUnit} htmlFor={`${ids}-unit`}>
            <input
              id={`${ids}-unit`}
              value={entry.unit ?? ''}
              onChange={handleResultUnitChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.resultInterpretation} htmlFor={`${ids}-interpretation`}>
            <select
              id={`${ids}-interpretation`}
              value={entry.interpretation ?? ''}
              onChange={handleResultInterpretationChange}
              className={INPUT_CLASS}
            >
              <option value="">{t.common.noValue}</option>
              <option value="normal">{t.lab.interpretations.normal}</option>
              <option value="abnormal">{t.lab.interpretations.abnormal}</option>
            </select>
          </Field>
        </div>
      ) : null}

      {entry.kind === 'prescription' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.prescriptionDrug} htmlFor={`${ids}-drug`}>
            <input
              id={`${ids}-drug`}
              value={entry.text}
              onChange={handlePrescriptionTextChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.prescriptionDuration} htmlFor={`${ids}-duration`}>
            <input
              id={`${ids}-duration`}
              type="number"
              min={1}
              value={entry.durationDays ?? ''}
              onChange={handlePrescriptionDurationChange}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      ) : null}

      {entry.kind === 'visit' ? (
        <p className="text-sm text-muted">{t.engineTests.visitStepHint}</p>
      ) : null}

      {entry.kind === 'diagnosis' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.diagnosisIcd10} htmlFor={`${ids}-icd10`}>
            <select
              id={`${ids}-icd10`}
              value={entry.icd10}
              onChange={handleDiagnosisIcd10Change}
              className={INPUT_CLASS}
            >
              {ICD10_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.code} — {option.display}
                </option>
              ))}
              <option value={ICD10_OTHER}>{t.lab.diagnosisOther}</option>
            </select>
          </Field>
          <Field label={t.lab.diagnosisDisplay} htmlFor={`${ids}-dx-display`}>
            <input
              id={`${ids}-dx-display`}
              value={entry.display ?? ''}
              onChange={handleDiagnosisDisplayChange}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      ) : null}

      {entry.kind === 'appointment_booked' || entry.kind === 'appointment_cancelled' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.appointmentScheduledFor} htmlFor={`${ids}-scheduled`}>
            <input
              id={`${ids}-scheduled`}
              type="date"
              value={entry.scheduledFor}
              onChange={handleAppointmentScheduledForChange}
              className={INPUT_CLASS}
            />
          </Field>
          {entry.kind === 'appointment_booked' ? (
            <Field label={t.lab.appointmentSpecialty} htmlFor={`${ids}-appt-specialty`}>
              <input
                id={`${ids}-appt-specialty`}
                value={entry.specialty ?? ''}
                onChange={handleAppointmentSpecialtyChange}
                className={INPUT_CLASS}
              />
            </Field>
          ) : (
            <Field label={t.lab.appointmentToCancel} htmlFor={`${ids}-appt-id`}>
              <input
                id={`${ids}-appt-id`}
                value={entry.appointmentId}
                onChange={handleAppointmentIdChange}
                className={INPUT_CLASS}
              />
            </Field>
          )}
        </div>
      ) : null}
    </div>
  );
}
