import { Save, Sparkles, Upload } from 'lucide-react';
import { type ChangeEvent, type ReactNode, type SubmitEvent, useId, useRef, useState } from 'react';
import type {
  LabDocumentResponse,
  LabDocumentType,
  LabRecordKind,
  LabRecordResponse,
} from '../../api/contract.ts';
import {
  useAddLabRecord,
  useLabClock,
  useNoteReader,
  useUploadLabDocument,
} from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, Card, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { useT } from '../../i18n/index.ts';
import { INPUT_LIMITS } from '../../lib/limits.ts';
import { SPECIALTIES } from '../../lib/labels.ts';
import { ICD10_OPTIONS, ICD10_OTHER } from './icd10-options.ts';

/** The record form's own type selector: the structured kinds plus "document" (a free-text/file upload). */
type RecordType = 'document' | LabRecordKind;

const RECORD_TYPES: readonly RecordType[] = [
  'document',
  'order',
  'result',
  'prescription',
  'visit',
  'diagnosis',
  'appointment_booked',
  'appointment_cancelled',
];

const DOCUMENT_TYPES: readonly LabDocumentType[] = [
  'consultation_note',
  'lab_result',
  'imaging_report',
  'prescription',
  'other',
];

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

interface FormErrors {
  date?: string;
  field?: string;
}

