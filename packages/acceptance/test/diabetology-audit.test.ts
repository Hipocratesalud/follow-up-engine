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

  describe('an abnormal result whose control is already booked or planned (pat-0035)', () => {
    const HBA1C = '4548-4';

    /**
     * A known diabetic at 8.5 % since the previous control; the visit on day 0
     * orders an HbA1c "for the next control", booked for day 105. The result
     * arrives on day 6.
     */
    async function stableDiabetic(input: {
      readonly value: number;
      readonly flag: string;
      readonly bookControl: boolean;
    }) {
      const harness = await harnessWith(
        new FakeNoteExtractor()
          .setExtraction('sd0-note', { hasPlan: false })
          .setExtraction('sd1-note', {
            planItems: [
              planItem('follow_up_visit', 90, 'Próximo control en 3 meses con resultados'),
              planItem('lab', 90, 'pendiente HbA1c, se reitera orden', 'HbA1c'),
            ],
          }),
      );
      await day(harness, -90, [
        visit('sd0', -90, {
          specialty: 'diabetology',
          noteText: 'DM2 fuera de metas.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
        labResultBundle({
          id: 'sd0-a1c',
          patientId: PATIENT,
          loinc: HBA1C,
          display: 'HbA1c',
          at: dayToDate(-88),
          value: 8.5,
          unit: '%',
          flag: 'H',
        }),
      ]);
      await day(harness, 0, [
        visit('sd1', 0, {
          specialty: 'diabetology',
          noteText:
            'DM2 fuera de metas. pendiente HbA1c, se reitera orden. Próximo control en 3 meses con resultados.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          orders: [{ loinc: HBA1C, display: 'HbA1c' }],
        }),
        ...(input.bookControl
          ? [
              appointmentBundle({
                id: 'sd-appt',
                patientId: PATIENT,
                specialty: 'diabetology',
                start: dayToDate(105),
                bookedAt: dayToDate(0),
              }),
            ]
          : []),
      ]);
      await day(harness, 6, [
        labResultBundle({
          id: 'sd1-a1c',
          patientId: PATIENT,
          loinc: HBA1C,
          display: 'HbA1c',
          at: dayToDate(6),
          value: input.value,
          unit: '%',
          flag: input.flag,
          orderId: orderIdOf('sd1', 1),
        }),
      ]);
      await day(harness, 20);
      return snapshotPatient(harness, patient);
    }

    /** The abnormal-result expectations of the day-6 result (the day -88 one had its own). */
    const fromNewResult = (snapshot: PatientSnapshot) =>
      ofRule(snapshot, 'abnormal_result_followup').filter((e) => e.source.id.startsWith('sd1-'));

    it('the patient’s stable HbA1c with the control already booked opens nothing', async () => {
      const snapshot = await stableDiabetic({ value: 8.5, flag: 'H', bookControl: true });
      expect(fromNewResult(snapshot)).toEqual([]);
      expect(activeRuleIds(snapshot)).not.toContain('abnormal_result_followup');
    });

    it('a stable HbA1c whose control is only planned (not booked yet) opens nothing either', async () => {
      const snapshot = await stableDiabetic({ value: 8.4, flag: 'H', bookControl: false });
      expect(fromNewResult(snapshot)).toEqual([]);
    });

    it('an HbA1c that got worse than the patient’s level still opens the case', async () => {
      const snapshot = await stableDiabetic({ value: 10.2, flag: 'H', bookControl: true });
      expect(activeRuleIds(snapshot)).toContain('abnormal_result_followup');
    });

    it('a critical result always opens the case, booked control or not', async () => {
      const snapshot = await stableDiabetic({ value: 8.5, flag: 'HH', bookControl: true });
      expect(activeRuleIds(snapshot)).toContain('abnormal_result_followup');
    });

    it('a booking made before the result, within the week, covers it', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('cr-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('cr', 0, {
          specialty: 'internal_medicine',
          noteText: 'Se solicita creatinina.',
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
        appointmentBundle({
          id: 'cr-appt',
          patientId: PATIENT,
          specialty: 'internal_medicine',
          start: dayToDate(9),
          bookedAt: dayToDate(0),
        }),
      ]);
      await day(harness, 4, [
        labResultBundle({
          id: 'cr-res',
          patientId: PATIENT,
          loinc: '2160-0',
          display: 'Creatinina',
          at: dayToDate(4),
          value: 1.5,
          unit: 'mg/dL',
          flag: 'H',
          orderId: orderIdOf('cr', 1),
        }),
      ]);
      await day(harness, 8);
      expect(activeRuleIds(await snapshotPatient(harness, patient))).not.toContain(
        'abnormal_result_followup',
      );
    });

    it('a first abnormal value is a new finding, even with the next control already planned', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('first-note', {
          planItems: [planItem('follow_up_visit', 90, 'Control en 3 meses con resultados')],
        }),
      );
      await day(harness, 0, [
        visit('first', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Se solicita HbA1c. Control en 3 meses con resultados.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          orders: [{ loinc: '4548-4', display: 'HbA1c' }],
        }),
      ]);
      await day(harness, 4, [
        labResultBundle({
          id: 'first-res',
          patientId: PATIENT,
          loinc: '4548-4',
          display: 'HbA1c',
          at: dayToDate(4),
          value: 9.4,
          unit: '%',
          flag: 'H',
          orderId: orderIdOf('first', 1),
        }),
      ]);
      await day(harness, 20);
      expect(activeRuleIds(await snapshotPatient(harness, patient))).toContain(
        'abnormal_result_followup',
      );
    });

    it('a new abnormal result with only an unrelated booking months away still opens the case', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('nw-note', { hasPlan: false }),
      );
      await day(harness, -10, [
        appointmentBundle({
          id: 'nw-appt',
          patientId: PATIENT,
          specialty: 'internal_medicine',
          start: dayToDate(60),
          bookedAt: dayToDate(-10),
        }),
      ]);
      await day(harness, 0, [
        visit('nw', 0, {
          specialty: 'internal_medicine',
          noteText: 'Chequeo. Se solicita creatinina.',
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      await day(harness, 4, [
        labResultBundle({
          id: 'nw-res',
          patientId: PATIENT,
          loinc: '2160-0',
          display: 'Creatinina',
          at: dayToDate(4),
          value: 1.9,
          unit: 'mg/dL',
          flag: 'H',
          orderId: orderIdOf('nw', 1),
        }),
      ]);
      await day(harness, 20);
      expect(activeRuleIds(await snapshotPatient(harness, patient))).toContain(
        'abnormal_result_followup',
      );
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
