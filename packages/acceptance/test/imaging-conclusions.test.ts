import { FakeNoteExtractor, loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, isActiveCaseStatus, patientId } from '@follow-up-engine/core';
import { TERMINOLOGY } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  type CalibrationConsultation,
  consultationBundle,
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
import { dayOf, type PatientSnapshot, snapshotPatient } from '../src/scenario-runner.ts';

/*
 * Clinical audit (gyn-psych, pattern P4): an imaging report says what it
 * found only in its conclusion ("BI-RADS 3 ... se sugiere control a corto
 * plazo", "Biometría por debajo del percentil 10"). The engine reads the
 * conclusion (and `conclusionCode`) with a deterministic lexicon: the report
 * is abnormal, a visit is expected, and the follow-up study the finding
 * calls for is expected by the guideline's date (BI-RADS 3: 6 months; fetal
 * growth below the 10th percentile: 2 weeks). Prenatal studies of different
 * trimesters are different tests: the 32-week growth scan never replaces a
 * 20-week anatomy scan that was never done.
 */

const PATIENT = 'pat-imaging';
const patient = patientId(PATIENT);
const ALL_PROTOCOLS = loadConfigDirectory().protocols.map((protocol) => protocol.id);

const ABNORMAL_VISIT = 'abnormal_result_followup';
const FOLLOW_UP_STUDY = 'abnormal_imaging_followup_study';
const IMAGING_PENDING = 'imaging_order_result_pending';

const MAMMOGRAM = { loinc: '24606-6', display: 'Mamografía bilateral de pesquisa' };
const OBSTETRIC_US = { loinc: '11525-3', display: 'Ecografía obstétrica' };

function visit(
  id: string,
  at: number,
  input: Omit<CalibrationConsultation, 'consultationId' | 'patient' | 'occurredAt' | 'noteText'> & {
    readonly noteText?: string;
  },
): unknown {
  return consultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética', gender: 'female', birthDate: '1976-05-02' },
    practitionerId: 'prac-gynecologist',
    occurredAt: dayToDate(at),
    noteText: 'Control ginecológico.',
    ...input,
  });
}

/** An imaging report with no Observation: what it found is only in its conclusion. */
function imagingReport(input: {
  readonly id: string;
  readonly at: number;
  readonly study: { readonly loinc: string; readonly display: string };
  readonly conclusion: string;
  readonly conclusionCode?: string;
  readonly orderId?: string;
}): unknown {
  const issued = dayToDate(input.at).toISOString();
  const report = {
    resourceType: 'DiagnosticReport',
    id: input.id,
    status: 'final',
    category: [
      {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'RAD' }],
      },
    ],
    code: {
      coding: [
        { system: TERMINOLOGY.loinc, code: input.study.loinc, display: input.study.display },
      ],
      text: input.study.display,
    },
    subject: { reference: `Patient/${PATIENT}` },
    effectiveDateTime: issued,
    issued,
    ...(input.orderId === undefined
      ? {}
      : { basedOn: [{ reference: `ServiceRequest/${input.orderId}` }] }),
    conclusion: input.conclusion,
    ...(input.conclusionCode === undefined
      ? {}
      : {
          conclusionCode: [
            { coding: [{ system: 'http://snomed.info/sct', code: input.conclusionCode }] },
          ],
        }),
  };
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [{ resource: report, request: { method: 'PUT', url: `DiagnosticReport/${input.id}` } }],
  };
}

function datedObservation(id: string, at: number, loinc: string, value: Date): unknown {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: {
          resourceType: 'Observation',
          id,
          status: 'final',
          code: { coding: [{ system: TERMINOLOGY.loinc, code: loinc }] },
          subject: { reference: `Patient/${PATIENT}` },
          effectiveDateTime: dayToDate(at).toISOString(),
          issued: dayToDate(at).toISOString(),
          valueDateTime: value.toISOString(),
        },
        request: { method: 'PUT', url: `Observation/${id}` },
      },
    ],
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

function dueDays(expectations: readonly Expectation[]): number[] {
  return expectations.map((expectation) => Math.round(dayOf(expectation.dueAt)));
}

function activeCases(snapshot: PatientSnapshot) {
  return snapshot.cases.filter((followUpCase) => isActiveCaseStatus(followUpCase.status));
}