export function RecordForm({
  patientId,
  onDocumentSaved,
  onRecordSaved,
}: {
  readonly patientId: string;
  readonly onDocumentSaved: (response: LabDocumentResponse) => void;
  readonly onRecordSaved: (response: LabRecordResponse) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const clock = useLabClock();
  const reader = useNoteReader();
  const uploadDocument = useUploadLabDocument();
  const addRecord = useAddLabRecord();
  const fileInput = useRef<HTMLInputElement | null>(null);

  const today = (clock.data?.now ?? new Date().toISOString()).slice(0, 10);
  const [type, setType] = useState<RecordType>('document');
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<FormErrors>({});

  // Document fields.
  const [source, setSource] = useState<'file' | 'text'>('text');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File>();
  const [documentType, setDocumentType] = useState<LabDocumentType>('consultation_note');
  const [specialty, setSpecialty] = useState<string>(SPECIALTIES[0]);

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
  const [scheduledFor, setScheduledFor] = useState(today);
  const [appointmentSpecialty, setAppointmentSpecialty] = useState('');
  const [appointmentId, setAppointmentId] = useState('');

  const mutation = type === 'document' ? uploadDocument : addRecord;

  function handleTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    setType(event.target.value as RecordType);
    setErrors({});
    mutation.reset();
  }

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDate(event.target.value);
    setErrors({});
  }

  function handleSourceChange(event: ChangeEvent<HTMLInputElement>): void {
    setSource(event.target.value as 'file' | 'text');
    setErrors({});
  }

  function handleTextChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setText(event.target.value);
    setErrors({});
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    setFile(event.target.files?.[0]);
    setErrors({});
  }

  function handleDocumentTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    setDocumentType(event.target.value as LabDocumentType);
  }

  function handleSpecialtyChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSpecialty(event.target.value);
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
    setScheduledFor(event.target.value);
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
    setText('');
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
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

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (mutation.isPending) return;
    if (!isCalendarDay(date)) {
      setErrors({ date: t.validation.labDateRequired });
      return;
    }
    if (clock.data && date > clock.data.now.slice(0, 10)) {
      setErrors({ date: t.validation.labDateInFuture });
      return;
    }

    if (type === 'document') {
      if (source === 'text') {
        if (!text.trim()) {
          setErrors({ field: t.validation.labDocumentRequired });
          return;
        }
        uploadDocument.mutate(
          { patientId, documentDate: date, documentType, specialty, text: text.trim() },
          {
            onSuccess: (response) => {
              onDocumentSaved(response);
              resetAfterSave();
            },
          },
        );
        return;
      }
      if (!file) {
        setErrors({ field: t.validation.labDocumentRequired });
        return;
      }
      uploadDocument.mutate(
        { patientId, documentDate: date, documentType, specialty, file },
        {
          onSuccess: (response) => {
            onDocumentSaved(response);
            resetAfterSave();
          },
        },
      );
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
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
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
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
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
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
      );
      return;
    }

    if (type === 'visit') {
      addRecord.mutate(
        { patientId, recordDate: date, entry: { kind: 'visit' } },
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
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
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
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
        {
          onSuccess: (response) => {
            onRecordSaved(response);
            resetAfterSave();
          },
        },
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
      {
        onSuccess: (response) => {
          onRecordSaved(response);
          resetAfterSave();
        },
      },
    );
  }

  const dateError =
    errors.date ??
    fieldError(mutation.error, 'documentDate') ??
    fieldError(mutation.error, 'recordDate');
  const fieldErrorMessage = errors.field;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-base font-semibold text-fg">{t.lab.recordTitle}</h2>
        {type === 'document' ? (
          <p className="mt-1 text-sm text-muted">
            {reader.simulated ? t.extraction.introSimulated : t.extraction.introModel}
          </p>
        ) : null}
      </div>
      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        aria-label={t.lab.recordTitle}
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

        {type === 'document' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t.lab.documentType} htmlFor={`${ids}-doctype`}>
                <select
                  id={`${ids}-doctype`}
                  value={documentType}
                  onChange={handleDocumentTypeChange}
                  className={INPUT_CLASS}
                >
                  {DOCUMENT_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {t.lab.documentTypes[option]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t.lab.patientSpecialty} htmlFor={`${ids}-doc-specialty`}>
                <select
                  id={`${ids}-doc-specialty`}
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
            </div>
            <fieldset className="flex flex-col gap-3">
              <legend className="sr-only">{t.lab.documentSource}</legend>
              <div role="radiogroup" aria-label={t.lab.documentSource} className="flex gap-2">
                <label
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                    source === 'text'
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border-strong text-fg',
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-source`}
                    value="text"
                    checked={source === 'text'}
                    onChange={handleSourceChange}
                    className="sr-only"
                  />
                  {t.lab.pasteText}
                </label>
                <label
                  className={cx(
                    'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                    source === 'file'
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border-strong text-fg',
                  )}
                >
                  <input
                    type="radio"
                    name={`${ids}-source`}
                    value="file"
                    checked={source === 'file'}
                    onChange={handleSourceChange}
                    className="sr-only"
                  />
                  {t.lab.uploadFile}
                </label>
              </div>
              {source === 'text' ? (
                <Field label={t.lab.textLabel} htmlFor={`${ids}-text`}>
                  <textarea
                    id={`${ids}-text`}
                    rows={7}
                    value={text}
                    maxLength={INPUT_LIMITS.labDocumentText}
                    onChange={handleTextChange}
                    className={cx(INPUT_CLASS, 'resize-y leading-relaxed')}
                    placeholder={t.lab.textPlaceholder}
                  />
                </Field>
              ) : (
                <Field label={t.lab.fileLabel} htmlFor={`${ids}-file`} hint={t.lab.fileHint}>
                  <input
                    id={`${ids}-file`}
                    ref={fileInput}
                    type="file"
                    accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    onChange={handleFileChange}
                    className={cx(INPUT_CLASS, 'cursor-pointer py-1.5')}
                  />
                </Field>
              )}
            </fieldset>
          </>
        ) : null}

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
        <InlineError error={mutation.error} />

        <div>
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            icon={
              type === 'document' ? (
                source === 'file' ? (
                  <Upload className="size-4" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-4" aria-hidden="true" />
                )
              ) : (
                <Save className="size-4" aria-hidden="true" />
              )
            }
          >
            {mutation.isPending ? t.lab.saving : t.lab.save}
          </Button>
        </div>
      </form>
    </Card>
  );
}
