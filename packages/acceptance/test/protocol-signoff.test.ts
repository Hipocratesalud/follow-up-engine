import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type ClinicSettings, type Expectation, patientId } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  type CalibrationConsultation,
  consultationBundle,
  labResultBundle,
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
 * Clinical sign-off package, MVP diabetes and hypertension protocols
 * (docs/protocols/signoff/diabetes.md, hypertension.md): one scenario per
 * point the sign-off page lists (an item firing, due the day the config
 * says) and per exception it lists (a suggestion the protocol suppresses).
 * `generate-protocol-signoff.ts` quotes these test names in each page's
 * appendix, so the mapping point -> test is the title itself: every test
 * name starts with the item's or exception's reason code.
 */

const PATIENT = 'pat-signoff';
const patient = patientId(PATIENT);
const NEUTRAL_NOTE = 'Paciente evaluado. Sin cambios en el plan.';

function visit(
  id: string,
  at: number,
  input: Omit<CalibrationConsultation, 'consultationId' | 'patient' | 'occurredAt' | 'noteText'> & {
    readonly noteText?: string;
  },
): unknown {
  return consultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética', gender: 'female', birthDate: '1975-02-10' },
    occurredAt: dayToDate(at),
    noteText: NEUTRAL_NOTE,
    ...input,
  });
}

