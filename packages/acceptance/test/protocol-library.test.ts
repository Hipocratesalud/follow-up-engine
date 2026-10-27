import { FakeNoteExtractor, loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type ClinicSettings,
  type Expectation,
  isActiveCaseStatus,
  patientId,
  type PlanItem,
} from '@follow-up-engine/core';
import { TERMINOLOGY } from '@follow-up-engine/fhir';
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
import { dayOf, type PatientSnapshot, snapshotPatient } from '../src/scenario-runner.ts';

/*
 * HIP-137: protocol library v1. One scenario per behavior of the five new
 * draft protocols (pregnancy and postpartum, treatment follow-up for
 * depression/anxiety, hypothyroidism, dyslipidemia, chronic kidney
 * disease): enrollment by code, by medication and by lab; the doctor's plan
 * beats the protocol; a clinic that did not enable them gets nothing; a
 * pregnancy ends on a delivery and on a loss; the postpartum visit; a dose
 * change restarts the early control.
 */

const PATIENT = 'pat-protocols';
const patient = patientId(PATIENT);
const ALL_PROTOCOLS = loadConfigDirectory().protocols.map((protocol) => protocol.id);

const NEUTRAL_NOTE = 'Paciente estable. Se revisan resultados.';

function visit(
  id: string,
  at: number,
  input: Omit<CalibrationConsultation, 'consultationId' | 'patient' | 'occurredAt' | 'noteText'> & {
    readonly noteText?: string;
  },
): unknown {
  return consultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética', gender: 'female', birthDate: '1990-04-02' },
    occurredAt: dayToDate(at),
    noteText: NEUTRAL_NOTE,
    ...input,
  });
}

/** A lab result (report + one valued Observation) on `at`. */
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

/** An Observation whose value is a date (estimated delivery date, last menstrual period). */
function datedObservation(id: string, at: number, loinc: string, value: Date): unknown {
  const observation = {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: TERMINOLOGY.loinc, code: loinc }] },
    subject: { reference: `Patient/${PATIENT}` },
    effectiveDateTime: dayToDate(at).toISOString(),
    issued: dayToDate(at).toISOString(),
    valueDateTime: value.toISOString(),
  };
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [{ resource: observation, request: { method: 'PUT', url: `Observation/${id}` } }],
  };
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

/** Due days of the live expectations of a rule. */
function liveDue(snapshot: PatientSnapshot, ruleId: string): number[] {
  return live(ofRule(snapshot, ruleId))
    .map((expectation) => Math.round(dayOf(expectation.dueAt)))
    .sort((left, right) => left - right);
}

function activeReasons(snapshot: PatientSnapshot): string[] {
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .flatMap((followUpCase) => followUpCase.ruleIds);
}

const PRENATAL = 'protocol_pregnancy_prenatal_visit';
const OGTT = 'protocol_pregnancy_glucose_tolerance';
const POSTPARTUM = 'protocol_pregnancy_postpartum_visit';
const TREATMENT_VISIT = 'protocol_treatment_followup_visit';
const TSH = 'protocol_hypothyroidism_tsh';
const LIPIDS = 'protocol_dyslipidemia_lipids';
const DIABETES_LIPIDS = 'protocol_diabetes_lipids';
const RENAL = 'protocol_chronic_kidney_disease_renal_function';
const ALBUMINURIA = 'protocol_chronic_kidney_disease_albuminuria';
const RENAL_VISIT = 'protocol_chronic_kidney_disease_visit';

/** Day on which a pregnancy dated `weeks` weeks on day 0 reaches week `week`. */
const weekDay = (weeksOnDayZero: number, week: number): number => (week - weeksOnDayZero) * 7;

function planItem(dueDay: number, quote: string): PlanItem {
  return {
    kind: 'follow_up_visit',
    description: 'follow-up visit',
    dueAt: dayToDate(dueDay),
    evidenceQuote: quote,
    confidence: 0.9,
  };
}

