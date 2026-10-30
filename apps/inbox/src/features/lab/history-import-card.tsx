import { FileStack, FileText, History, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { type ChangeEvent, type ReactNode, type SubmitEvent, useId, useRef, useState } from 'react';
import type {
  LabDocumentType,
  LabHistoryDocumentOutcome,
  LabHistoryImportResponse,
  LabHistorySampleSet,
} from '../../api/contract.ts';
import {
  useImportLabHistory,
  useLabClock,
  useLabHistorySamples,
  useLabPatients,
} from '../../api/queries.ts';
import { InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { getLocale, INTL_LOCALES, useT } from '../../i18n/index.ts';
import { formatDate, formatNumber, formatUsd } from '../../lib/format.ts';

const NEW_PATIENT = '__new__';
const MAX_DOCUMENTS = 12;
const ACCEPT =
  '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/jpeg,image/png,image/webp';

const DOCUMENT_TYPES: readonly LabDocumentType[] = [
  'consultation_note',
  'lab_result',
  'imaging_report',
  'prescription',
  'other',
];

interface DocumentRowState {
  readonly key: string;
  readonly file: File;
  readonly documentDate: string;
  readonly documentType: LabDocumentType;
  readonly specialty?: string;
}

function isPhoto(file: File): boolean {
  return file.type.startsWith('image/');
}

function isCalendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

/** A file just added: dated today (the evaluator sets its real date), typed by its kind. */
function newRow(file: File, today: string): DocumentRowState {
  return {
    key: rowKey(),
    file,
    documentDate: today,
    documentType: isPhoto(file) ? 'lab_result' : 'consultation_note',
  };
}

function rowKey(): string {
  return `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileOfSample(document: LabHistorySampleSet['sets'][number]['documents'][number]): File {
  const bytes = Uint8Array.from(atob(document.dataBase64), (char) => char.charCodeAt(0));
  return new File([bytes], document.filename, { type: document.contentType });
}

/** `YYYY-MM-DD` as a readable date (never shown as ISO). */
function dayLabel(day: string): string {
  return formatDate(`${day}T12:00:00Z`);
}

/** One document to import: its file, the date it was written and its type. */
function DocumentRow({
  row,
  today,
  onChange,
  onRemove,
}: {
  readonly row: DocumentRowState;
  readonly today: string;
  readonly onChange: (row: DocumentRowState) => void;
  readonly onRemove: (key: string) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const photo = isPhoto(row.file);

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange({ ...row, documentDate: event.target.value });
  }

  function handleTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    onChange({ ...row, documentType: event.target.value as LabDocumentType });
  }

  function handleRemove(): void {
    onRemove(row.key);
  }

  const readsAsReport = photo || row.documentType === 'lab_result';
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-end sm:gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-fg">
          {photo ? (
            <ImageIcon className="size-4 shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
          )}
          <span className="truncate">{row.file.name}</span>
        </span>
        <span className="text-xs text-muted">
          {readsAsReport ? t.lab.history.readAsReport : t.lab.history.readAsNote}
        </span>
      </div>
      <Field label={t.lab.history.fileDate} htmlFor={`${ids}-date`}>
        <input
          id={`${ids}-date`}
          type="date"
          value={row.documentDate}
          max={today}
          onChange={handleDateChange}
          className={INPUT_CLASS}
        />
      </Field>
      <Field label={t.lab.history.fileType} htmlFor={`${ids}-type`}>
        <select
          id={`${ids}-type`}
          value={photo ? 'lab_result' : row.documentType}
          disabled={photo}
          onChange={handleTypeChange}
          className={INPUT_CLASS}
        >
          {DOCUMENT_TYPES.map((option) => (
            <option key={option} value={option}>
              {t.lab.documentTypes[option]}
            </option>
          ))}
        </select>
      </Field>
      <Button
        size="sm"
        variant="ghost"
        icon={<X className="size-4" aria-hidden="true" />}
        onClick={handleRemove}
        aria-label={t.lab.history.removeFile(row.file.name)}
      >
        {t.lab.history.remove}
      </Button>
    </li>
  );
}

function SampleButton({
  set,
  disabled,
  onPick,
}: {
  readonly set: LabHistorySampleSet['sets'][number];
  readonly disabled: boolean;
  readonly onPick: (id: string) => void;
}): ReactNode {
  const t = useT();
  function handleClick(): void {
    onPick(set.id);
  }
  return (
    <Button
      size="sm"
      icon={<History className="size-3.5" aria-hidden="true" />}
      onClick={handleClick}
      disabled={disabled}
    >
      {t.lab.history.sampleButton(set.patient.name, set.documents.length)}
    </Button>
  );
}

function OutcomeRow({ outcome }: { readonly outcome: LabHistoryDocumentOutcome }): ReactNode {
  const t = useT();
  const tone =
    outcome.status === 'staged'
      ? 'success'
      : outcome.status === 'already_imported'
        ? 'neutral'
        : outcome.status === 'needs_review'
          ? 'danger'
          : 'warning';
  // A lab report is dated by the date printed on it (collection or report date) when read.
  const shownDate =
    outcome.dates?.used === 'printed' && outcome.dates.printed !== undefined
      ? outcome.dates.printed
      : outcome.documentDate;
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg">
          <span className="font-medium">{dayLabel(shownDate)}</span>
          <span className="truncate text-muted">{outcome.filename}</span>
        </span>
        <Badge tone={tone}>{t.lab.history.statuses[outcome.status] ?? outcome.status}</Badge>
      </div>
      <p className="text-xs text-muted">
        {t.lab.history.readAs[outcome.readAs]}
        {outcome.readAs === 'lab_report' ? ` · ${t.lab.history.source[outcome.source] ?? ''}` : ''}
        {outcome.reading ? ` · ${t.lab.history.readBy(outcome.reading.model)}` : ''}
      </p>
      {outcome.reviewReason === 'name_mismatch' ? (
        <p role="note" className="text-xs font-medium text-danger">
          {t.lab.history.nameMismatch}
        </p>
      ) : null}
      {outcome.dates?.mismatch === true && outcome.dates.printed !== undefined ? (
        <p role="note" className="text-xs font-medium text-warning">
          {outcome.dates.used === 'printed'
            ? t.lab.history.datePrinted(
                dayLabel(outcome.dates.printed),
                dayLabel(outcome.dates.entered),
              )
            : t.lab.history.datePrintedLater(
                dayLabel(outcome.dates.printed),
                dayLabel(outcome.dates.entered),
              )}
        </p>
      ) : null}
      {outcome.results && outcome.results.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {outcome.results.map((result) => (
            <li key={result.loinc}>
              <Badge tone={result.interpretation === 'N' ? 'neutral' : 'warning'}>
                {`${result.name}: ${formatNumber(result.value)}${result.unit ? ` ${result.unit}` : ''}${
                  result.interpretation
                    ? ` (${t.lab.history.interpretations[result.interpretation] ?? ''})`
                    : ''
                }`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {outcome.unrecognizedTests && outcome.unrecognizedTests.length > 0 ? (
        <p className="text-xs text-muted">
          {t.lab.history.unrecognized(outcome.unrecognizedTests.join(', '))}
        </p>
      ) : null}
    </li>
  );
}

function ImportResult({ result }: { readonly result: LabHistoryImportResponse }): ReactNode {
  const t = useT();
  const released = result.cases.filter((item) => item.released).length;
  const waiting = result.cases.length - released;
  const nothingNew =
    result.eventsStaged === 0 &&
    result.backfill.expectationsCreated === 0 &&
    result.documents.every((document) => document.status === 'already_imported');
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-3 rounded-lg border border-info/30 bg-info-soft/40 p-4"
    >
      <h3 className="text-sm font-semibold text-fg">{t.lab.history.resultTitle}</h3>
      {nothingNew ? (
        <p className="text-sm text-fg">{t.lab.history.alreadyImported}</p>
      ) : (
        <>
          <p className="text-sm font-medium text-fg">
            {t.lab.history.summary(
              result.backfill.expectationsCreated,
              result.backfill.expectationsFulfilled,
              result.backfill.casesOpened,
            )}
          </p>
          <p className="text-sm text-fg">{t.lab.history.release(released, waiting)}</p>
        </>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {result.documents.map((outcome) => (
          <OutcomeRow key={outcome.index} outcome={outcome} />
        ))}
      </ul>
      <p className="text-xs text-muted">
        {t.lab.history.llmCost(result.llm.calls, formatUsd(result.llm.costUsd))}
      </p>
    </div>
  );
}

/**
 * "Import history" (V1-A): several documents of one patient at once, each
 * with the date it was written. The engine replays them in date order like
 * the initial history review; what it left unmet is held in "To recover"
 * and released by the daily cap.
 */
export function HistoryImportCard({
  patientId,
  onImported,
}: {
  readonly patientId: string | undefined;
  readonly onImported: (response: LabHistoryImportResponse) => void;
}): ReactNode {
  const t = useT();
  const ids = useId();
  const clock = useLabClock();
  const patients = useLabPatients();
  const importHistory = useImportLabHistory();
  const samples = useLabHistorySamples();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const today = (clock.data?.now ?? new Date().toISOString()).slice(0, 10);

  const [selection, setSelection] = useState<string>(patientId ?? NEW_PATIENT);
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientSex, setNewPatientSex] = useState<'male' | 'female'>();
  const [newPatientAge, setNewPatientAge] = useState<number>();
  const [rows, setRows] = useState<readonly DocumentRowState[]>([]);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<LabHistoryImportResponse>();

  const patientList = [...(patients.data?.items ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, INTL_LOCALES[getLocale()]),
  );
  const isNewPatient = selection === NEW_PATIENT;

  function handlePatientChange(event: ChangeEvent<HTMLSelectElement>): void {
    setSelection(event.target.value);
    setError(undefined);
  }

  function handleNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setNewPatientName(event.target.value);
    setNewPatientSex(undefined);
    setNewPatientAge(undefined);
    setError(undefined);
  }

  function handleChooseFiles(): void {
    fileInput.current?.click();
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>): void {
    const picked = [...(event.target.files ?? [])];
    setRows((previous) =>
      [...previous, ...picked.map((file) => newRow(file, today))].slice(0, MAX_DOCUMENTS),
    );
    setError(undefined);
    setResult(undefined);
    event.target.value = '';
  }

  function handleRowChange(next: DocumentRowState): void {
    setRows((previous) => previous.map((row) => (row.key === next.key ? next : row)));
    setError(undefined);
  }

  function handleRowRemove(key: string): void {
    setRows((previous) => previous.filter((row) => row.key !== key));
  }

  function handlePickSample(id: string): void {
    const set = samples.data?.sets.find((item) => item.id === id);
    if (set === undefined) return;
    setSelection(NEW_PATIENT);
    setNewPatientName(set.patient.name);
    setNewPatientSex(
      set.patient.sex === 'male' || set.patient.sex === 'female' ? set.patient.sex : undefined,
    );
    setNewPatientAge(set.patient.age);
    setRows(
      set.documents.map((document) => ({
        key: rowKey(),
        file: fileOfSample(document),
        documentDate: document.documentDate,
        documentType: document.documentType,
        ...(document.specialty === undefined ? {} : { specialty: document.specialty }),
      })),
    );
    setError(undefined);
    setResult(undefined);
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (importHistory.isPending) return;
    if (rows.length === 0) {
      setError(t.lab.history.filesRequired);
      return;
    }
    if (rows.some((row) => !isCalendarDay(row.documentDate) || row.documentDate > today)) {
      setError(t.lab.history.dateRequired);
      return;
    }
    const name = newPatientName.trim();
    if (isNewPatient && name === '') {
      setError(t.validation.patientRequired);
      return;
    }
    importHistory.mutate(
      {
        ...(isNewPatient
          ? {
              newPatient: {
                name,
                ...(newPatientSex === undefined ? {} : { sex: newPatientSex }),
                ...(newPatientAge === undefined ? {} : { age: newPatientAge }),
              },
            }
          : { patientId: selection }),
        documents: rows.map((row) => ({
          file: row.file,
          documentDate: row.documentDate,
          documentType: isPhoto(row.file) ? 'lab_result' : row.documentType,
          ...(row.specialty === undefined ? {} : { specialty: row.specialty }),
        })),
      },
      {
        onSuccess: (response) => {
          setResult(response);
          setSelection(response.patientId);
          setNewPatientName('');
          setRows([]);
          onImported(response);
        },
      },
    );
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
          <FileStack className="size-5 text-primary" aria-hidden="true" />
          {t.lab.history.title}
        </h2>
        <p className="mt-1 text-sm text-muted">{t.lab.history.intro}</p>
      </div>
      <form
        noValidate
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
        aria-label={t.lab.history.title}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.lab.history.patient} htmlFor={`${ids}-patient`}>
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
          </Field>
          {isNewPatient ? (
            <Field label={t.lab.history.newPatientName} htmlFor={`${ids}-name`}>
              <input
                id={`${ids}-name`}
                value={newPatientName}
                onChange={handleNameChange}
                placeholder={t.lab.patientNamePlaceholder}
                className={INPUT_CLASS}
              />
            </Field>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted">{t.lab.history.samplesLabel}</p>
          <div className="flex flex-wrap gap-1.5">
            {(samples.data?.sets ?? []).map((set) => (
              <SampleButton
                key={set.id}
                set={set}
                disabled={importHistory.isPending}
                onPick={handlePickSample}
              />
            ))}
          </div>
          {samples.isError ? <InlineError error={samples.error} /> : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-fg">
              {t.lab.history.documentsTitle}
              {rows.length > 0 ? ` (${formatNumber(rows.length)})` : ''}
            </h3>
            <Button
              size="sm"
              icon={<Paperclip className="size-3.5" aria-hidden="true" />}
              onClick={handleChooseFiles}
              disabled={rows.length >= MAX_DOCUMENTS || importHistory.isPending}
            >
              {t.lab.history.addFiles}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={handleFiles}
            />
          </div>
          <p className="text-xs text-muted">{t.lab.history.filesHint}</p>
          {rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong px-4 py-6 text-center text-sm text-muted">
              {t.lab.history.noFiles}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {rows.map((row) => (
                <DocumentRow
                  key={row.key}
                  row={row}
                  today={today}
                  onChange={handleRowChange}
                  onRemove={handleRowRemove}
                />
              ))}
            </ul>
          )}
        </div>

        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <InlineError error={importHistory.error} />
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={importHistory.isPending}
            icon={<FileStack className="size-4" aria-hidden="true" />}
          >
            {importHistory.isPending ? t.lab.history.importing : t.lab.history.importButton}
          </Button>
        </div>
      </form>
      {result ? <ImportResult result={result} /> : null}
    </Card>
  );
}
