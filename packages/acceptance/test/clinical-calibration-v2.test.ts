import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  type PlanItem,
  patientId,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  type CalibrationConsultation,
  type CalibrationPrescription,
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
 * HIP-123, second round of the clinical calibration (QA round 2,
 * clinical-verify.json #4, #7, #8, clinical.json #6 and api-fhir.json #6):
 * each scenario reproduces a false positive the clinical review still found,
 * with a control that keeps the true positive.
 */

const PATIENT = 'pat-calibration-v2';
const patient = patientId(PATIENT);

function planItem(kind: PlanItem['kind'], dueDay: number, quote: string): PlanItem {
  return {
    kind,
    description: kind === 'lab' ? 'laboratory test' : 'follow-up visit',
    dueAt: dayToDate(dueDay),
    evidenceQuote: quote,
    confidence: 0.9,
  };
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

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
}

/** Watcher and escalation every day from `from` to `to`, as the worker does. */
async function daysPass(harness: EngineHarness, from: number, to: number) {
  for (let n = from; n <= to; n += 1) {
    const now = dayToDate(n);
    harness.clock.set(now);
    await harness.engine.runWatcher(harness.clinicId, now);
    await harness.engine.runEscalation(harness.clinicId, now);
  }
}

function ofRule(snapshot: PatientSnapshot, ruleId: string): Expectation[] {
  return snapshot.expectations.filter((expectation) => expectation.ruleId === ruleId);
}

function live(expectations: readonly Expectation[]): Expectation[] {
  return expectations.filter((e) => e.status === 'open' || e.status === 'expired');
}

function activeRuleIds(snapshot: PatientSnapshot): string[] {
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .flatMap((followUpCase) => [...followUpCase.ruleIds])
    .sort();
}

function calibration(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (
    extractor: FakeNoteExtractor,
    options: Partial<HarnessOptions> = {},
  ): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-calibration-v2-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor,
      ...options,
    });
  };

  describe('cadence: a visit and its own planned control are an episode', () => {
    it('an acute problem without a prescription and its control are not a visit pattern', async () => {
      const extractor = new FakeNoteExtractor()
        .setExtraction('sprain-note', {
          planItems: [planItem('follow_up_visit', 0, 'Control en 10 dias')],
        })
        .setExtraction('sprain-control-note', { hasPlan: false });
      const harness = await harnessWith(extractor);
      await day(harness, -10, [
        visit('sprain', -10, {
          specialty: 'internal_medicine',
          noteText: 'Esguince de tobillo grado I. Reposo, hielo y vendaje. Control en 10 dias.',
          diagnoses: [{ icd10: 'S93.4', display: 'esguince de tobillo' }],
        }),
      ]);
      await day(harness, 0, [
        visit('sprain-control', 0, {
          specialty: 'internal_medicine',
          noteText: 'Control de esguince. Resuelto. Sin dolor.',
        }),
      ]);
      await day(harness, 90);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('any visit followed by the control its plan asked for is not a visit pattern', async () => {
      const extractor = new FakeNoteExtractor()
        .setExtraction('stable-note', {
          planItems: [planItem('follow_up_visit', -16, 'Plan: control en 14 dias')],
        })
        .setExtraction('stable-control-note', { hasPlan: false });
      const harness = await harnessWith(extractor);
      await day(harness, -30, [
        visit('stable', -30, {
          specialty: 'gynecology',
          noteText: 'Paciente estable. Plan: control en 14 dias.',
        }),
      ]);
      await day(harness, -18, [
        visit('stable-control', -18, { specialty: 'gynecology', noteText: 'Control. Estable.' }),
      ]);
      await day(harness, 120);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, 'cadence_break'))).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('repeated planned controls are a routine pattern: its break still opens (true positive)', async () => {
      const extractor = new FakeNoteExtractor();
      const harness = await harnessWith(extractor);
      for (const at of [-180, -120]) {
        extractor.setExtraction(`htn${String(-at)}-note`, {
          planItems: [planItem('follow_up_visit', at + 60, 'Control en 2 meses')],
        });
        await day(harness, at, [
          visit(`htn${String(-at)}`, at, {
            specialty: 'internal_medicine',
            noteText: 'HTA controlada. Control en 2 meses.',
          }),
        ]);
      }
      extractor.setExtraction('htn60-note', { hasPlan: false });
      await day(harness, -60, [
        visit('htn60', -60, { specialty: 'internal_medicine', noteText: 'HTA controlada.' }),
      ]);
      const [cadence] = live(ofRule(await snapshotPatient(harness, patient), 'cadence_break'));
      expect(cadence?.dueAt).toEqual(dayToDate(-60 + 3 * 60));
    });
  });

  describe('short treatment: chronic drug classes by ATC class', () => {
    const chronic: readonly CalibrationPrescription[] = [
      { text: 'Apixabán 5 mg', atc: 'B01AF02' },
      { text: 'Clopidogrel 75 mg', atc: 'B01AC04' },
      { text: 'Ácido acetilsalicílico 100 mg', atc: 'B01AC06' },
      { text: 'Budesonida/Formoterol 160/4,5 mcg inhalador', atc: 'R03AK07' },
      { text: 'Alopurinol 300 mg', atc: 'M04AA01' },
      { text: 'Tamsulosina 0,4 mg', atc: 'G04CA02' },
      { text: 'Donepezilo 10 mg', atc: 'N06DA02' },
    ];

    async function prescribed(prescription: CalibrationPrescription) {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('rx-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('rx', 0, {
          specialty: 'internal_medicine',
          noteText: `Se indica ${prescription.text}.`,
          prescriptions: [prescription],
        }),
      ]);
      await day(harness, 40);
      return snapshotPatient(harness, patient);
    }

    it.each(chronic)(
      'a 30-day $text ($atc) without refills is not a short treatment',
      async (drug) => {
        const snapshot = await prescribed({ ...drug, supplyDays: 30 });
        expect(ofRule(snapshot, 'short_treatment_followup')).toEqual([]);
        expect(activeRuleIds(snapshot)).toEqual([]);
      },
    );

    it.each(chronic.map(({ text }) => ({ text })))(
      'an uncoded 30-day $text is recognized by name',
      async (drug) => {
        const snapshot = await prescribed({ ...drug, supplyDays: 30 });
        expect(ofRule(snapshot, 'short_treatment_followup')).toEqual([]);
      },
    );

    it('a 30-day supply of a drug of unknown class is not a short treatment', async () => {
      const snapshot = await prescribed({ text: 'Fármaco sintético X 10 mg', supplyDays: 30 });
      expect(ofRule(snapshot, 'short_treatment_followup')).toEqual([]);
    });

    it.each([
      { text: 'Amoxicilina 500 mg', supplyDays: 7 },
      { text: 'Naproxeno 550 mg', supplyDays: 5 },
      { text: 'Fármaco sintético X 10 mg', supplyDays: 7 },
      { text: 'Ciprofloxacino 500 mg', atc: 'J01MA02', supplyDays: 10 },
    ])(
      'an acute or explicitly short course ($text, $supplyDays days) still expects its control',
      async (drug) => {
        const snapshot = await prescribed(drug);
        expect(ofRule(snapshot, 'short_treatment_followup')).toHaveLength(1);
      },
    );
  });

  describe('short treatment: "as needed" in free text', () => {
    it.each([
      '1 tab VO cada 8 horas por razones necesarias',
      '1 tab VO cada 8 horas si hay dolor',
      '1 tab VO en caso necesario',
      '1 tab VO en caso de crisis',
      '1 tab VO a demanda',
      '1 tab VO c/8h SOS',
      '1 tab VO c/8h PRN',
    ])('"%s" is taken only when needed: no end-of-treatment control', async (dosage) => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('prn-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('prn', 0, {
          specialty: 'internal_medicine',
          noteText: `Paracetamol 500 mg ${dosage}.`,
          prescriptions: [{ text: 'Paracetamol 500 mg', atc: 'N02BE01', supplyDays: 5, dosage }],
        }),
      ]);
      await day(harness, 40);
      const snapshot = await snapshotPatient(harness, patient);
      expect(ofRule(snapshot, 'short_treatment_followup')).toEqual([]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('a scheduled dosage of the same drug still expects its control (true positive)', async () => {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('sched-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('sched', 0, {
          specialty: 'internal_medicine',
          noteText: 'Paracetamol 500 mg 1 tab VO cada 8 horas por 5 días.',
          prescriptions: [
            {
              text: 'Paracetamol 500 mg',
              atc: 'N02BE01',
              supplyDays: 5,
              dosage: '1 tab VO cada 8 horas por 5 días',
            },
          ],
        }),
      ]);
      expect(
        ofRule(await snapshotPatient(harness, patient), 'short_treatment_followup'),
      ).toHaveLength(1);
    });
  });

  describe('LOINC-equivalent results', () => {
    async function orderedThenResult(
      orders: readonly { loinc: string; display: string }[],
      results: readonly { loinc: string; display: string; value: number; unit: string }[],
    ) {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('lab-note', { hasPlan: false }),
      );
      await day(harness, 0, [
        visit('lab', 0, { specialty: 'internal_medicine', noteText: 'Chequeo.', orders }),
      ]);
      await day(
        harness,
        1,
        results.map((result, index) =>
          labResultBundle({
            id: `lab-result-${String(index)}`,
            patientId: PATIENT,
            loinc: result.loinc,
            display: result.display,
            at: dayToDate(1),
            value: result.value,
            unit: result.unit,
            flag: 'N',
          }),
        ),
      );
      await day(harness, 40);
      return snapshotPatient(harness, patient);
    }

    it('an HbA1c order is fulfilled by an HbA1c result of another method code (17856-6)', async () => {
      const snapshot = await orderedThenResult(
        [{ loinc: '4548-4', display: 'HbA1c' }],
        [{ loinc: '17856-6', display: 'HbA1c (HPLC)', value: 6.0, unit: '%' }],
      );
      expect(ofRule(snapshot, 'lab_order_result_pending').map((e) => e.status)).toEqual([
        'fulfilled',
      ]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('an HbA1c order is fulfilled by an IFCC HbA1c in mmol/mol (59261-8)', async () => {
      const snapshot = await orderedThenResult(
        [{ loinc: '4548-4', display: 'HbA1c' }],
        [{ loinc: '59261-8', display: 'HbA1c IFCC', value: 42, unit: 'mmol/mol' }],
      );
      expect(ofRule(snapshot, 'lab_order_result_pending').map((e) => e.status)).toEqual([
        'fulfilled',
      ]);
    });

    it('a lipid panel order is fulfilled by its component results', async () => {
      const snapshot = await orderedThenResult(
        [{ loinc: '57698-3', display: 'Perfil lipídico' }],
        [
          { loinc: '2093-3', display: 'Colesterol total', value: 180, unit: 'mg/dL' },
          { loinc: '2085-9', display: 'HDL', value: 50, unit: 'mg/dL' },
        ],
      );
      expect(ofRule(snapshot, 'lab_order_result_pending').map((e) => e.status)).toEqual([
        'fulfilled',
      ]);
      expect(activeRuleIds(snapshot)).toEqual([]);
    });

    it('an LDL order is fulfilled by a direct LDL result', async () => {
      const snapshot = await orderedThenResult(
        [{ loinc: '13457-7', display: 'LDL calculado' }],
        [{ loinc: '18262-6', display: 'LDL directo', value: 110, unit: 'mg/dL' }],
      );
      expect(ofRule(snapshot, 'lab_order_result_pending').map((e) => e.status)).toEqual([
        'fulfilled',
      ]);
    });

    it('an HDL result does not fulfill an LDL order (control)', async () => {
      const snapshot = await orderedThenResult(
        [{ loinc: '13457-7', display: 'LDL calculado' }],
        [{ loinc: '2085-9', display: 'HDL', value: 50, unit: 'mg/dL' }],
      );
      expect(live(ofRule(snapshot, 'lab_order_result_pending'))).toHaveLength(1);
    });

    async function knownDiabeticResult(result: {
      loinc: string;
      display: string;
      value: number;
      unit: string;
      diagnosed?: boolean;
    }) {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('dm-note', {
          planItems: [planItem('follow_up_visit', 90, 'Control en 3 meses')],
        }),
      );
      await day(harness, 0, [
        visit('dm', 0, {
          specialty: 'diabetology',
          noteText: 'Control en 3 meses.',
          ...(result.diagnosed === false
            ? {}
            : { diagnoses: [{ icd10: 'E11.9', display: 'DM2' }] }),
        }),
      ]);
      await day(harness, 3, [
        labResultBundle({
          id: 'dm-hba1c',
          patientId: PATIENT,
          loinc: result.loinc,
          display: result.display,
          at: dayToDate(3),
          value: result.value,
          unit: result.unit,
          flag: 'H',
        }),
      ]);
      await day(harness, 40);
      return snapshotPatient(harness, patient);
    }

    it('an at-goal HbA1c of another method code (17856-6, 7.0 %) in a known diabetic is not abnormal', async () => {
      const snapshot = await knownDiabeticResult({
        loinc: '17856-6',
        display: 'HbA1c (HPLC)',
        value: 7.0,
        unit: '%',
      });
      expect(ofRule(snapshot, 'abnormal_result_followup')).toEqual([]);
    });

    it('an at-goal IFCC HbA1c (53 mmol/mol = 7.0 %) in a known diabetic is not abnormal and fulfills the protocol item', async () => {
      const snapshot = await knownDiabeticResult({
        loinc: '59261-8',
        display: 'HbA1c IFCC',
        value: 53,
        unit: 'mmol/mol',
      });
      expect(ofRule(snapshot, 'abnormal_result_followup')).toEqual([]);
      // The protocol's next HbA1c counts from this result.
      expect(live(ofRule(snapshot, 'protocol_diabetes_hba1c')).map((e) => e.dueAt)).toEqual([
        dayToDate(3 + 90),
      ]);
    });

    it('an IFCC HbA1c above the converted target (75 mmol/mol = 9.0 %) is still abnormal', async () => {
      const snapshot = await knownDiabeticResult({
        loinc: '59261-8',
        display: 'HbA1c IFCC',
        value: 75,
        unit: 'mmol/mol',
      });
      expect(activeRuleIds(snapshot)).toContain('abnormal_result_followup');
    });

    it('an IFCC HbA1c of 53 mmol/mol in a patient with no known diabetes is abnormal', async () => {
      const snapshot = await knownDiabeticResult({
        loinc: '59261-8',
        display: 'HbA1c IFCC',
        value: 53,
        unit: 'mmol/mol',
        diagnosed: false,
      });
      expect(activeRuleIds(snapshot)).toContain('abnormal_result_followup');
    });
  });

  describe('old history sent through live ingestion', () => {
    const contactClinic = { settings: { allowPatientContact: true } } as const;

    async function oldOrder(orderDay: number) {
      const harness = await harnessWith(
        new FakeNoteExtractor().setExtraction('old-note', { hasPlan: false }),
        contactClinic,
      );
      // Received today (day 0), dated `orderDay`.
      await day(harness, 0, [
        visit('old', orderDay, {
          specialty: 'internal_medicine',
          noteText: 'Se solicita creatinina.',
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
      ]);
      await daysPass(harness, 1, 60);
      const events = await harness.pendingEvents();
      const snapshot = await snapshotPatient(harness, patient);
      const inbox = await harness.read((stores) =>
        stores.cases.list(harness.clinicId, { releasedAsOf: dayToDate(60), limit: 100 }),
      );
      const recovery = await harness.read((stores) =>
        stores.cases.list(harness.clinicId, {
          origin: 'backfill',
          unreleasedAsOf: dayToDate(60),
          limit: 100,
        }),
      );
      return {
        snapshot,
        types: events.map((event) => event.type),
        inbox: inbox.items,
        recovery: recovery.items,
      };
    }

    it('an order overdue by more than the backfill age window is held among the patients to recover', async () => {
      const result = await oldOrder(
        Math.round((Date.UTC(1950, 0, 1) - BASE_DATE.getTime()) / 864e5),
      );
      expect(result.snapshot.cases).toHaveLength(1);
      expect(result.recovery.map((followUpCase) => followUpCase.patientId)).toEqual([patient]);
      expect(result.inbox).toEqual([]);
      expect(result.types).not.toContain('case.opened');
      expect(result.types).not.toContain('patient_contact.requested');
    });

    it('an order 200 days old opens a visible case but never asks to contact the patient', async () => {
      const result = await oldOrder(-200);
      expect(result.inbox.map((followUpCase) => followUpCase.patientId)).toEqual([patient]);
      expect(result.types).toContain('case.opened');
      expect(result.types).not.toContain('patient_contact.requested');
    });

    it('a fresh order left unmet still asks to contact the patient (true positive)', async () => {
      const result = await oldOrder(0);
      expect(result.types).toContain('case.opened');
      expect(result.types).toContain('patient_contact.requested');
    });

    it('live ingestion warns about clinical dates long before receipt', () => {
      const mapped = mapBundleToBatches(
        visit('old-warning', -200, {
          specialty: 'internal_medicine',
          noteText: 'Se solicita creatinina.',
          orders: [{ loinc: '2160-0', display: 'Creatinina' }],
        }),
        { clinicId: clinicId('clinic-warning'), receivedAt: dayToDate(0), checkFutureDates: true },
      );
      const warnings = (mapped.issues?.issue ?? []).filter((issue) => issue.severity === 'warning');
      expect(warnings.map((issue) => issue.diagnostics).join(' ')).toMatch(/before/);
      expect(mapped.batches.length).toBeGreaterThan(0);
    });
  });
}

describe('clinical calibration v2, HIP-123 (memory)', () => {
  calibration((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('clinical calibration v2, HIP-123'), () => {
  const database = useIsolatedDatabase();
  calibration((options) => postgresHarness(database(), options));
});
