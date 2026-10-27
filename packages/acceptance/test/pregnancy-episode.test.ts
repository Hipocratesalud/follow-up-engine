import { FakeNoteExtractor, loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type Expectation,
  isActiveCaseStatus,
  patientId,
  type PlanItem,
} from '@follow-up-engine/core';
import { TERMINOLOGY } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { type CalibrationConsultation, consultationBundle } from '../src/calibration-bundles.ts';
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
 * Clinical audit (gyn-psych, pattern P1 and P7): what a pregnancy asked for
 * ends with it, and the postpartum visit is a visit of its own.
 *
 * - A delivery or a loss closes every open item of that pregnancy: the
 *   first-trimester labs and obstetric ultrasounds ordered at prenatal
 *   controls, the doctor's plan items of those controls, the protocol's
 *   prenatal items (`pregnancy_ended`). What came after the end (the
 *   postpartum plan) stays.
 * - The 7 to 12-day puerperal check is not the comprehensive postpartum
 *   visit: only a visit from 3 weeks after the delivery fulfills it.
 */

const PATIENT = 'pat-pregnancy-episode';
const patient = patientId(PATIENT);
const ALL_PROTOCOLS = loadConfigDirectory().protocols.map((protocol) => protocol.id);
const OBSTETRICIAN = 'prac-obstetrician';

const PRENATAL = 'protocol_pregnancy_prenatal_visit';
const POSTPARTUM = 'protocol_pregnancy_postpartum_visit';
const LAB_PENDING = 'lab_order_result_pending';
const IMAGING_PENDING = 'imaging_order_result_pending';
const PLAN = 'doctor_plan_followup';