function protocolLibrary(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (
    extractor = new FakeNoteExtractor(),
    settings: Partial<ClinicSettings> = { enabledProtocols: ALL_PROTOCOLS },
  ): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-protocols-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor,
      settings,
    });
  };

  /** A pregnancy coded Z34 on day 0 and dated by an estimated delivery date: 10 weeks on day 0. */
  const pregnancyStart = (id = 'preg-0'): unknown[] => [
    visit(id, 0, { specialty: 'gynecology', diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }] }),
    datedObservation(`${id}-edd`, 0, '11778-8', dayToDate(weekDay(10, 40))),
  ];

  describe('pregnancy and postpartum', () => {
    it('expects prenatal visits every 4 weeks up to 28, every 2 up to 36, weekly after', async () => {
      const harness = await harnessWith();
      await day(harness, 0, pregnancyStart());
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([28]);
      const prenatal = (id: string, week: number) =>
        visit(id, weekDay(10, week), {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        });
      await day(harness, weekDay(10, 30), [prenatal('preg-30', 30)]);
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([
        weekDay(10, 30) + 14,
      ]);
      await day(harness, weekDay(10, 37), [prenatal('preg-37', 37)]);
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([
        weekDay(10, 37) + 7,
      ]);
    });

    it('dates the pregnancy from the note ("embarazo de 30 semanas") when nothing else does', async () => {
      const extractor = new FakeNoteExtractor().setExtraction('preg-note-note', {
        hasPlan: false,
        pregnancy: { gestationalWeeks: 30, datingEvidenceQuote: 'embarazo de 30 semanas' },
      });
      const harness = await harnessWith(extractor);
      await day(harness, 0, [
        visit('preg-note', 0, {
          specialty: 'gynecology',
          noteText: 'Control prenatal, embarazo de 30 semanas.',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([14]);
    });

    it('expects the glucose tolerance test once the window opens, and only a result inside it counts', async () => {
      const harness = await harnessWith();
      await day(harness, 0, pregnancyStart());
      // A glucose challenge at 12 weeks is too early to count.
      await day(harness, weekDay(10, 12), [
        lab('ogtt-early', weekDay(10, 12), '1504-0', 120, 'mg/dL'),
      ]);
      expect(live(ofRule(await snapshotPatient(harness, patient), OGTT))).toEqual([]);
      await day(harness, weekDay(10, 25), [
        visit('preg-25', weekDay(10, 25), {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), OGTT)).toEqual([weekDay(10, 28)]);
      await day(harness, weekDay(10, 26), [lab('ogtt', weekDay(10, 26), '1518-0', 128, 'mg/dL')]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, OGTT))).toEqual([]);
      expect(ofRule(snapshot, OGTT).map((expectation) => expectation.closedReason)).toEqual([
        'fulfilled_by_result',
      ]);
    });

    it('ends on a delivery: nothing prenatal after it, the postpartum visit within 6 weeks', async () => {
      const harness = await harnessWith();
      await day(harness, 0, pregnancyStart());
      const delivery = weekDay(10, 39);
      await day(harness, delivery - 5, [
        visit('preg-38', delivery - 5, {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([delivery + 2]);
      // The hospital sends the delivery (O80) with its encounter.
      await day(harness, delivery, [
        visit('delivery', delivery, {
          specialty: 'obstetrics',
          diagnoses: [{ icd10: 'O80', display: 'parto' }],
        }),
      ]);
      let snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
      expect(ofRule(snapshot, PRENATAL).at(-1)?.closedReason).toBe('protocol_closed');
      expect(liveDue(snapshot, POSTPARTUM)).toEqual([delivery + 42]);
      const conditions = await harness.read((stores) =>
        stores.conditions.listByPatient(harness.clinicId, patient),
      );
      expect(conditions.find((condition) => condition.code.code === 'Z34.9')?.status).toBe(
        'resolved',
      );
      // No visit within 6 weeks: one case, the postpartum visit, never a prenatal reason.
      await day(harness, delivery + 50);
      snapshot = await snapshotPatient(harness, patient);
      expect(activeReasons(snapshot)).toContain(POSTPARTUM);
      expect(activeReasons(snapshot)).not.toContain(PRENATAL);
      expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
      // The postpartum visit resolves it.
      await day(harness, delivery + 52, [
        visit('postpartum', delivery + 52, {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
        }),
      ]);
      snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, POSTPARTUM))).toEqual([]);
      expect(activeReasons(snapshot)).toEqual([]);
    });

    it('ends on a delivery read from the note, dated when it happened', async () => {
      const delivery = weekDay(10, 39);
      const extractor = new FakeNoteExtractor().setExtraction('cesarean-note', {
        hasPlan: false,
        pregnancy: {
          outcome: {
            kind: 'cesarean_delivery',
            date: dayToDate(delivery),
            evidenceQuote: 'cesárea segmentaria hace 3 días',
          },
        },
      });
      const harness = await harnessWith(extractor);
      await day(harness, 0, pregnancyStart());
      // A phone follow-up three days after a cesarean at another hospital: not a visit of the protocol.
      await day(harness, delivery + 3, [
        visit('cesarean', delivery + 3, {
          specialty: 'internal_medicine',
          noteText: 'Paciente con cesárea segmentaria hace 3 días en otro centro.',
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
      expect(liveDue(snapshot, POSTPARTUM)).toEqual([delivery + 42]);
    });

    it('a puerperal visit that records the end is itself the postpartum visit', async () => {
      const harness = await harnessWith();
      await day(harness, 0, pregnancyStart());
      await day(harness, weekDay(10, 41), [
        visit('puerperal', weekDay(10, 41), {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
      expect(ofRule(snapshot, POSTPARTUM)).toEqual([]);
    });

    it('ends on a loss: nothing prenatal, no postpartum visit, and a new pregnancy enrolls again', async () => {
      const harness = await harnessWith();
      await day(harness, 0, pregnancyStart());
      await day(harness, 20, [
        visit('loss', 20, {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'O03.9', display: 'aborto espontáneo' }],
        }),
      ]);
      let snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
      expect(ofRule(snapshot, POSTPARTUM)).toEqual([]);
      await day(harness, 120);
      snapshot = await snapshotPatient(harness, patient);
      expect(activeReasons(snapshot)).not.toContain(PRENATAL);
      // A new pregnancy, months later.
      await day(harness, 200, [
        visit('preg-new', 200, {
          specialty: 'gynecology',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), PRENATAL)).toEqual([228]);
    });

    it("the doctor's planned control suppresses the protocol visit", async () => {
      const extractor = new FakeNoteExtractor().setExtraction('preg-plan-note', {
        planItems: [planItem(21, 'control prenatal en 3 semanas')],
      });
      const harness = await harnessWith(extractor);
      await day(harness, 0, [
        visit('preg-plan', 0, {
          specialty: 'gynecology',
          noteText: 'Embarazo normoevolutivo. Plan: control prenatal en 3 semanas.',
          diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(ofRule(snapshot, PRENATAL)).toEqual([]);
      expect(liveDue(snapshot, 'doctor_plan_followup')).toEqual([21]);
    });

    it('a clinic that did not enable the protocol gets nothing', async () => {
      const harness = await harnessWith(new FakeNoteExtractor(), {});
      await day(harness, 0, pregnancyStart());
      await day(harness, 120);
      const snapshot = await snapshotPatient(harness, patient);
      expect(snapshot.expectations.filter((e) => e.protocolId === 'pregnancy')).toEqual([]);
    });
  });

  describe('treatment follow-up (depression, anxiety)', () => {
    const sertraline = (mg: number) => ({
      text: `Sertralina ${String(mg)} mg`,
      atc: 'N06AB06',
      dosage: '1 tab VO OD',
    });

    it('a start, then monthly controls until 3 without change, then every 3 months; a dose change restarts the 2-4 week control', async () => {
      const harness = await harnessWith();
      // Psychotherapy for anxiety, then an antidepressant is started.
      await day(harness, -60, [
        visit('psy-1', -60, {
          specialty: 'psychology',
          diagnoses: [{ icd10: 'F41.1', display: 'TAG' }],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([30]);
      await day(harness, 0, [
        visit('psq-1', 0, { specialty: 'psychiatry', prescriptions: [sertraline(50)] }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([28]);
      await day(harness, 21, [visit('psy-2', 21, { specialty: 'psychology' })]);
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([51]);
      await day(harness, 50, [
        visit('psq-2', 50, { specialty: 'psychiatry', prescriptions: [sertraline(50)] }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([80]);
      await day(harness, 78, [
        visit('psq-3', 78, { specialty: 'psychiatry', prescriptions: [sertraline(50)] }),
      ]);
      // Three controls without a change: every 3 months.
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([168]);
      // The dose goes up: the next control is 2-4 weeks away again.
      await day(harness, 100, [
        visit('psq-4', 100, { specialty: 'psychiatry', prescriptions: [sertraline(100)] }),
      ]);
      let snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, TREATMENT_VISIT)).toEqual([128]);
      // Missed: a case, whose reason names no condition.
      await day(harness, 140);
      snapshot = await snapshotPatient(harness, patient);
      expect(activeReasons(snapshot)).toContain(TREATMENT_VISIT);
      const events = await harness.pendingEvents();
      const opened = events.filter((event) => event.type === 'case.opened');
      const text = JSON.stringify([
        opened.map((event) => event.payload),
        ofRule(snapshot, TREATMENT_VISIT).map((expectation) => [
          expectation.reason,
          expectation.ruleId,
          expectation.protocolId,
        ]),
      ]).toLowerCase();
      for (const word of [
        'depres',
        'ansie',
        'anxi',
        'antidep',
        'psiq',
        'psych',
        'mental',
        'ánimo',
        'animo',
        'sertral',
        'isrs',
        'ssri',
      ]) {
        expect(text).not.toContain(word);
      }
      for (const event of events.filter((item) => item.type === 'patient_contact.requested')) {
        expect(event.payload).toMatchObject({ purpose: 'schedule_follow_up' });
      }
    });

    it('a dose change sent without a control visit replaces the later control with the 2-4 week one', async () => {
      const harness = await harnessWith();
      for (const [id, at] of [
        ['psq-1', 0],
        ['psq-2', 25],
        ['psq-3', 55],
        ['psq-4', 85],
      ] as const) {
        await day(harness, at, [
          visit(id, at, { specialty: 'psychiatry', prescriptions: [sertraline(50)] }),
        ]);
      }
      expect(liveDue(await snapshotPatient(harness, patient), TREATMENT_VISIT)).toEqual([175]);
      // Adjusted by phone and sent with an unrelated consultation: no control took place.
      await day(harness, 100, [
        visit('other', 100, { specialty: 'nutrition', prescriptions: [sertraline(100)] }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, TREATMENT_VISIT)).toEqual([128]);
      expect(
        ofRule(snapshot, TREATMENT_VISIT).some(
          (expectation) => expectation.closedReason === 'rescheduled_by_protocol',
        ),
      ).toBe(true);
    });

    it('enrolls by the antidepressant alone, and the planned control suppresses the protocol one', async () => {
      const extractor = new FakeNoteExtractor().setExtraction('psq-plan-note', {
        planItems: [planItem(14, 'control en 2 semanas')],
      });
      const harness = await harnessWith(extractor);
      await day(harness, 0, [
        visit('psq-plan', 0, {
          specialty: 'psychiatry',
          noteText: 'Se inicia escitalopram 10 mg. Control en 2 semanas.',
          prescriptions: [{ text: 'Escitalopram 10 mg', dosage: '1 tab VO OD' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      const conditions = await harness.read((stores) =>
        stores.conditions.listByPatient(harness.clinicId, patient),
      );
      expect(
        conditions.map((condition) => [condition.code.code, condition.sourceType]),
      ).toContainEqual(['F32', 'inferred_from_medication']);
      expect(ofRule(snapshot, TREATMENT_VISIT)).toEqual([]);
      expect(liveDue(snapshot, 'doctor_plan_followup')).toEqual([14]);
    });
  });

  describe('hypothyroidism', () => {
    const levothyroxine = (mcg: number) => ({
      text: `Levotiroxina ${String(mcg)} mcg`,
      atc: 'H03AA01',
      dosage: '1 tab VO en ayunas',
    });

    it('TSH 6-8 weeks after a start or a dose change; a TSH too soon does not count', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('thy-1', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'E03.9', display: 'hipotiroidismo' }],
          prescriptions: [levothyroxine(50)],
        }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), TSH)).toEqual([56]);
      await day(harness, 10, [lab('tsh-early', 10, '3016-3', 7.8, 'mUI/L')]);
      expect(liveDue(await snapshotPatient(harness, patient), TSH)).toEqual([56]);
      await day(harness, 50, [lab('tsh-1', 50, '3016-3', 3.1, 'mUI/L')]);
      expect(liveDue(await snapshotPatient(harness, patient), TSH)).toEqual([415]);
      await day(harness, 120, [
        visit('thy-2', 120, { specialty: 'internal_medicine', prescriptions: [levothyroxine(75)] }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, TSH)).toEqual([176]);
      expect(ofRule(snapshot, TSH).map((expectation) => expectation.closedReason)).toContain(
        'rescheduled_by_protocol',
      );
    });

    it("an ordered TSH (the doctor's plan) covers the protocol item", async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('thy-order', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'E03.9', display: 'hipotiroidismo' }],
          prescriptions: [levothyroxine(50)],
          orders: [{ loinc: '3016-3', display: 'TSH' }],
        }),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(live(ofRule(snapshot, TSH))).toEqual([]);
      expect(liveDue(snapshot, 'lab_order_result_pending').length).toBe(1);
    });
  });

  describe('dyslipidemia', () => {
    const atorvastatin = { text: 'Atorvastatina 20 mg', atc: 'C10AA05', dosage: '1 tab VO HS' };

    it('enrolls by a statin alone: a lipid panel 4-12 weeks after the start, then yearly', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('lip-1', 0, { specialty: 'internal_medicine', prescriptions: [atorvastatin] }),
      ]);
      expect(liveDue(await snapshotPatient(harness, patient), LIPIDS)).toEqual([84]);
      // The panel arrives as its components.
      await day(harness, 60, [lab('ldl', 60, '13457-7', 98, 'mg/dL')]);
      expect(liveDue(await snapshotPatient(harness, patient), LIPIDS)).toEqual([425]);
    });

    it('a diabetic on a statin gets one lipid panel, not one per protocol', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('dm-1', 0, {
          specialty: 'diabetology',
          diagnoses: [{ icd10: 'E11.9', display: 'DM2' }],
          prescriptions: [{ text: 'Metformina 850 mg', atc: 'A10BA02' }, atorvastatin],
        }),
      ]);
      let snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, LIPIDS)).toEqual([84]);
      expect(live(ofRule(snapshot, DIABETES_LIPIDS))).toEqual([]);
      await day(harness, 60, [lab('panel', 60, '57698-3', 180, 'mg/dL')]);
      snapshot = await snapshotPatient(harness, patient);
      expect([...liveDue(snapshot, LIPIDS), ...liveDue(snapshot, DIABETES_LIPIDS)]).toEqual([425]);
    });
  });

  describe('chronic kidney disease', () => {
    it('enrolls on two eGFR below 60 at least 90 days apart, and follows the KDIGO stage', async () => {
      const harness = await harnessWith();
      await day(harness, -100, [
        visit('ckd-1', -100, { specialty: 'internal_medicine' }),
        lab('egfr-1', -100, '62238-1', 52, 'mL/min/1.73m2'),
      ]);
      expect(
        snapshotProtocol(await snapshotPatient(harness, patient), 'chronic_kidney_disease'),
      ).toEqual([]);
      await day(harness, 0, [lab('egfr-2', 0, '33914-3', 48, 'mL/min/{1.73_m2}')]);
      const snapshot = await snapshotPatient(harness, patient);
      // G3a, albuminuria unknown: labs yearly, a visit every 6 months.
      expect(liveDue(snapshot, RENAL)).toEqual([365]);
      expect(liveDue(snapshot, ALBUMINURIA)).toEqual([365]);
      expect(liveDue(snapshot, RENAL_VISIT)).toEqual([82]);
    });

    it('a coded N18.4 with severe albuminuria: labs every 3 months, visits every 3 months', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('ckd-4', 0, {
          specialty: 'internal_medicine',
          diagnoses: [{ icd10: 'N18.4', display: 'ERC estadio 4' }],
        }),
        lab('egfr-4', 0, '62238-1', 24, 'mL/min/1.73m2'),
        lab('acr-4', 0, '9318-7', 420, 'mg/g'),
      ]);
      const snapshot = await snapshotPatient(harness, patient);
      expect(liveDue(snapshot, RENAL)).toEqual([91]);
      expect(liveDue(snapshot, ALBUMINURIA)).toEqual([91]);
      expect(liveDue(snapshot, RENAL_VISIT)).toEqual([91]);
    });

    it('one low eGFR does not enroll', async () => {
      const harness = await harnessWith();
      await day(harness, 0, [
        visit('ckd-0', 0, { specialty: 'internal_medicine' }),
        lab('egfr-0', 0, '62238-1', 50, 'mL/min/1.73m2'),
      ]);
      await day(harness, 30, [lab('egfr-0b', 30, '62238-1', 49, 'mL/min/1.73m2')]);
      expect(
        snapshotProtocol(await snapshotPatient(harness, patient), 'chronic_kidney_disease'),
      ).toEqual([]);
    });
  });
}

function snapshotProtocol(snapshot: PatientSnapshot, protocolId: string): Expectation[] {
  return snapshot.expectations.filter((expectation) => expectation.protocolId === protocolId);
}

describe('protocol library v1, HIP-137 (memory)', () => {
  protocolLibrary((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('protocol library v1, HIP-137'), () => {
  const database = useIsolatedDatabase();
  protocolLibrary((options) => postgresHarness(database(), options));
});
