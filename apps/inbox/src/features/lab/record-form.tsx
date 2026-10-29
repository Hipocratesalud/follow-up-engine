import { Save } from 'lucide-react';
import { type ChangeEvent, type ReactNode, type SubmitEvent, useId, useState } from 'react';
import type { LabRecordKind, LabRecordResponse } from '../../api/contract.ts';
import { useAddLabRecord, useLabClock } from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { ICD10_OPTIONS, ICD10_OTHER } from './icd10-options.ts';

const RECORD_TYPES: readonly LabRecordKind[] = [
  'order',
  'result',
  'prescription',
  'visit',
  'diagnosis',
  'appointment_booked',
  'appointment_cancelled',
];

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

interface FormErrors {
  date?: string;
  field?: string;
}

/**
 * "Add something without a document" (docs/deploy.md#hosted-demo): a
 * lab/imaging order, a result, a prescription, a visit, a diagnosis or an
 * appointment, each with its own date, no note and no LLM call
 * (`buildRecordBundle`). Document upload has its own card instead
 * (`upload-card.tsx`): it is the Lab page's primary action.
 */
export function RecordForm({
  patientId,
  onRecordSaved,
}: {
  readonly patientId: string;
  readonly onRecordSaved: (response: LabRecordResponse) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const clock = useLabClock();
  const addRecord = useAddLabRecord();

  // The lab's own "today" loads asynchronously (`useLabClock`): deriving the
  // default each render (not a one-time `useState(today)`) means the date
  // field reflects it once it arrives, instead of locking in a guess made
  // before the clock loaded. Once the evaluator edits it, their edit sticks.
  const today = (clock.data?.now ?? new Date().toISOString()).slice(0, 10);
  const [type, setType] = useState<LabRecordKind>('order');
  const [dateOverride, setDateOverride] = useState<string>();
  const date = dateOverride ?? today;
  const [errors, setErrors] = useState<FormErrors>({});

  // Order.
  const [orderLoinc, setOrderLoinc] = useState('');
  const [orderDisplay, setOrderDisplay] = useState('');
  const [orderCategory, setOrderCategory] = useState<'laboratory' | 'imaging'>('laboratory');

  // Result.
  const [resultLoinc, setResultLoinc] = useState('');
  const [resultDisplay, setResultDisplay] = useState('');
  const [resultValue, setResultValue] = useState('');
  const [resultUnit, setResultUnit] = useState('');
  const [resultInterpretation, setResultInterpretation] = useState<'' | 'normal' | 'abnormal'>('');
  const [basedOnOrderId, setBasedOnOrderId] = useState('');

  // Prescription.
  const [drug, setDrug] = useState('');
  const [durationDays, setDurationDays] = useState('');

  // Diagnosis.
  const [icd10, setIcd10] = useState<string>(ICD10_OPTIONS[0]?.code ?? ICD10_OTHER);
  const [icd10Other, setIcd10Other] = useState('');
  const [diagnosisDisplay, setDiagnosisDisplay] = useState('');

  // Appointment.
  const [scheduledForOverride, setScheduledForOverride] = useState<string>();
  const scheduledFor = scheduledForOverride ?? today;
  const [appointmentSpecialty, setAppointmentSpecialty] = useState('');
  const [appointmentId, setAppointmentId] = useState('');

  function handleTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    setType(event.target.value as LabRecordKind);
    setErrors({});
    addRecord.reset();
  }

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDateOverride(event.target.value);
    setErrors({});
  }

  function handleOrderLoincChange(event: ChangeEvent<HTMLInputElement>): void {
    setOrderLoinc(event.target.value);
    setErrors({});
  }

  function handleOrderDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    setOrderDisplay(event.target.value);
    setErrors({});
  }

  function handleOrderCategoryChange(event: ChangeEvent<HTMLSelectElement>): void {
    setOrderCategory(event.target.value as 'laboratory' | 'imaging');
  }

  function handleResultLoincChange(event: ChangeEvent<HTMLInputElement>): void {
    setResultLoinc(event.target.value);
    setErrors({});
  }

  function handleResultDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    setResultDisplay(event.target.value);
    setErrors({});
  }

  function handleResultValueChange(event: ChangeEvent<HTMLInputElement>): void {
    setResultValue(event.target.value);
  }

  function handleResultUnitChange(event: ChangeEvent<HTMLInputElement>): void {
    setResultUnit(event.target.value);
  }

  function handleResultInterpretationChange(event: ChangeEvent<HTMLSelectElement>): void {
    setResultInterpretation(event.target.value as '' | 'normal' | 'abnormal');
  }

  function handleBasedOnOrderChange(event: ChangeEvent<HTMLInputElement>): void {
    setBasedOnOrderId(event.target.value);
  }

  function handleDrugChange(event: ChangeEvent<HTMLInputElement>): void {
    setDrug(event.target.value);
    setErrors({});
  }

  function handleDurationChange(event: ChangeEvent<HTMLInputElement>): void {
    setDurationDays(event.target.value);
  }

  function handleIcd10Change(event: ChangeEvent<HTMLSelectElement>): void {
    setIcd10(event.target.value);
    setErrors({});
  }

  function handleIcd10OtherChange(event: ChangeEvent<HTMLInputElement>): void {
    setIcd10Other(event.target.value);
    setErrors({});
  }

  function handleDiagnosisDisplayChange(event: ChangeEvent<HTMLInputElement>): void {
    setDiagnosisDisplay(event.target.value);
  }

  function handleScheduledForChange(event: ChangeEvent<HTMLInputElement>): void {
    setScheduledForOverride(event.target.value);
    setErrors({});
  }

  function handleAppointmentSpecialtyChange(event: ChangeEvent<HTMLInputElement>): void {
    setAppointmentSpecialty(event.target.value);
  }

  function handleAppointmentIdChange(event: ChangeEvent<HTMLInputElement>): void {
    setAppointmentId(event.target.value);
    setErrors({});
  }

  function resetAfterSave(): void {
    setOrderLoinc('');
    setOrderDisplay('');
    setResultLoinc('');
    setResultDisplay('');
    setResultValue('');
    setResultUnit('');
    setResultInterpretation('');
    setBasedOnOrderId('');
    setDrug('');
    setDurationDays('');
    setDiagnosisDisplay('');
    setAppointmentSpecialty('');
    setAppointmentId('');
  }

  function saved(response: LabRecordResponse): void {
    onRecordSaved(response);
    resetAfterSave();
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (addRecord.isPending) return;
    if (!isCalendarDay(date)) {
      setErrors({ date: t.validation.labDateRequired });
      return;
    }
    if (clock.data && date > clock.data.now.slice(0, 10)) {
      setErrors({ date: t.validation.labDateInFuture });
      return;
    }

    if (type === 'order') {
      if (!orderLoinc.trim() || !orderDisplay.trim()) {
        setErrors({ field: t.validation.labFieldRequired });
        return;
      }
      addRecord.mutate(
        {
          patientId,
          recordDate: date,
          entry: {
            kind: 'order',
            loinc: orderLoinc.trim(),
            display: orderDisplay.trim(),
            category: orderCategory,
          },
        },
        { onSuccess: saved },
      );
      return;
    }

    if (type === 'result') {
      if (!resultLoinc.trim() || !resultDisplay.trim()) {
        setErrors({ field: t.validation.labFieldRequired });
        return;
      }
      const value = resultValue.trim() === '' ? undefined : Number(resultValue);
      addRecord.mutate(
        {
          patientId,
          recordDate: date,
          entry: {
            kind: 'result',
            loinc: resultLoinc.trim(),
            display: resultDisplay.trim(),
            ...(value === undefined || Number.isNaN(value) ? {} : { value }),
            ...(resultUnit.trim() ? { unit: resultUnit.trim() } : {}),
            ...(resultInterpretation ? { interpretation: resultInterpretation } : {}),
            ...(basedOnOrderId.trim() ? { basedOnOrderId: basedOnOrderId.trim() } : {}),
          },
        },
        { onSuccess: saved },
      );
      return;
    }

    if (type === 'prescription') {
      if (!drug.trim()) {
        setErrors({ field: t.validation.labFieldRequired });
        return;
      }
      const days = durationDays.trim() === '' ? undefined : Number(durationDays);
      addRecord.mutate(
        {
          patientId,
          recordDate: date,
          entry: {
            kind: 'prescription',
            text: drug.trim(),
            ...(days === undefined || Number.isNaN(days) ? {} : { durationDays: days }),
          },
        },
        { onSuccess: saved },
      );
      return;
    }

    if (type === 'visit') {
      addRecord.mutate(
        { patientId, recordDate: date, entry: { kind: 'visit' } },
        { onSuccess: saved },
      );
      return;
    }

    if (type === 'diagnosis') {
      const code = icd10 === ICD10_OTHER ? icd10Other.trim() : icd10;
      if (!code) {
        setErrors({ field: t.validation.labFieldRequired });
        return;
      }
      addRecord.mutate(
        {
          patientId,
          recordDate: date,
          entry: {
            kind: 'diagnosis',
            icd10: code,
            ...(diagnosisDisplay.trim() ? { display: diagnosisDisplay.trim() } : {}),
          },
        },
        { onSuccess: saved },
      );
      return;
    }

    if (type === 'appointment_booked') {
      if (!isCalendarDay(scheduledFor)) {
        setErrors({ field: t.validation.labFieldRequired });
        return;
      }
      addRecord.mutate(
        {
          patientId,
          recordDate: date,
          entry: {
            kind: 'appointment_booked',
            scheduledFor,
            ...(appointmentSpecialty.trim() ? { specialty: appointmentSpecialty.trim() } : {}),
          },
        },
        { onSuccess: saved },
      );
      return;
    }

    // appointment_cancelled
    if (!appointmentId.trim() || !isCalendarDay(scheduledFor)) {
      setErrors({ field: t.validation.labFieldRequired });
      return;
    }
    addRecord.mutate(
      {
        patientId,
        recordDate: date,
        entry: { kind: 'appointment_cancelled', appointmentId: appointmentId.trim(), scheduledFor },
      },
      { onSuccess: saved },
    );
  }

  const dateError = errors.date ?? fieldError(addRecord.error, 'recordDate');
  const fieldErrorMessage = errors.field;

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-4"
      aria-label={t.lab.addWithoutDocumentTitle}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.lab.recordType} htmlFor={`${ids}-type`}>
          <select
            id={`${ids}-type`}
            value={type}
            onChange={handleTypeChange}
            className={INPUT_CLASS}
          >
            {RECORD_TYPES.map((option) => (
              <option key={option} value={option}>
                {t.lab.recordTypes[option]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.lab.date} htmlFor={`${ids}-date`} error={dateError} hint={t.lab.dateHint}>
          <input
            id={`${ids}-date`}
            type="date"
            value={date}
            max={clock.data?.now.slice(0, 10)}
            onChange={handleDateChange}
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      {type === 'order' ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t.lab.orderLoinc} htmlFor={`${ids}-order-loinc`}>
            <input
              id={`${ids}-order-loinc`}
              value={orderLoinc}
              onChange={handleOrderLoincChange}
              className={INPUT_CLASS}
              placeholder="4548-4"
            />
          </Field>
          <Field label={t.lab.orderDisplay} htmlFor={`${ids}-order-display`}>
            <input
              id={`${ids}-order-display`}
              value={orderDisplay}
              onChange={handleOrderDisplayChange}
              className={INPUT_CLASS}
              placeholder="HbA1c"
            />
          </Field>
          <Field label={t.lab.orderCategory} htmlFor={`${ids}-order-category`}>
            <select
              id={`${ids}-order-category`}
              value={orderCategory}
              onChange={handleOrderCategoryChange}
              className={INPUT_CLASS}
            >
              <option value="laboratory">{t.lab.orderCategories.laboratory}</option>
              <option value="imaging">{t.lab.orderCategories.imaging}</option>
            </select>
          </Field>
        </div>
      ) : null}

      {type === 'result' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.orderLoinc} htmlFor={`${ids}-result-loinc`}>
            <input
              id={`${ids}-result-loinc`}
              value={resultLoinc}
              onChange={handleResultLoincChange}
              className={INPUT_CLASS}
              placeholder="4548-4"
            />
          </Field>
          <Field label={t.lab.orderDisplay} htmlFor={`${ids}-result-display`}>
            <input
              id={`${ids}-result-display`}
              value={resultDisplay}
              onChange={handleResultDisplayChange}
              className={INPUT_CLASS}
              placeholder="HbA1c"
            />
          </Field>
          <Field label={t.lab.resultValue} htmlFor={`${ids}-result-value`}>
            <input
              id={`${ids}-result-value`}
              type="number"
              value={resultValue}
              onChange={handleResultValueChange}
              className={INPUT_CLASS}
            />
          </Field>
          <Field label={t.lab.resultUnit} htmlFor={`${ids}-result-unit`}>
            <input
              id={`${ids}-result-unit`}
              value={resultUnit}
              onChange={handleResultUnitChange}
              className={INPUT_CLASS}
              placeholder="%"
            />
          </Field>
          <Field label={t.lab.resultInterpretation} htmlFor={`${ids}-result-interpretation`}>
            <select
              id={`${ids}-result-interpretation`}
              value={resultInterpretation}
              onChange={handleResultInterpretationChange}
              className={INPUT_CLASS}
            >
              <option value="">{t.common.noValue}</option>
              <option value="normal">{t.lab.interpretations.normal}</option>
              <option value="abnormal">{t.lab.interpretations.abnormal}</option>
            </select>
          </Field>
          <Field label={t.lab.resultBasedOnOrder} htmlFor={`${ids}-result-based-on`}>
            <input
              id={`${ids}-result-based-on`}
              value={basedOnOrderId}
              onChange={handleBasedOnOrderChange}
              className={INPUT_CLASS}
              placeholder={t.lab.resultBasedOnOrderNone}
            />
          </Field>
        </div>
      ) : null}

      {type === 'prescription' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.prescriptionDrug} htmlFor={`${ids}-drug`}>
            <input
              id={`${ids}-drug`}
              value={drug}
              onChange={handleDrugChange}
              className={INPUT_CLASS}
              placeholder={t.lab.prescriptionDrugPlaceholder}
            />
          </Field>
          <Field label={t.lab.prescriptionDuration} htmlFor={`${ids}-duration`}>
            <input
              id={`${ids}-duration`}
              type="number"
              min={1}
              value={durationDays}
              onChange={handleDurationChange}
              className={INPUT_CLASS}
            />
          </Field>
        </div>
      ) : null}

      {type === 'diagnosis' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.diagnosisIcd10} htmlFor={`${ids}-icd10`}>
            <select
              id={`${ids}-icd10`}
              value={icd10}
              onChange={handleIcd10Change}
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
          {icd10 === ICD10_OTHER ? (
            <Field label={t.lab.diagnosisCode} htmlFor={`${ids}-icd10-other`}>
              <input
                id={`${ids}-icd10-other`}
                value={icd10Other}
                onChange={handleIcd10OtherChange}
                className={INPUT_CLASS}
                placeholder={t.lab.diagnosisCodePlaceholder}
              />
            </Field>
          ) : (
            <Field label={t.lab.diagnosisDisplay} htmlFor={`${ids}-diagnosis-display`}>
              <input
                id={`${ids}-diagnosis-display`}
                value={diagnosisDisplay}
                onChange={handleDiagnosisDisplayChange}
                className={INPUT_CLASS}
              />
            </Field>
          )}
        </div>
      ) : null}

      {type === 'appointment_booked' || type === 'appointment_cancelled' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.appointmentScheduledFor} htmlFor={`${ids}-scheduled-for`}>
            <input
              id={`${ids}-scheduled-for`}
              type="date"
              value={scheduledFor}
              onChange={handleScheduledForChange}
              className={INPUT_CLASS}
            />
          </Field>
          {type === 'appointment_booked' ? (
            <Field label={t.lab.appointmentSpecialty} htmlFor={`${ids}-appt-specialty`}>
              <input
                id={`${ids}-appt-specialty`}
                value={appointmentSpecialty}
                onChange={handleAppointmentSpecialtyChange}
                className={INPUT_CLASS}
              />
            </Field>
          ) : (
            <Field label={t.lab.appointmentToCancel} htmlFor={`${ids}-appt-id`}>
              <input
                id={`${ids}-appt-id`}
                value={appointmentId}
                onChange={handleAppointmentIdChange}
                className={INPUT_CLASS}
                placeholder={t.lab.appointmentToCancelNone}
              />
            </Field>
          )}
        </div>
      ) : null}

      {fieldErrorMessage ? (
        <p role="alert" className="text-sm text-danger">
          {fieldErrorMessage}
        </p>
      ) : null}
      <InlineError error={addRecord.error} />

      <div>
        <Button
          type="submit"
          variant="primary"
          loading={addRecord.isPending}
          icon={<Save className="size-4" aria-hidden="true" />}
        >
          {addRecord.isPending ? t.lab.saving : t.lab.save}
        </Button>
      </div>
    </form>
  );
}
