import { type ChangeEvent, type ReactNode, useId, useState } from 'react';
import type { DocumentStepValue } from '../../api/engine-tests-contract.ts';
import { Button, Field, INPUT_CLASS } from '../../components/ui.tsx';
import { useT } from '../../i18n/index.ts';
import { fileToBase64 } from '../../lib/base64.ts';
import { ICD10_OPTIONS, ICD10_OTHER } from '../lab/icd10-options.ts';

const DOCUMENT_TYPES: readonly DocumentStepValue['documentType'][] = [
  'consultation_note',
  'lab_result',
  'imaging_report',
  'prescription',
  'other',
];

export interface DocumentStepFieldsProps {
  readonly value: DocumentStepValue;
  readonly onChange: (next: DocumentStepValue) => void;
  readonly maxDate: string | undefined;
}

/**
 * One guided step's "Upload a report or paste a note": the same fields the
 * Lab page's upload card uses (date, type, text or a file), pre-filled
 * with a sample note the physician can edit or replace entirely with
 * their own file.
 */
export function DocumentStepFields({
  value,
  onChange,
  maxDate,
}: DocumentStepFieldsProps): ReactNode {
  const t = useT();
  const ids = useId();
  const [mode, setMode] = useState<'text' | 'file'>('text');
  const [fileName, setFileName] = useState<string>();

  function handleDateChange(event: ChangeEvent<HTMLInputElement>): void {
    onChange({ ...value, documentDate: event.target.value });
  }

  function handleDocumentTypeChange(event: ChangeEvent<HTMLSelectElement>): void {
    onChange({ ...value, documentType: event.target.value as DocumentStepValue['documentType'] });
  }

  function handleTextChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    onChange({ ...value, text: event.target.value, file: undefined });
  }

  function handleSwitchToFile(): void {
    setMode('file');
  }

  function handleSwitchToText(): void {
    setMode('text');
    setFileName(undefined);
    onChange({ ...value, file: undefined });
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setFileName(file.name);
    void fileToBase64(file).then((dataBase64) => {
      onChange({
        ...value,
        file: {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          dataBase64,
        },
      });
    });
  }

  function handleDiagnosisIcd10Change(event: ChangeEvent<HTMLSelectElement>): void {
    onChange({ ...value, diagnoses: [{ ...value.diagnoses?.[0], icd10: event.target.value }] });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.lab.date} htmlFor={`${ids}-date`} hint={t.lab.dateHint}>
          <input
            id={`${ids}-date`}
            type="date"
            value={value.documentDate}
            max={maxDate}
            onChange={handleDateChange}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label={t.lab.documentType} htmlFor={`${ids}-type`}>
          <select
            id={`${ids}-type`}
            value={value.documentType}
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

      {value.diagnoses !== undefined ? (
        <Field
          label={t.lab.diagnosisIcd10}
          htmlFor={`${ids}-dx`}
          hint={t.engineTests.diagnosisAttachedHint}
        >
          <select
            id={`${ids}-dx`}
            value={value.diagnoses[0]?.icd10 ?? ICD10_OTHER}
            onChange={handleDiagnosisIcd10Change}
            className={INPUT_CLASS}
          >
            {ICD10_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>
                {option.code} — {option.display}
              </option>
            ))}
          </select>
        </Field>
      ) : null}

      {mode === 'text' ? (
        <div className="flex flex-col gap-2">
          <Field label={t.lab.textLabel} htmlFor={`${ids}-text`}>
            <textarea
              id={`${ids}-text`}
              rows={5}
              value={value.text ?? ''}
              onChange={handleTextChange}
              className={`${INPUT_CLASS} resize-y leading-relaxed`}
            />
          </Field>
          <Button variant="ghost" size="sm" onClick={handleSwitchToFile} className="self-start">
            {t.lab.backToFile}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Field label={t.lab.chooseFile} htmlFor={`${ids}-file`}>
            <input
              id={`${ids}-file`}
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFileChange}
              className={INPUT_CLASS}
            />
          </Field>
          {fileName === undefined ? null : <p className="text-xs text-muted">{fileName}</p>}
          <Button variant="ghost" size="sm" onClick={handleSwitchToText} className="self-start">
            {t.lab.orPasteText}
          </Button>
        </div>
      )}
    </div>
  );
}
