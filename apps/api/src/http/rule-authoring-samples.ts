import type { ClinicId, Clock } from '@follow-up-engine/core';
import {
  buildPatientBundle,
  buildRecordBundle,
  type RecordEntryInput,
} from '@follow-up-engine/fhir';
import { type EngineRuntime, labIngestion } from '@follow-up-engine/runtime';

const DAY = 86_400_000;

interface SampleRecord {
  /** Days before the lab clinic's "today". */
  readonly daysAgo: number;
  readonly entry: RecordEntryInput;
}

interface SamplePatient {
  readonly key: string;
  readonly name: string;
  readonly gender: 'male' | 'female';
  readonly age: number;
  readonly records: readonly SampleRecord[];
}

const hypothyroidism: RecordEntryInput = {
  kind: 'diagnosis',
  icd10: 'E03.9',
  display: 'Hypothyroidism, unspecified',
  verification: 'confirmed',
};
const diabetes: RecordEntryInput = {
  kind: 'diagnosis',
  icd10: 'E11.9',
  display: 'Type 2 diabetes mellitus',
  verification: 'confirmed',
};
const levothyroxine = (dose: string, durationDays: number): RecordEntryInput => ({
  kind: 'prescription',
  text: `Levotiroxina ${dose}`,
  durationDays,
});
const tsh: RecordEntryInput = {
  kind: 'result',
  loinc: '3016-3',
  display: 'TSH',
  value: 2.4,
  unit: 'mIU/L',
  interpretation: 'normal',
};
const fit = (positive: boolean): RecordEntryInput => ({
  kind: 'result',
  loinc: '29771-3',
  display: 'Fecal immunochemical test',
  interpretation: positive ? 'abnormal' : 'normal',
});
const colonoscopy: RecordEntryInput = {
  kind: 'result',
  loinc: '18746-8',
  display: 'Colonoscopy',
  interpretation: 'normal',
};
const hba1c = (value: number): RecordEntryInput => ({
  kind: 'result',
  loinc: '4548-4',
  display: 'HbA1c',
  value,
  unit: '%',
  interpretation: value > 6.4 ? 'abnormal' : 'normal',
});

/**
 * Nine fictitious patients (synthetic names and data) that make the three
 * example rules' dry runs say something: for each example, one patient it
 * would flag as overdue, one it would track on time or find already
 * fulfilled, and one it must leave alone.
 */
const SAMPLE_PATIENTS: readonly SamplePatient[] = [
  {
    key: 'tsh-overdue',
    name: 'Lucía Rangel',
    gender: 'female',
    age: 54,
    records: [
      { daysAgo: 420, entry: hypothyroidism },
      { daysAgo: 250, entry: tsh },
      { daysAgo: 40, entry: levothyroxine('100 mcg', 180) },
    ],
  },
  {
    key: 'tsh-on-time',
    name: 'Mario Quintero',
    gender: 'male',
    age: 61,
    records: [
      { daysAgo: 300, entry: hypothyroidism },
      { daysAgo: 200, entry: levothyroxine('75 mcg', 365) },
      { daysAgo: 100, entry: tsh },
    ],
  },
  {
    key: 'tsh-untreated',
    name: 'Elena Pacheco',
    gender: 'female',
    age: 47,
    records: [
      { daysAgo: 210, entry: hypothyroidism },
      { daysAgo: 200, entry: tsh },
    ],
  },
  {
    key: 'fit-overdue',
    name: 'Jorge Salcedo',
    gender: 'male',
    age: 58,
    records: [{ daysAgo: 80, entry: fit(true) }],
  },
  {
    key: 'fit-done',
    name: 'Carmen Ibarra',
    gender: 'female',
    age: 63,
    records: [
      { daysAgo: 120, entry: fit(true) },
      { daysAgo: 70, entry: colonoscopy },
    ],
  },
  {
    key: 'fit-negative',
    name: 'Rafael Montes',
    gender: 'male',
    age: 52,
    records: [{ daysAgo: 60, entry: fit(false) }],
  },
  {
    key: 'hba1c-overdue',
    name: 'Teresa Vidal',
    gender: 'female',
    age: 66,
    records: [
      { daysAgo: 400, entry: diabetes },
      { daysAgo: 45, entry: hba1c(9.6) },
    ],
  },
  {
    key: 'hba1c-seen',
    name: 'Andrés Lugo',
    gender: 'male',
    age: 59,
    records: [
      { daysAgo: 380, entry: diabetes },
      { daysAgo: 20, entry: hba1c(9.4) },
      { daysAgo: 5, entry: { kind: 'visit' } },
    ],
  },
  {
    key: 'hba1c-at-goal',
    name: 'Gloria Paredes',
    gender: 'female',
    age: 70,
    records: [
      { daysAgo: 500, entry: diabetes },
      { daysAgo: 30, entry: hba1c(7.1) },
    ],
  },
];

/**
 * Adds the sample patients to an evaluator's lab clinic, dated relative to
 * the lab's own "today", through the normal FHIR path (no note, no model).
 * Idempotent: fixed patient and record ids, so adding them twice changes
 * nothing. Returns how many patients the set has.
 */
export async function seedRuleAuthoringSamples(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  clock: Clock,
): Promise<number> {
  const ingestion = labIngestion(runtime, clock);
  const today = clock.now().getTime();
  for (const patient of SAMPLE_PATIENTS) {
    const id = `pat-rules-${patient.key}`;
    const birthYear = new Date(today).getUTCFullYear() - patient.age;
    await ingestion.accept(
      clinicId,
      buildPatientBundle({
        id,
        name: patient.name,
        gender: patient.gender,
        birthDate: `${String(birthYear)}-01-01`,
      }),
      'sync',
    );
    for (const [index, record] of patient.records.entries()) {
      await ingestion.accept(
        clinicId,
        buildRecordBundle({
          recordId: `rules-sample-${patient.key}-${String(index)}`,
          patient: { id },
          occurredAt: new Date(today - record.daysAgo * DAY),
          entry: record.entry,
        }),
        'sync',
      );
    }
  }
  return SAMPLE_PATIENTS.length;
}