function imagingConclusions(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-imaging-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
      settings: { enabledProtocols: ALL_PROTOCOLS },
    });
  };

  it('a BI-RADS 3 mammogram is abnormal and expects the 6-month short-interval study', async () => {
    const harness = await harnessWith();
    await day(harness, 0, [
      visit('annual', 0, {
        specialty: 'gynecology',
        orders: [{ ...MAMMOGRAM, category: 'imaging' }],
      }),
    ]);
    await day(harness, 6, [
      imagingReport({
        id: 'mammo-1',
        at: 6,
        study: MAMMOGRAM,
        conclusion: 'BI-RADS 3. Hallazgo probablemente benigno; se sugiere control a corto plazo.',
        orderId: orderIdOf('annual', 1),
      }),
    ]);
    let snapshot = await snapshotPatient(harness, patient);
    expect(dueDays(live(ofRule(snapshot, ABNORMAL_VISIT)))).toEqual([13]);
    expect(dueDays(live(ofRule(snapshot, FOLLOW_UP_STUDY)))).toEqual([186]);
    // Nobody acted: one case, ranked as an abnormal result.
    await day(harness, 200);
    snapshot = await snapshotPatient(harness, patient);
    const [followUpCase] = activeCases(snapshot);
    expect(followUpCase?.ruleIds).toEqual(
      expect.arrayContaining([ABNORMAL_VISIT, FOLLOW_UP_STUDY]),
    );
    expect(followUpCase?.priority).toBeGreaterThanOrEqual(75);
    // The short-interval mammogram comes back: the study is done.
    await day(harness, 205, [
      imagingReport({
        id: 'mammo-2',
        at: 205,
        study: MAMMOGRAM,
        conclusion: 'BI-RADS 2. Hallazgo benigno estable.',
      }),
    ]);
    snapshot = await snapshotPatient(harness, patient);
    expect(live(ofRule(snapshot, FOLLOW_UP_STUDY))).toEqual([]);
  });

  it('reads the conclusion code, and normal or negated conclusions expect nothing', async () => {
    const harness = await harnessWith();
    await day(harness, 0, [
      imagingReport({
        id: 'us-coded',
        at: 0,
        study: { loinc: '24558-9', display: 'Ecografía abdominal' },
        conclusion: 'Ver informe adjunto.',
        conclusionCode: '263654008',
      }),
      imagingReport({
        id: 'mammo-normal',
        at: 0,
        study: MAMMOGRAM,
        conclusion: 'BI-RADS 1. Negativo. Sin hallazgos sospechosos de malignidad.',
      }),
      imagingReport({
        id: 'us-normal',
        at: 0,
        study: OBSTETRIC_US,
        conclusion:
          'Embarazo único, intrauterino, activo. Biometría acorde a edad gestacional. No se observa restricción del crecimiento.',
      }),
    ]);
    const snapshot = await snapshotPatient(harness, patient);
    expect(ofRule(snapshot, ABNORMAL_VISIT).map((expectation) => expectation.source.id)).toEqual([
      'us-coded',
    ]);
    expect(ofRule(snapshot, FOLLOW_UP_STUDY)).toEqual([]);
  });

  it('fetal biometry below the 10th percentile expects a growth scan in 2 weeks, which a visit saying "evolución normal" does not replace', async () => {
    const harness = await harnessWith();
    const weekDay = (week: number): number => (week - 10) * 7;
    await day(harness, 0, [
      visit('preg-10', 0, {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
      }),
      datedObservation('edd', 0, '11778-8', dayToDate(weekDay(40))),
    ]);
    await day(harness, weekDay(32), [
      visit('preg-32', weekDay(32), {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        orders: [{ ...OBSTETRIC_US, category: 'imaging' }],
      }),
    ]);
    await day(harness, weekDay(32) + 1, [
      imagingReport({
        id: 'us-32',
        at: weekDay(32) + 1,
        study: OBSTETRIC_US,
        conclusion:
          'Embarazo único activo. Biometría por debajo del percentil 10 para edad gestacional. Sugiere control.',
        orderId: orderIdOf('preg-32', 1),
      }),
    ]);
    await day(harness, weekDay(34), [
      visit('preg-34', weekDay(34), {
        specialty: 'gynecology',
        noteText: 'Embarazo de 34 semanas, evolución normal. Control en 2 semanas.',
        diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
      }),
    ]);
    await day(harness, weekDay(34) + 3);
    const snapshot = await snapshotPatient(harness, patient);
    expect(live(ofRule(snapshot, ABNORMAL_VISIT))).toEqual([]);
    expect(dueDays(live(ofRule(snapshot, FOLLOW_UP_STUDY)))).toEqual([weekDay(32) + 15]);
    expect(activeCases(snapshot).flatMap((followUpCase) => followUpCase.ruleIds)).toContain(
      FOLLOW_UP_STUDY,
    );
  });

  it('a 32-week growth scan order does not replace the 20-week anatomy scan that never came back', async () => {
    const harness = await harnessWith();
    const weekDay = (week: number): number => (week - 10) * 7;
    const prenatal = (id: string, week: number, orders = false) =>
      visit(id, weekDay(week), {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'Z34.9', display: 'embarazo' }],
        ...(orders ? { orders: [{ ...OBSTETRIC_US, category: 'imaging' as const }] } : {}),
      });
    await day(harness, 0, [
      prenatal('preg-10', 10),
      datedObservation('edd', 0, '11778-8', dayToDate(weekDay(40))),
    ]);
    await day(harness, weekDay(20), [prenatal('preg-20', 20, true)]);
    // Re-ordered in the same trimester: the re-order replaces it.
    await day(harness, weekDay(22), [prenatal('preg-22', 22, true)]);
    await day(harness, weekDay(32), [prenatal('preg-32', 32, true)]);
    const snapshot = await snapshotPatient(harness, patient);
    const byOrder = new Map(
      ofRule(snapshot, IMAGING_PENDING).map((expectation) => [expectation.source.id, expectation]),
    );
    expect(byOrder.get(orderIdOf('preg-20', 1))?.closedReason).toBe('superseded_by_new_order');
    expect(byOrder.get(orderIdOf('preg-22', 1))?.status).toBe('expired');
    expect(byOrder.get(orderIdOf('preg-32', 1))?.status).toBe('open');
  });
}

describe('imaging conclusions (memory)', () => {
  imagingConclusions((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('imaging conclusions'), () => {
  const database = useIsolatedDatabase();
  imagingConclusions((options) => postgresHarness(database(), options));
});
