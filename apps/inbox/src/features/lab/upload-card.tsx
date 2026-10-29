import { FileUp, Sparkles, UploadCloud } from 'lucide-react';
import {
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type SubmitEvent,
  useId,
  useRef,
  useState,
} from 'react';
import type { LabDocumentResponse, LabDocumentType, LabPatient, Sex } from '../../api/contract.ts';
import {
  useCreateLabPatient,
  useLabClock,
  useLabPatients,
  useNoteReader,
  useUploadLabDocument,
} from '../../api/queries.ts';
import { fieldError, InlineError } from '../../components/states.tsx';
import { Button, Card, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { getLocale, INTL_LOCALES, useT } from '../../i18n/index.ts';
import { INPUT_LIMITS } from '../../lib/limits.ts';
import { SPECIALTIES } from '../../lib/labels.ts';

const NEW_PATIENT = '__new__';
const UNSPECIFIED_SEX = '__unspecified__';

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
  patient?: string;
  date?: string;
  field?: string;
}

/**
 * "Upload a report or document" (docs/deploy.md#hosted-demo): the Lab
 * page's primary card. Three fields beside the upload (patient, date,
 * type) and one button; picking "+ New patient" reveals its fields inline,
 * created on the same submit that reads the document.
 */
export function UploadCard({
  patientId,
  onPatientSelected,
  onUploaded,
}: {
  readonly patientId: string | undefined;
  readonly onPatientSelected: (patientId: string) => void;
  readonly onUploaded: (response: LabDocumentResponse) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const clock = useLabClock();
  const reader = useNoteReader();
  const patients = useLabPatients();
  const createPatient = useCreateLabPatient();
  const uploadDocument = useUploadLabDocument();
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The lab's own "today" loads asynchronously (`useLabClock`): deriving the
  // default each render (not a one-time `useState(today)`) means the date
  // field reflects it once it arrives, instead of locking in a guess made
  // before the clock loaded. Once the evaluator edits it, their edit sticks.
  const today = (clock.data?.now ?? new Date().toISOString()).slice(0, 10);
  const [selection, setSelection] = useState<string>(patientId ?? NEW_PATIENT);
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientSex, setNewPatientSex] = useState<string>(UNSPECIFIED_SEX);
  const [newPatientAge, setNewPatientAge] = useState('');
  const [dateOverride, setDateOverride] = useState<string>();
  const date = dateOverride ?? today;
  const [documentType, setDocumentType] = useState<LabDocumentType>('consultation_note');
  const [specialty, setSpecialty] = useState<string>(SPECIALTIES[0]);
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File>();
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  const patientList = [...(patients.data?.items ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, INTL_LOCALES[getLocale()]),
  );
  const isNewPatient = selection === NEW_PATIENT;

  function handlePatientChange(event: ChangeEvent<HTMLSelectElement>): void {
    const value = event.target.value;
    setSelection(value);
    setErrors({});
    // An existing patient is "selected" right away (the rest of the page
    // follows); "+ New patient" only once the inline fields are created.
    if (value !== NEW_PATIENT) onPatientSelected(value);
  }

  function handleNewPatientNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setNewPatientName(event.target.value);
    setErrors({});
  }

  function handleNewPatientSexChange(event: ChangeEvent<HTMLSelectElement>): void {
    setNewPatientSex(event.target.value);
  }

  function handleNewPatientAgeChange(event: ChangeEvent<HTMLInputElement>): void {
    setNewPatientAge(event.target.value);
  }

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    setDateOverride(event.target.value);
    setErrors({});
  }

  function handleDocumentTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    setDocumentType(event.target.value as LabDocumentType);
  }

  function handleSpecialtyChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSpecialty(event.target.value);
  }

  function handleTextChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setText(event.target.value);
    setErrors({});
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    setFile(event.target.files?.[0]);
    setErrors({});
  }

  function handleChooseFile(): void {
    fileInput.current?.click();
  }

  function handleSwitchToText(): void {
    setMode('text');
    setErrors({});
  }

  function handleSwitchToFile(): void {
    setMode('file');
    setErrors({});
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(): void {
    setDragOver(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      setMode('file');
      setErrors({});
    }
  }

  function resetAfterUpload(): void {
    setText('');
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
  }

  function doUpload(id: string): void {
    const base = { patientId: id, documentDate: date, documentType, specialty };
    const onSuccess = (response: LabDocumentResponse): void => {
      onUploaded(response);
      resetAfterUpload();
    };
    if (mode === 'text') {
      uploadDocument.mutate({ ...base, text: text.trim() }, { onSuccess });
      return;
    }
    // Already validated in `handleSubmit` before this is called.
    if (!file) return;
    uploadDocument.mutate({ ...base, file }, { onSuccess });
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (uploadDocument.isPending || createPatient.isPending) return;
    if (!isCalendarDay(date)) {
      setErrors({ date: t.validation.labDateRequired });
      return;
    }
    if (clock.data && date > clock.data.now.slice(0, 10)) {
      setErrors({ date: t.validation.labDateInFuture });
      return;
    }
    if (mode === 'text' ? !text.trim() : !file) {
      setErrors({ field: t.validation.labDocumentRequired });
      return;
    }
    if (isNewPatient) {
      const trimmed = newPatientName.trim();
      if (!trimmed) {
        setErrors({ patient: t.validation.patientRequired });
        return;
      }
      const age = newPatientAge.trim() === '' ? undefined : Number(newPatientAge);
      createPatient.mutate(
        {
          name: trimmed,
          specialty,
          ...(newPatientSex === UNSPECIFIED_SEX ? {} : { sex: newPatientSex as Sex }),
          ...(age === undefined || Number.isNaN(age) ? {} : { age }),
        },
        {
          onSuccess: (patient: LabPatient) => {
            setSelection(patient.id);
            setNewPatientName('');
            setNewPatientSex(UNSPECIFIED_SEX);
            setNewPatientAge('');
            onPatientSelected(patient.id);
            doUpload(patient.id);
          },
        },
      );
      return;
    }
    doUpload(selection);
  }

  const pending = uploadDocument.isPending || createPatient.isPending;
  const dateError = errors.date ?? fieldError(uploadDocument.error, 'documentDate');
  const patientError =
    errors.patient ??
    fieldError(createPatient.error, 'name') ??
    fieldError(uploadDocument.error, 'newPatient');

  return (
    <Card className="flex flex-col gap-4 border-primary/30 p-5 shadow-card">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
          <UploadCloud className="size-5 text-primary" aria-hidden="true" />
          {t.lab.uploadTitle}
        </h2>
        <p className="mt-1 text-sm text-muted">{t.lab.uploadIntro}</p>
        <p className="mt-1 text-xs text-muted">
          {reader.simulated ? t.labels.reader.simulated : t.extraction.readingOf(reader.name)}
        </p>
      </div>
      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        aria-label={t.lab.uploadTitle}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t.lab.selectPatient} htmlFor={`${ids}-patient`} error={patientError}>
            <select
              id={`${ids}-patient`}
              value={selection}
              onChange={handlePatientChange}
              className={INPUT_CLASS}
            >
              {patientList.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
              <option value={NEW_PATIENT}>{t.lab.newPatientOption}</option>
            </select>
            {patients.isError ? <InlineError error={patients.error} /> : null}
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
        </div>

        {isNewPatient ? (
          <div className="grid gap-4 rounded-lg border border-dashed border-border-strong p-3 sm:grid-cols-3">
            <Field label={t.lab.patientName} htmlFor={`${ids}-new-name`}>
              <input
                id={`${ids}-new-name`}
                value={newPatientName}
                maxLength={INPUT_LIMITS.patientName}
                onChange={handleNewPatientNameChange}
                autoComplete="off"
                className={INPUT_CLASS}
                placeholder={t.lab.patientNamePlaceholder}
              />
            </Field>
            <Field label={t.lab.patientSex} htmlFor={`${ids}-new-sex`}>
              <select
                id={`${ids}-new-sex`}
                value={newPatientSex}
                onChange={handleNewPatientSexChange}
                className={INPUT_CLASS}
              >
                <option value={UNSPECIFIED_SEX}>{t.lab.patientSexUnspecified}</option>
                <option value="female">{t.labels.sexes.female}</option>
                <option value="male">{t.labels.sexes.male}</option>
                <option value="other">{t.labels.sexes.other}</option>
                <option value="unknown">{t.labels.sexes.unknown}</option>
              </select>
            </Field>
            <Field label={t.lab.patientAge} htmlFor={`${ids}-new-age`}>
              <input
                id={`${ids}-new-age`}
                type="number"
                min={0}
                max={120}
                value={newPatientAge}
                onChange={handleNewPatientAgeChange}
                className={INPUT_CLASS}
                placeholder={t.lab.patientAgeUnspecified}
              />
            </Field>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
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
        </div>

        {mode === 'file' ? (
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cx(
              'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
              dragOver ? 'border-primary bg-primary-soft/40' : 'border-border-strong bg-surface-2',
            )}
          >
            <FileUp className="size-6 text-muted" aria-hidden="true" />
            {file ? (
              <p className="text-sm font-medium text-fg">{file.name}</p>
            ) : (
              <p className="text-sm text-muted">{t.lab.dropzoneHint}</p>
            )}
            <input
              id={`${ids}-file`}
              ref={fileInput}
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFileChange}
              className="sr-only"
            />
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button type="button" variant="secondary" size="sm" onClick={handleChooseFile}>
                {t.lab.chooseFile}
              </Button>
              <button
                type="button"
                onClick={handleSwitchToText}
                className="text-sm font-medium text-primary hover:underline"
              >
                {t.lab.orPasteText}
              </button>
            </div>
            <p className="text-xs text-muted">{t.lab.fileHint}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
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
            <button
              type="button"
              onClick={handleSwitchToFile}
              className="self-start text-sm font-medium text-primary hover:underline"
            >
              {t.lab.backToFile}
            </button>
          </div>
        )}

        {errors.field ? (
          <p role="alert" className="text-sm text-danger">
            {errors.field}
          </p>
        ) : null}
        <InlineError error={uploadDocument.error} inlineFields={['documentDate', 'newPatient']} />

        <div>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            icon={<Sparkles className="size-4" aria-hidden="true" />}
          >
            {pending ? t.lab.reading : t.lab.readDocument}
          </Button>
        </div>
      </form>
    </Card>
  );
}