function visit(
  id: string,
  at: number,
  input: Omit<CalibrationConsultation, 'consultationId' | 'patient' | 'occurredAt' | 'noteText'> & {
    readonly noteText?: string;
  },
): unknown {
  return consultationBundle({
    consultationId: id,
    patient: { id: PATIENT, name: 'Paciente Sintética', gender: 'female', birthDate: '1992-03-14' },
    practitionerId: OBSTETRICIAN,
    occurredAt: dayToDate(at),
    noteText: 'Control prenatal. Evolución normal.',
    ...input,
  });
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

function activeReasons(snapshot: PatientSnapshot): string[] {
  return snapshot.cases
    .filter((followUpCase) => isActiveCaseStatus(followUpCase.status))
    .flatMap((followUpCase) => followUpCase.ruleIds);
}

/** Day on which a pregnancy 10 weeks along on day 0 reaches week `week`. */
const weekDay = (week: number): number => (week - 10) * 7;

function planLab(dueDay: number, quote: string): PlanItem {
  return {
    kind: 'lab',
    description: 'fasting glucose',
    dueAt: dayToDate(dueDay),
    evidenceQuote: quote,
    confidence: 0.9,
  };
}

function planVisit(dueDay: number, quote: string): PlanItem {
  return {
    kind: 'follow_up_visit',
    description: 'follow-up visit',
    dueAt: dayToDate(dueDay),
    evidenceQuote: quote,
    confidence: 0.9,
  };
}

const PREGNANCY = [{ icd10: 'Z34.9', display: 'embarazo' }];

function pregnancyEpisode(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessWith = (extractor: FakeNoteExtractor): Promise<EngineHarness> => {
    sequence += 1;
    return makeHarness({
      clinicId: clinicId(`clinic-pregnancy-episode-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor,
      settings: { enabledProtocols: ALL_PROTOCOLS },
    });
  };

  const delivery = weekDay(39);

  /**
   * A first prenatal visit at 10 weeks orders a fasting glucose, a
   * urinalysis and an ultrasound that never come back; a 32-week ultrasound
   * is never done either. The delivery is told at the puerperal visit 12
   * days later ("puérpera de 12 días, cesárea"), whose plan asks for a
   * control in 6 weeks.
   */
  async function deliveredWithOpenPrenatalOrders(): Promise<EngineHarness> {
    const extractor = new FakeNoteExtractor()
      .setExtraction('first-prenatal-note', {
        planItems: [planLab(30, 'glicemia en ayunas'), planVisit(28, 'control en 4 semanas')],
      })
      .setExtraction('puerperal-note', {
        planItems: [planVisit(delivery + 12 + 42, 'Próximo control en 6 semanas')],
        pregnancy: {
          outcome: {
            kind: 'cesarean_delivery',
            date: dayToDate(delivery),
            evidenceQuote: 'Puérpera de 12 días, cesárea segmentaria',
          },
        },
      });
    const harness = await harnessWith(extractor);
    await day(harness, 0, [
      visit('first-prenatal', 0, {
        specialty: 'gynecology',
        diagnoses: PREGNANCY,
        orders: [
          { loinc: '1558-6', display: 'Glicemia en ayunas' },
          { loinc: '24357-6', display: 'Examen de orina' },
          { loinc: '11525-3', display: 'Ecografía obstétrica', category: 'imaging' },
        ],
      }),
      datedObservation('edd', 0, '11778-8', dayToDate(weekDay(40))),
    ]);
    for (const week of [14, 18, 22, 26, 28, 30, 32, 34, 36, 38]) {
      await day(harness, weekDay(week), [
        visit(`prenatal-${String(week)}`, weekDay(week), {
          specialty: 'gynecology',
          diagnoses: PREGNANCY,
          ...(week === 32
            ? {
                orders: [
                  { loinc: '11525-3', display: 'Ecografía obstétrica', category: 'imaging' },
                ],
              }
            : {}),
        }),
      ]);
    }
    await day(harness, delivery + 12, [
      visit('puerperal', delivery + 12, {
        specialty: 'gynecology',
        noteText: 'Puérpera de 12 días, cesárea segmentaria sin complicaciones.',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    return harness;
  }

  it('a delivery closes every prenatal order and plan item of that pregnancy (pregnancy_ended)', async () => {
    const harness = await deliveredWithOpenPrenatalOrders();
    await day(harness, delivery + 120);
    const snapshot = await snapshotPatient(harness, patient);
    const prenatalOrders = [...ofRule(snapshot, LAB_PENDING), ...ofRule(snapshot, IMAGING_PENDING)];
    expect(prenatalOrders.length).toBeGreaterThanOrEqual(4);
    expect(live(prenatalOrders)).toEqual([]);
    expect(
      prenatalOrders
        .filter((expectation) => expectation.status === 'cancelled')
        .map((expectation) => expectation.closedReason),
    ).toEqual(expect.arrayContaining(['pregnancy_ended']));
    const glucosePlan = ofRule(snapshot, PLAN).find(
      (expectation) => expectation.evidence?.quote === 'glicemia en ayunas',
    );
    expect(glucosePlan?.status).toBe('cancelled');
    expect(glucosePlan?.closedReason).toBe('pregnancy_ended');
    expect(live(ofRule(snapshot, PRENATAL))).toEqual([]);
    // Nothing prenatal reaches the inbox; the missed postpartum control does.
    const reasons = activeReasons(snapshot);
    expect(reasons).not.toContain(LAB_PENDING);
    expect(reasons).not.toContain(IMAGING_PENDING);
    expect(reasons).toContain(PLAN);
    const postpartumPlan = ofRule(snapshot, PLAN).find(
      (expectation) => expectation.evidence?.quote === 'Próximo control en 6 semanas',
    );
    expect(postpartumPlan?.status).toBe('expired');
  });

  it('a 12-day puerperal check is not the postpartum visit: the protocol expects one from week 3', async () => {
    const extractor = new FakeNoteExtractor().setExtraction('puerperal-note', {
      hasPlan: false,
      pregnancy: {
        outcome: {
          kind: 'vaginal_delivery',
          date: dayToDate(delivery),
          evidenceQuote: 'Puérpera de 12 días, parto eutócico',
        },
      },
    });
    const harness = await harnessWith(extractor);
    await day(harness, 0, [
      visit('first-prenatal', 0, { specialty: 'gynecology', diagnoses: PREGNANCY }),
      datedObservation('edd', 0, '11778-8', dayToDate(weekDay(40))),
    ]);
    await day(harness, delivery + 12, [
      visit('puerperal', delivery + 12, {
        specialty: 'gynecology',
        noteText: 'Puérpera de 12 días, parto eutócico. Herida en buen estado.',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    let snapshot = await snapshotPatient(harness, patient);
    const postpartum = live(ofRule(snapshot, POSTPARTUM));
    expect(postpartum.map((expectation) => Math.round(dayOf(expectation.dueAt)))).toEqual([
      delivery + 42,
    ]);
    // A visit 5 weeks after the delivery is the postpartum visit.
    await day(harness, delivery + 35, [
      visit('postpartum', delivery + 35, {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    snapshot = await snapshotPatient(harness, patient);
    expect(live(ofRule(snapshot, POSTPARTUM))).toEqual([]);
    expect(ofRule(snapshot, POSTPARTUM).map((expectation) => expectation.closedReason)).toEqual([
      'fulfilled_by_encounter',
    ]);
  });

  it('a visit never fulfills the plan its own note wrote, even when the note dates the delivery weeks earlier', async () => {
    // pat-0126: the 50-day postpartum note asks for the annual control; the
    // delivery it tells (dated 50 days earlier) must not make the earlier
    // puerperal visit count as that control.
    const extractor = new FakeNoteExtractor().setExtraction('late-postpartum-note', {
      planItems: [planVisit(delivery + 50 + 365, 'Control ginecológico anual.')],
      pregnancy: {
        outcome: {
          kind: 'vaginal_delivery',
          date: dayToDate(delivery),
          evidenceQuote: 'Puérpera de 50 días (parto vaginal)',
        },
      },
    });
    const harness = await harnessWith(extractor);
    await day(harness, 0, [
      visit('first-prenatal', 0, { specialty: 'gynecology', diagnoses: PREGNANCY }),
      datedObservation('edd', 0, '11778-8', dayToDate(weekDay(40))),
    ]);
    await day(harness, delivery + 8, [
      visit('early-puerperal', delivery + 8, {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'O80.9', display: 'parto vaginal' }],
      }),
    ]);
    await day(harness, delivery + 50, [
      visit('late-postpartum', delivery + 50, {
        specialty: 'gynecology',
        noteText: 'Puérpera de 50 días (parto vaginal). Control ginecológico anual.',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    const snapshot = await snapshotPatient(harness, patient);
    const annual = ofRule(snapshot, PLAN).find(
      (expectation) => expectation.evidence?.quote === 'Control ginecológico anual.',
    );
    expect(annual?.status).toBe('open');
  });
}

describe('pregnancy episode (memory)', () => {
  pregnancyEpisode((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('pregnancy episode'), () => {
  const database = useIsolatedDatabase();
  pregnancyEpisode((options) => postgresHarness(database(), options));
});
