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
import {
  type CalibrationConsultation,
  consultationBundle,
  labResultBundle,
  orderIdOf,
  unlinkedNoteBundle,
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
 * HIP-123: clinical calibration. Each scenario reproduces a false positive
 * the clinical review found on the seeded clinic (QA round 1, clinical.json
 * #4, #7, #8, #11, #15 and inbox.json #12), with a control that keeps the
 * true positive.
 */

const PATIENT = 'pat-calibration';
const patient = patientId(PATIENT);

function planItem(
  kind: PlanItem['kind'],
  dueDay: number,
  quote: string,
  code?: PlanItem['code'],
): PlanItem {
  return {
    kind,
    description: kind === 'lab' ? 'laboratory test' : 'follow-up visit',
    dueAt: dayToDate(dueDay),
    evidenceQuote: quote,
    confidence: 0.9,
    ...(code === undefined ? {} : { code }),
  };
}

const HBA1C = { system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' };

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

function live(expectations: readonly Expectation[]): Expectation[] {
  return expectations.filter((e) => e.status === 'open' || e.status === 'expired');
}

function activeRuleIds(snapshot: PatientSnapshot): string[][] {
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .map((followUpCase) => [...followUpCase.ruleIds].sort());
}

function calibration(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (extractor: FakeNoteExtractor): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-calibration-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor,
    });
  };

  describe('cadence ignores closed episodes', () => {
    it('a finished pregnancy (prenatal controls, then postpartum) is not a visit pattern', async () => {
      const extractor = new FakeNoteExtractor();
      for (const id of ['preg-1', 'preg-2', 'preg-3', 'pp-1', 'pp-2']) {
        extractor.setExtraction(`${id}-note`, { hasPlan: false });
      }
      const harness = await harnessWith(extractor);
      const prenatal = (id: string, at: number) =>
        visit(id, at, {
          specialty: 'gynecology',
          noteText: 'Embarazo en evolución normal.',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        });
      await day(harness, -300, [prenatal('preg-1', -300)]);
      await day(harness, -272, [prenatal('preg-2', -272)]);
      await day(harness, -244, [prenatal('preg-3', -244)]);
      await day(harness, -200, [
        visit('pp-1', -200, {
          specialty: 'gynecology',
          noteText: 'Puérpera de 9 días sin complicaciones.',
          diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
        }),
      ]);
      await day(harness, -158, [
        visit('pp-2', -158, {
          specialty: 'gynecology',
          noteText: 'Puerperio tardío normal. Inicia anticoncepción.',
          diagnoses: [
            { icd10: 'Z39.2', display: 'puerperio' },
            { icd10: 'Z30.0', display: 'anticoncepción' },
          ],
        }),
      ]);
      await day(harness, 0);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot).flat()).not.toContain('cadence_break');
    });

    it('an acute episode and its control are not a visit pattern', async () => {
      const extractor = new FakeNoteExtractor()
        .setExtraction('acute-note', { hasPlan: false })
        .setExtraction('control-note', { hasPlan: false });
      const harness = await harnessWith(extractor);
      await day(harness, -10, [
        visit('acute', -10, {
          specialty: 'internal_medicine',
          noteText: 'Faringoamigdalitis. Amoxicilina 500 mg c/8h x 7 días.',
          diagnoses: [{ icd10: 'J02.9', display: 'faringoamigdalitis' }],
          prescriptions: [
            { text: 'Amoxicilina 500 mg', atc: 'J01CA04', supplyDays: 7, dosage: '1 cáps VO c/8h' },
          ],
        }),
      ]);
      await day(harness, 0, [
        visit('control', 0, {
          specialty: 'internal_medicine',
          noteText: 'Control post tratamiento. Asintomático.',
        }),
      ]);
      await day(harness, 60);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('a chronic visit pattern survives an acute episode in between', async () => {
      const extractor = new FakeNoteExtractor();
      const harness = await harnessWith(extractor);
      for (const at of [-240, -180, -120]) {
        extractor.setExtraction(`htn${String(-at)}-note`, { hasPlan: false });
        await day(harness, at, [
          visit(`htn${String(-at)}`, at, {
            specialty: 'internal_medicine',
            noteText: 'HTA controlada.',
            diagnoses: [{ icd10: 'I10', display: 'HTA' }],
          }),
        ]);
      }
      extractor
        .setExtraction('flu-note', { hasPlan: false })
        .setExtraction('flu-control-note', { hasPlan: false });
      await day(harness, -100, [
        visit('flu', -100, {
          specialty: 'internal_medicine',
          noteText: 'Faringoamigdalitis.',
          prescriptions: [{ text: 'Amoxicilina 500 mg', atc: 'J01CA04', supplyDays: 7 }],
        }),
      ]);
      await day(harness, -90, [
        visit('flu-control', -90, {
          specialty: 'internal_medicine',
          noteText: 'Control post tratamiento. Asintomático.',
        }),
      ]);
      const [cadence] = live(ofRule(await snapshotPatient(harness, patient), 'cadence_break'));
      // Usual interval of the chronic pattern (60 days), not of the episode (10 days).
      expect(cadence?.dueAt).toEqual(dayToDate(-90 + 3 * 60));
    });

    it('a discharge read after the visit (retried extraction) withdraws the visit pattern', async () => {
      const extractor = new FakeNoteExtractor();
      const harness = await harnessWith(extractor);
      for (const at of [-21, -14, -7]) {
        extractor.setExtraction(`psy${String(-at)}-note`, {
          planItems: [planItem('session', at + 7, 'próxima sesión en 1 semana')],
        });
        await day(harness, at, [
          visit(`psy${String(-at)}`, at, {
            specialty: 'psychology',
            noteText: 'Sesión. Próxima sesión en 1 semana.',
          }),
        ]);
      }
      extractor.failFor('psy0-note');
      await day(harness, 0, [
        visit('psy0', 0, {
          specialty: 'psychology',
          noteText: 'Se revisan logros del proceso. Se da de alta.',
        }),
      ]);
      expect(live(ofRule(await snapshotPatient(harness, patient), 'cadence_break'))).toHaveLength(
        1,
      );
      extractor.recover().setExtraction('psy0-note', { hasPlan: true, discharged: true });
      await harness.engine.runNoteExtractionJob(harness.clinicId, {
        patientId: PATIENT,
        documentId: 'psy0-note',
      });
      await day(harness, 90);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });
    it('a planned session is the next visit: a therapy dropout is one reason, not plan + cadence', async () => {
      const extractor = new FakeNoteExtractor();
      const harness = await harnessWith(extractor);
      for (const at of [-60, -53, -46]) {
        extractor.setExtraction(`drop${String(-at)}-note`, {
          planItems: [planItem('session', at + 7, 'próxima sesión en 1 semana')],
        });
        await day(harness, at, [
          visit(`drop${String(-at)}`, at, {
            specialty: 'psychology',
            noteText: 'Sesión. Próxima sesión en 1 semana.',
          }),
        ]);
      }
      await day(harness, 0);
      expect(activeRuleIds(await snapshotPatient(harness, patient))).toEqual([
        ['doctor_plan_followup'],
      ]);
    });

    it('a discharge note not linked to its consultation still ends the visit pattern', async () => {
      const extractor = new FakeNoteExtractor();
      const harness = await harnessWith(extractor);
      for (const at of [-21, -14, -7]) {
        extractor.setExtraction(`psy${String(-at)}-note`, {
          planItems: [planItem('session', at + 7, 'próxima sesión en 1 semana')],
        });
        await day(harness, at, [
          visit(`psy${String(-at)}`, at, {
            specialty: 'psychology',
            noteText: 'Sesión. Próxima sesión en 1 semana.',
          }),
        ]);
      }
      extractor
        .setExtraction('psy0-note', { hasPlan: false })
        .setExtraction('psy0-summary', { hasPlan: true, discharged: true });
      await day(harness, 0, [
        visit('psy0', 0, { specialty: 'psychology', noteText: 'Sesión de cierre.' }),
      ]);
      expect(live(ofRule(await snapshotPatient(harness, patient), 'cadence_break'))).toHaveLength(
        1,
      );
      // Hours later the summary arrives alone, without saying which consultation it closes.
      await day(harness, 0.25, [
        unlinkedNoteBundle({
          id: 'psy0-summary',
          patientId: PATIENT,
          specialty: 'psychology',
          at: dayToDate(0.25),
          text: 'Se revisan logros del proceso. Se da de alta.',
        }),
      ]);
      await day(harness, 90);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });
  });

  describe('short treatment', () => {
    it('a chronic medication dispensed 30 days at a time with refills is not a short treatment', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('statin-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('statin', 0, {
          specialty: 'internal_medicine',
          noteText: 'Dislipidemia. Atorvastatina 20 mg HS.',
          diagnoses: [{ icd10: 'E78.5', display: 'dislipidemia' }],
          prescriptions: [
            {
              text: 'Atorvastatina 20 mg',
              atc: 'C10AA05',
              supplyDays: 30,
              refills: 11,
              dosage: '1 tab VO HS',
            },
          ],
        }),
      ]);
      expect(ofRule(await snapshotPatient(harness, patient), 'short_treatment_followup')).toEqual(
        [],
      );
    });

    it('a chronic drug class is not a short treatment even without refills', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('losartan-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('losartan', 0, {
          specialty: 'internal_medicine',
          noteText: 'HTA. Losartán 50 mg.',
          prescriptions: [{ text: 'Losartán 50 mg', supplyDays: 30 }],
        }),
      ]);
      expect(ofRule(await snapshotPatient(harness, patient), 'short_treatment_followup')).toEqual(
        [],
      );
    });

    it('an antibiotic course still expects its control (true positive kept)', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('abx-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('abx', 0, {
          specialty: 'internal_medicine',
          noteText: 'ITU. Nitrofurantoína 100 mg c/12h x 7 días.',
          prescriptions: [{ text: 'Nitrofurantoína 100 mg', atc: 'J01XE01', supplyDays: 7 }],
        }),
      ]);
      const [expectation] = ofRule(
        await snapshotPatient(harness, patient),
        'short_treatment_followup',
      );
      expect(expectation?.dueAt).toEqual(dayToDate(10));
    });

    it('"reconsultar si persiste" is not a mandatory control', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('vaginitis-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('vaginitis', 0, {
          specialty: 'gynecology',
          noteText:
            'Dx: vaginitis. Indicaciones: metronidazol óvulos 500 mg HS x 7 días. Reconsultar si persiste.',
          diagnoses: [{ icd10: 'N76.0', display: 'vaginitis' }],
          prescriptions: [{ text: 'Metronidazol óvulos 500 mg', atc: 'G01AF01', supplyDays: 7 }],
        }),
      ]);
      await day(harness, 30);
      const snapshot = await snapshotPatient(harness, patient);
      expect(ofRule(snapshot, 'short_treatment_followup')).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('PRN analgesics and the doctor’s own control make one reason, not three', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('pharyngitis-note', {
          planItems: [planItem('follow_up_visit', 10, 'Cita control en 10 días')],
        }),
      );
      await day(harness, 0, [
        visit('pharyngitis', 0, {
          specialty: 'internal_medicine',
          noteText:
            'Dx: faringoamigdalitis. Plan: amoxicilina 500 mg c/8h x 7 días. ibuprofeno 400 mg c/8h PRN dolor x 5 días. Cita control en 10 días.',
          diagnoses: [{ icd10: 'J02.9', display: 'faringoamigdalitis' }],
          prescriptions: [
            { text: 'Amoxicilina 500 mg', atc: 'J01CA04', supplyDays: 7, dosage: '1 cáps VO c/8h' },
            {
              text: 'Ibuprofeno 400 mg',
              atc: 'M01AE01',
              supplyDays: 5,
              dosage: '1 tab VO c/8h PRN dolor',
            },
          ],
        }),
      ]);
      await day(harness, 20);
      expect(activeRuleIds(await snapshotPatient(harness, patient))).toEqual([
        ['doctor_plan_followup'],
      ]);
    });
  });

  describe('abnormal result', () => {
    async function diabeticWithHba1c(value: number, flag: string, diagnosed = true) {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('dm-note', {
          planItems: [
            planItem('follow_up_visit', 90, 'Control en 3 meses'),
            planItem('lab', 90, 'Se solicita HbA1c', HBA1C),
          ],
        }),
      );
      await day(harness, 0, [
        visit('dm', 0, {
          specialty: diagnosed ? 'diabetology' : 'internal_medicine',
          noteText: diagnosed
            ? 'DM2 en metas. Se solicita HbA1c. Control en 3 meses.'
            : 'Chequeo. Se solicita HbA1c. Control en 3 meses.',
          ...(diagnosed ? { diagnoses: [{ icd10: 'E11.9', display: 'DM2' }] } : {}),
          orders: [{ loinc: '4548-4', display: 'Hemoglobina glicosilada (HbA1c)' }],
        }),
      ]);
      await day(harness, 3, [
        labResultBundle({
          id: 'dm-hba1c',
          patientId: PATIENT,
          loinc: '4548-4',
          display: 'Hemoglobina glicosilada (HbA1c)',
          at: dayToDate(3),
          value,
          unit: '%',
          flag,
          orderId: orderIdOf('dm', 1),
        }),
      ]);
      await day(harness, 16);
      return snapshotPatient(harness, patient);
    }

    it('an at-goal HbA1c in a known diabetic (lab flag H) is not an abnormal result', async () => {
      const snapshot = await diabeticWithHba1c(6.4, 'H');
      expect(ofRule(snapshot, 'abnormal_result_followup')).toEqual([]);
      expect(activeRuleIds(snapshot).flat()).not.toContain('abnormal_result_followup');
    });

    it('an HbA1c above the diabetic target still opens the abnormal result case', async () => {
      const snapshot = await diabeticWithHba1c(9.1, 'H');
      expect(activeRuleIds(snapshot).flat()).toContain('abnormal_result_followup');
    });

    it('a high HbA1c in a patient with no known diabetes is an abnormal result', async () => {
      const snapshot = await diabeticWithHba1c(7.0, 'H', false);
      expect(activeRuleIds(snapshot).flat()).toContain('abnormal_result_followup');
    });

    it('a control already planned before the due date covers the abnormal result', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('ckd-note', {
          planItems: [planItem('follow_up_visit', 5, 'Control en 5 días con resultados')],
        }),
      );
      await day(harness, 0, [
        visit('ckd', 0, {
          specialty: 'internal_medicine',
          noteText: 'Se solicita creatinina. Control en 5 días con resultados.',
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      await day(harness, 1, [
        labResultBundle({
          id: 'ckd-creat',
          patientId: PATIENT,
          loinc: '2160-0',
          display: 'Creatinina',
          at: dayToDate(1),
          value: 1.9,
          unit: 'mg/dL',
          flag: 'H',
          orderId: orderIdOf('ckd', 1),
        }),
      ]);
      expect(ofRule(await snapshotPatient(harness, patient), 'abnormal_result_followup')).toEqual(
        [],
      );
    });
  });

  describe('protocols only fill gaps', () => {
    it('the doctor’s plan HbA1c covers the protocol HbA1c, even when the plan item has no code', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('dmplan-note', {
          planItems: [
            planItem('follow_up_visit', 90, 'Plan: control en 3 meses con HbA1c'),
            planItem('lab', 90, 'Plan: control en 3 meses con HbA1c'),
          ],
        }),
      );
      await day(harness, 0, [
        visit('dmplan', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Plan: control en 3 meses con HbA1c.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(ofRule(snapshot, 'protocol_diabetes_hba1c')).toEqual([]);
      expect(ofRule(snapshot, 'protocol_diabetes_visit')).toEqual([]);
    });

    it('an order of the overdue test withdraws the protocol item: one reason, the pending result', async () => {
      const extractor = new FakeNoteExtractor()
        .setExtraction('htn1-note', { hasPlan: false })
        .setExtraction('htn2-note', { hasPlan: false });
      const harness = await harnessWith(extractor);
      await day(harness, -400, [
        visit('htn1', -400, {
          specialty: 'internal_medicine',
          noteText: 'HTA. Se solicita creatinina.',
          diagnoses: [{ icd10: 'I10', display: 'HTA' }],
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      await day(harness, -396, [
        labResultBundle({
          id: 'htn1-creat',
          patientId: PATIENT,
          loinc: '2160-0',
          display: 'Creatinina',
          at: dayToDate(-396),
          value: 0.9,
          unit: 'mg/dL',
          flag: 'N',
          orderId: orderIdOf('htn1', 1),
        }),
      ]);
      await day(harness, -20);
      // The yearly labs are overdue (day -31): the doctor orders them again.
      await day(harness, -15, [
        visit('htn2', -15, {
          specialty: 'internal_medicine',
          noteText: 'HTA. Se solicita creatinina.',
          diagnoses: [{ icd10: 'I10', display: 'HTA' }],
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      await day(harness, 30);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'protocol_hypertension_labs'))).toEqual([]);
      expect(activeRuleIds(snapshot).flat().sort()).toEqual(['lab_order_result_pending']);
    });

    it('an ordered lipid panel of another LOINC covers the protocol lipid item', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('lipids-note', {
          planItems: [planItem('follow_up_visit', 90, 'control en 3 meses')],
        }),
      );
      await day(harness, 0, [
        visit('lipids', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Plan: control en 3 meses con HbA1c y perfil lipídico.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          orders: [
            { loinc: '4548-4', display: 'HbA1c' },
            { loinc: '57698-3', display: 'Perfil lipídico' },
          ],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(ofRule(snapshot, 'lab_order_result_pending')).toHaveLength(2);
      expect(ofRule(snapshot, 'protocol_diabetes_lipids')).toEqual([]);
      expect(ofRule(snapshot, 'protocol_diabetes_hba1c')).toEqual([]);
    });
  });
}

describe('clinical calibration, HIP-123 (memory)', () => {
  calibration((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('clinical calibration, HIP-123'), () => {
  const database = useIsolatedDatabase();
  calibration((options) => postgresHarness(database(), options));
});