function lab(id: string, at: number, loinc: string, value: number, unit: string): unknown {
  return labResultBundle({
    id,
    patientId: PATIENT,
    loinc,
    display: loinc,
    at: dayToDate(at),
    value,
    unit,
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

function live(expectations: readonly Expectation[]): Expectation[] {
  return expectations.filter((e) => e.status === 'open' || e.status === 'expired');
}

function liveDue(snapshot: PatientSnapshot, ruleId: string): number[] {
  return live(ofRule(snapshot, ruleId))
    .map((expectation) =>
      Math.round((expectation.dueAt.getTime() - BASE_DATE.getTime()) / 86_400_000),
    )
    .sort((left, right) => left - right);
}

function protocolSignoff(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (settings: Partial<ClinicSettings> = {}): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-signoff-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
      settings,
    });
  };

  describe('diabetes protocol: every listed point fires, due the day the config says', () => {
    it('protocol_diabetes_visit fires 180 days after enrollment, then 180 days after the next visit', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-visit-0', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_visit')).toEqual([
        180,
      ]);
      await day(harness, 100, [visit('dm-visit-1', 100, { specialty: 'diabetology' })]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_visit')).toEqual([
        280,
      ]);
    });

    it('protocol_diabetes_hba1c fires 90 days after enrollment, then 90 days after the last HbA1c', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-hba1c-0', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_hba1c')).toEqual([
        90,
      ]);
      await day(harness, 60, [lab('dm-hba1c-result', 60, '4548-4', 8.0, '%')]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_hba1c')).toEqual([
        150,
      ]);
    });

    it('protocol_diabetes_lipids fires 365 days after enrollment, then 365 days after the last panel', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-lipids-0', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_lipids')).toEqual([
        365,
      ]);
      await day(harness, 200, [lab('dm-lipids-result', 200, '24331-1', 180, 'mg/dL')]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_lipids')).toEqual([
        565,
      ]);
    });

    it('protocol_diabetes_fundus fires 365 days after enrollment, then 365 days after the eye exam', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-fundus-0', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_fundus')).toEqual([
        365,
      ]);
      // An ophthalmology visit counts as the fundus exam, no coded result needed.
      await day(harness, 300, [visit('dm-fundus-1', 300, { specialty: 'ophthalmology' })]);
      expect(liveDue(await snapshotPatient(harness, patient), 'protocol_diabetes_fundus')).toEqual([
        665,
      ]);
    });
  });

  describe('diabetes protocol: every listed exception suppresses the item', () => {
    it('protocol_diabetes_hba1c covered_by_plan: an open HbA1c order suppresses the protocol item', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-covered-0', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          orders: [{ loinc: '4548-4', display: 'HbA1c' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      // The order itself proves the patient enrolled and the item would
      // otherwise have fired (see the plain hba1c scenario above).
      expect(live(ofRule(snapshot, 'lab_order_result_pending'))).toHaveLength(1);
      expect(ofRule(snapshot, 'protocol_diabetes_hba1c')).toEqual([]);
    });

    it('protocol_diabetes_lipids covered_by_protocol: dyslipidemia expects the same panel no later', async () => {
      const harness = await harnessWith({ enabledProtocols: ['diabetes', 'dyslipidemia'] });
      await day(harness, 0, [
        visit('dm-dyslipidemia-0', 0, {
          specialty: 'diabetology',
          noteText: 'DM2. Continuar metformina 850 mg. Se inicia atorvastatina 20 mg.',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          prescriptions: [
            { text: 'Metformina 850 mg', atc: 'A10BA02' },
            { text: 'Atorvastatina 20 mg', atc: 'C10AA05', dosage: '1 tab VO HS' },
          ],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      // Dyslipidemia's post-statin panel (84 days) is due sooner than the
      // diabetes yearly panel (365 days): one lipid panel, not two.
      expect(liveDue(snapshot, 'protocol_dyslipidemia_lipids')).toEqual([84]);
      expect(live(ofRule(snapshot, 'protocol_diabetes_lipids'))).toEqual([]);
    });
  });

  describe('hypertension protocol: every listed point fires, due the day the config says', () => {
    it('protocol_hypertension_visit fires 180 days after enrollment, then 180 days after the next visit', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('htn-visit-0', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'I10', display: 'HTA' }],
        }),
      ]);
      expect(
        liveDue(await snapshotPatient(harness, patient), 'protocol_hypertension_visit'),
      ).toEqual([180]);
      await day(harness, 90, [visit('htn-visit-1', 90, { specialty: 'internal_medicine' })]);
      expect(
        liveDue(await snapshotPatient(harness, patient), 'protocol_hypertension_visit'),
      ).toEqual([270]);
    });

    it('protocol_hypertension_labs fires 365 days after enrollment, then 365 days after the last result', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('htn-labs-0', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'I10', display: 'HTA' }],
        }),
      ]);
      expect(
        liveDue(await snapshotPatient(harness, patient), 'protocol_hypertension_labs'),
      ).toEqual([365]);
      await day(harness, 250, [lab('htn-creat', 250, '2160-0', 0.9, 'mg/dL')]);
      expect(
        liveDue(await snapshotPatient(harness, patient), 'protocol_hypertension_labs'),
      ).toEqual([615]);
    });
  });

  describe('hypertension protocol: every listed exception suppresses the item', () => {
    it('protocol_hypertension_labs covered_by_plan: an open creatinine order suppresses the protocol item', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('htn-covered-0', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'I10', display: 'HTA' }],
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'lab_order_result_pending'))).toHaveLength(1);
      expect(ofRule(snapshot, 'protocol_hypertension_labs')).toEqual([]);
    });

    it('protocol_hypertension_labs covered_by_protocol: chronic kidney disease expects creatinine no later', async () => {
      const harness = await harnessWith({
        enabledProtocols: ['hypertension', 'chronic_kidney_disease'],
      });
      await day(harness, 0, [
        visit('htn-ckd-0', 0, {
          specialty: 'internal_medicine',
          diagnoses: [
            { icd10: 'I10', display: 'HTA' },
            { icd10: 'N18.3', display: 'ERC estadio 3a' },
          ],
        }),
        // An eGFR of 35 (stage G3b) is monitored twice a year; hypertension's
        // own yearly creatinine never runs alongside it.
        lab('htn-ckd-egfr', 0, '62238-1', 35, 'mL/min/1.73m2'),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, 'protocol_chronic_kidney_disease_renal_function')).toEqual([182]);
      expect(live(ofRule(snapshot, 'protocol_hypertension_labs'))).toEqual([]);
    });
  });
}

describe('protocol sign-off, MVP diabetes and hypertension (memory)', () => {
  protocolSignoff((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('protocol sign-off, MVP diabetes and hypertension'),
  () => {
    const database = useIsolatedDatabase();
    protocolSignoff((options) => postgresHarness(database(), options));
  },
);
