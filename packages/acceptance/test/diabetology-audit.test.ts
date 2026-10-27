import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  type PlanItem,
  patientId,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { appointmentBundle } from '../src/bundles.ts';
import {
  type CalibrationConsultation,
  consultationBundle,
  labResultBundle,
  orderIdOf,
} from '../src/calibration-bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { type PatientSnapshot, snapshotPatient } from '../src/scenario-runner.ts';

/*
 * Diabetology clinical audit (2026-10-27): what physicians found checking
 * the demo case by case against the record. Each scenario reproduces one
 * finding, with a control that keeps the true positive.
 */

const PATIENT = 'pat-diab-audit';
const patient = patientId(PATIENT);
const PROCEDURE_SYSTEM = 'https://hipocratesalud.com/fhir/CodeSystem/procedure';

function planItem(
  kind: PlanItem['kind'],
  dueDay: number,
  quote: string,
  description = kind === 'lab' ? 'laboratory test' : 'follow-up visit',
): PlanItem {
  return { kind, description, dueAt: dayToDate(dueDay), evidenceQuote: quote, confidence: 0.9 };
}

function visit(
  id: string,
  at: number,
  input: Omit<CalibrationConsultation, 'consultationId' | 'patient' | 'occurredAt'>,
) {
  return consultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética' },
    occurredAt: dayToDate(at),
    ...input,
  });
}

/** An eye fundus report (the clinic's own procedure code, no LOINC). */
function fundusReport(id: string, at: number): unknown {
  const issued = dayToDate(at).toISOString();
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: {
          resourceType: 'DiagnosticReport',
          id,
          status: 'final',
          code: {
            coding: [{ system: PROCEDURE_SYSTEM, code: 'fundus-exam', display: 'Fundus exam' }],
            text: 'Fondo de ojo',
          },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: issued,
          issued,
          conclusion: 'Fondo de ojo sin signos de retinopatía diabética.',
        },
        request: { method: 'PUT', url: `DiagnosticReport/${id}` },
      },
    ],
  };
}

function result(id: string, at: number, loinc: string, display: string, value: number) {
  return labResultBundle({
    id,
    patientId: PATIENT,
    loinc,
    display,
    at: dayToDate(at),
    value,
    unit: loinc === '4548-4' ? '%' : 'mg/dL',
    flag: 'N',
  });
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
}

function ofRule(snapshot: PatientSnapshot, ruleId: string): Expectation[] {
  return snapshot.expectations.filter((expectation) => expectation.ruleId === ruleId);
}

function activeRuleIds(snapshot: PatientSnapshot): string[] {
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .flatMap((followUpCase) => [...followUpCase.ruleIds]);
}

function diabetologyAudit(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (extractor: FakeNoteExtractor): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-diab-audit-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor,
    });
  };

  describe('an uncoded plan test waits for the test its quote names', () => {
    it('a creatinine plan item the extraction left uncoded is coded and closed only by a creatinine (pat-0028)', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('uc-note', {
          planItems: [planItem('lab', 30, 'creatinina')],
        }),
      );
      await day(harness, 0, [
        visit('uc', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Se solicita creatinina. Control en 1 mes.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      // The fundus report and an HbA1c arrive first: neither is a creatinine.
      await day(harness, 5, [fundusReport('uc-fundus', 5)]);
      await day(harness, 6, [result('uc-a1c', 6, '4548-4', 'HbA1c', 6.4)]);
      let plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(plan.map((e) => [e.matchKey, e.status])).toEqual([['loinc:2160-0', 'open']]);

      await day(harness, 8, [result('uc-creat', 8, '2160-0', 'Creatinina sérica', 0.9)]);
      plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(plan.map((e) => [e.status, e.closedReason])).toEqual([
        ['fulfilled', 'fulfilled_by_result'],
      ]);
    });

    it('a plan item whose quote names several tests is not closed by one of them (pat-0028 "pendiente HbA1c, creatinina")', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('amb-note', {
          planItems: [planItem('lab', 30, 'pendiente HbA1c, creatinina')],
        }),
      );
      await day(harness, 0, [
        visit('amb', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. pendiente HbA1c, creatinina. Control en 1 mes.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      await day(harness, 6, [result('amb-a1c', 6, '4548-4', 'HbA1c', 6.4)]);
      const plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(plan.map((e) => [e.matchKey, e.status])).toEqual([['lab', 'open']]);
    });

    it('a microalbuminuria plan item is not closed by an HbA1c or a creatinine (pat-0025, pat-0027)', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('ma-note', {
          planItems: [planItem('lab', 30, 'microalbuminuria, se reitera orden')],
        }),
      );
      await day(harness, 0, [
        visit('ma', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. microalbuminuria, se reitera orden. Control en 1 mes.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      await day(harness, 6, [
        result('ma-a1c', 6, '4548-4', 'HbA1c', 6.4),
        result('ma-creat', 6, '2160-0', 'Creatinina sérica', 0.9),
      ]);
      let plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(plan.map((e) => [e.matchKey, e.status])).toEqual([['loinc:14959-1', 'open']]);
      await day(harness, 9, [result('ma-uacr', 9, '14959-1', 'Microalbuminuria', 12)]);
      plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(plan.map((e) => e.status)).toEqual(['fulfilled']);
    });

    it('"fondo de ojo" read as "other" is the fundus exam: a visit does not close it, the eye report does', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('fo-note', {
          planItems: [
            planItem('other', 30, 'fondo de ojo', 'ophthalmology referral'),
            planItem('follow_up_visit', 20, 'Control en 20 días'),
          ],
        }),
      );
      await day(harness, 0, [
        visit('fo', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Se solicita fondo de ojo. Control en 20 días.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      await day(harness, 20, [
        visit('fo2', 20, { specialty: 'diabetology', noteText: 'Control. Sin cambios.' }),
      ]);
      let plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      const fundus = (items: readonly Expectation[]) =>
        items.filter((e) => e.matchKey === `code:${PROCEDURE_SYSTEM}|fundus-exam`);
      expect(fundus(plan).map((e) => e.status)).toEqual(['open']);

      await day(harness, 25, [fundusReport('fo-report', 25)]);
      plan = ofRule(await snapshotPatient(harness, patient), 'doctor_plan_followup');
      expect(fundus(plan).map((e) => [e.status, e.closedReason])).toEqual([
        ['fulfilled', 'fulfilled_by_result'],
      ]);
    });
  });
}

describe('diabetology audit (memory)', () => {
  diabetologyAudit((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('diabetology audit'), () => {
  const database = useIsolatedDatabase();
  diabetologyAudit((options) => postgresHarness(database(), options));
});

export { activeRuleIds, appointmentBundle, orderIdOf };
