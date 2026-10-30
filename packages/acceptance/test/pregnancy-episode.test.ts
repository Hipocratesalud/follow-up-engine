import { FakeNoteExtractor, loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  effectiveClosedReason,
  type Expectation,
  type ExpectationEvent,
  isActiveCaseStatus,
  patientId,
  type PlanItem,
} from '@follow-up-engine/core';
import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  expectationToTask,
  TERMINOLOGY,
} from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
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
 * - A plan item folded into the order of its visit (`covered_by_order`)
 *   reads as that order does: `pregnancy_ended` only when the end of the
 *   pregnancy cancelled the order itself, as a reclassification recorded on
 *   its own (`closed_reason_reclassified`), never a rewrite of its closure.
 *   A test whose order came back, was asked for again or expired with its
 *   case closed was done, re-requested or missed: its closure stays.
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
const USER = { type: 'user', id: 'dra-obstetra' } as const;

/** The value, which the test just asserted is there. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

const GLUCOSE_LOINC = '1558-6';
const CURVE_QUOTE = 'curva de tolerancia a la glucosa a las 24 semanas';
const CURVE_DISPLAY = 'Curva de tolerancia a la glucosa';

function planGlucoseCurve(dueDay: number): PlanItem {
  return {
    kind: 'lab',
    description: 'glucose tolerance test',
    dueAt: dayToDate(dueDay),
    evidenceQuote: CURVE_QUOTE,
    confidence: 0.9,
    code: { system: TERMINOLOGY.loinc, code: GLUCOSE_LOINC },
  };
}

/** What became of the glucose curve ordered at 24 weeks, before the delivery. */
type CurveOutcome =
  /** Nothing: the order is still pending (its case open) at the delivery. */
  | 'pending'
  /** The result came back at 26 weeks: the order is fulfilled. */
  | 'resulted'
  /** Ordered again at 26 weeks: the new order supersedes it (and is never done). */
  | 'reordered'
  /** Never done; its case was dismissed at 30 weeks: the order stays expired. */
  | 'dismissed';

function planItemOf(snapshot: PatientSnapshot, quote: string): Expectation | undefined {
  return ofRule(snapshot, 'doctor_plan_followup').find(
    (expectation) => expectation.evidence?.quote === quote,
  );
}

function orderOf(snapshot: PatientSnapshot, orderId: string): Expectation | undefined {
  return snapshot.expectations.find(
    (expectation) =>
      expectation.source.resourceType === 'ServiceRequest' && expectation.source.id === orderId,
  );
}

async function expectationEvents(
  harness: EngineHarness,
  expectation: Expectation,
): Promise<readonly ExpectationEvent[]> {
  return harness.read((stores) =>
    stores.expectationEvents.listForExpectation(harness.clinicId, expectation.id),
  );
}

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
    // The last prenatal control is the day of the delivery, 45 minutes
    // after the noon the note's "12 días" dates it at (pat-0106).
    for (const week of [14, 18, 22, 26, 28, 30, 32, 34, 36, 38, 39.0045]) {
      await day(harness, weekDay(week), [
        visit(`prenatal-${String(Math.floor(week))}`, weekDay(week), {
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
    // The plan item was folded into the glucose order of its visit, which
    // the delivery cancelled: it now reads `pregnancy_ended` (inbox, FHIR
    // Task), and its original closure is kept as it was.
    expect(effectiveClosedReason(defined(glucosePlan))).toBe('pregnancy_ended');
    expect(expectationToTask(defined(glucosePlan)).statusReason?.coding?.[0]).toEqual({
      system: ENGINE_CODE_SYSTEMS.closedReason,
      code: 'pregnancy_ended',
    });
    expect(glucosePlan?.closedReason).toBe('covered_by_order');
    expect(glucosePlan?.closedBy).toEqual({
      resourceType: 'ServiceRequest',
      id: 'first-prenatal-sr-1',
    });
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

  /**
   * At 24 weeks the obstetrician writes the glucose curve in the plan and
   * orders it at the same visit: the plan item is folded into the order
   * (`covered_by_order`). What becomes of the order before the delivery at
   * 39 weeks is `outcome`. The delivery is told at the puerperal visit 12
   * days later.
   *
   * @returns the harness after the puerperal visit, and the plan item as it
   *   was stored just before that visit.
   */
  async function glucoseCurveAt24Weeks(
    outcome: CurveOutcome,
  ): Promise<{ readonly harness: EngineHarness; readonly beforeDelivery: Expectation }> {
    const extractor = new FakeNoteExtractor()
      .setExtraction('prenatal-24-note', { planItems: [planGlucoseCurve(weekDay(26))] })
      .setExtraction('puerperal-note', {
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
    const curveOrder = { loinc: GLUCOSE_LOINC, display: CURVE_DISPLAY };
    for (const week of [14, 18, 22, 24, 26, 28, 30, 32, 34, 36, 38, 39.0045]) {
      const at = weekDay(week);
      const orders =
        week === 24 || (week === 26 && outcome === 'reordered') ? { orders: [curveOrder] } : {};
      const result =
        week === 26 && outcome === 'resulted'
          ? [
              labResultBundle({
                id: 'curve-result',
                patientId: PATIENT,
                loinc: GLUCOSE_LOINC,
                display: CURVE_DISPLAY,
                at: dayToDate(at),
                value: 86,
                unit: 'mg/dL',
                flag: 'N',
                orderId: orderIdOf('prenatal-24', 1),
              }),
            ]
          : [];
      await day(harness, at, [
        visit(`prenatal-${String(Math.floor(week))}`, at, {
          specialty: 'gynecology',
          diagnoses: PREGNANCY,
          ...orders,
        }),
        ...result,
      ]);
      if (week === 30 && outcome === 'dismissed') {
        const snapshot = await snapshotPatient(harness, patient);
        const followUpCase = defined(
          snapshot.cases.find(
            (candidate) =>
              isActiveCaseStatus(candidate.status) && candidate.ruleIds.includes(LAB_PENDING),
          ),
        );
        await harness.engine.cases.dismiss(harness.clinicId, followUpCase.id, USER, {
          reason: 'handled_elsewhere',
        });
      }
    }
    const beforeDelivery = defined(
      planItemOf(await snapshotPatient(harness, patient), CURVE_QUOTE),
    );
    expect(beforeDelivery).toMatchObject({
      status: 'cancelled',
      closedReason: 'covered_by_order',
      closedAt: dayToDate(weekDay(24)),
      closedBy: { resourceType: 'ServiceRequest', id: orderIdOf('prenatal-24', 1) },
    });
    await day(harness, delivery + 12, [
      visit('puerperal', delivery + 12, {
        specialty: 'gynecology',
        noteText: 'Puérpera de 12 días, parto eutócico. Herida en buen estado.',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    return { harness, beforeDelivery };
  }

  /** The plan item kept its closure untouched: no reclassification, no event. */
  async function expectClosureUntouched(
    harness: EngineHarness,
    beforeDelivery: Expectation,
  ): Promise<Expectation> {
    const planItem = defined(planItemOf(await snapshotPatient(harness, patient), CURVE_QUOTE));
    expect(planItem).toEqual(beforeDelivery);
    expect(planItem.reclassification).toBeUndefined();
    expect(effectiveClosedReason(planItem)).toBe('covered_by_order');
    expect(effectiveClosedReason(planItem)).not.toBe('pregnancy_ended');
    expect(expectationToTask(planItem).statusReason?.coding?.[0]?.code).toBe('covered_by_order');
    expect(await expectationEvents(harness, planItem)).toEqual([]);
    return planItem;
  }

  it('a glucose curve planned and ordered at 24 weeks whose result came at 26 weeks keeps its closure after the delivery (not pregnancy_ended)', async () => {
    const { harness, beforeDelivery } = await glucoseCurveAt24Weeks('resulted');
    const snapshot = await snapshotPatient(harness, patient);
    expect(orderOf(snapshot, orderIdOf('prenatal-24', 1))).toMatchObject({
      status: 'fulfilled',
      closedReason: 'fulfilled_by_result',
    });
    await expectClosureUntouched(harness, beforeDelivery);
  });

  it('a glucose curve still pending at the delivery: the plan item reads pregnancy_ended through a recorded reclassification, its closure intact', async () => {
    const { harness, beforeDelivery } = await glucoseCurveAt24Weeks('pending');
    let snapshot = await snapshotPatient(harness, patient);
    const order = defined(orderOf(snapshot, orderIdOf('prenatal-24', 1)));
    expect(order).toMatchObject({ status: 'cancelled', closedReason: 'pregnancy_ended' });
    const closure = defined(order.closedBy);
    const puerperalDay = dayToDate(delivery + 12);
    const planItem = defined(planItemOf(snapshot, CURVE_QUOTE));
    // The original closure, field by field, as it was before the delivery.
    expect(planItem.status).toBe(beforeDelivery.status);
    expect(planItem.closedReason).toBe('covered_by_order');
    expect(planItem.closedAt).toEqual(beforeDelivery.closedAt);
    expect(planItem.closedBy).toEqual(beforeDelivery.closedBy);
    expect(planItem.reclassification).toEqual({
      closedReason: 'pregnancy_ended',
      at: puerperalDay,
      by: closure,
    });
    expect(effectiveClosedReason(planItem)).toBe('pregnancy_ended');
    const task = expectationToTask(planItem);
    expect(task.statusReason?.coding?.[0]?.code).toBe('pregnancy_ended');
    expect(task.executionPeriod?.end).toBe(defined(beforeDelivery.closedAt).toISOString());
    const reclassification = task.extension?.find(
      (item) => item.url === ENGINE_EXTENSIONS.closureReclassification,
    );
    expect(reclassification?.extension).toContainEqual({
      url: 'originalReason',
      valueCode: 'covered_by_order',
    });
    const expected: Omit<ExpectationEvent, 'id'> = {
      clinicId: harness.clinicId,
      patientId: patient,
      expectationId: planItem.id,
      type: 'closed_reason_reclassified',
      actor: 'engine',
      at: puerperalDay,
      fromReason: 'covered_by_order',
      toReason: 'pregnancy_ended',
      cause: 'episode_ended',
      causedBy: closure,
      relatedExpectationId: order.id,
    };
    const events = await expectationEvents(harness, planItem);
    expect(events).toEqual([expect.objectContaining(expected)]);
    // Later batches decide the ended episode again: one reclassification, recorded once.
    await day(harness, delivery + 35, [
      visit('postpartum', delivery + 35, {
        specialty: 'gynecology',
        diagnoses: [{ icd10: 'Z39.2', display: 'puerperio' }],
      }),
    ]);
    snapshot = await snapshotPatient(harness, patient);
    expect(planItemOf(snapshot, CURVE_QUOTE)).toEqual(planItem);
    expect(await expectationEvents(harness, planItem)).toEqual(events);
  });

  it('a glucose curve ordered again at 26 weeks: the superseded order keeps the plan item of 24 weeks as it was', async () => {
    const { harness, beforeDelivery } = await glucoseCurveAt24Weeks('reordered');
    const snapshot = await snapshotPatient(harness, patient);
    expect(orderOf(snapshot, orderIdOf('prenatal-24', 1))).toMatchObject({
      status: 'superseded',
      closedReason: 'superseded_by_new_order',
    });
    // The newer order is the one the delivery dropped.
    expect(orderOf(snapshot, orderIdOf('prenatal-26', 1))).toMatchObject({
      status: 'cancelled',
      closedReason: 'pregnancy_ended',
    });
    await expectClosureUntouched(harness, beforeDelivery);
  });

  it('a glucose curve that expired and whose case was dismissed before the delivery keeps the plan item as it was', async () => {
    const { harness, beforeDelivery } = await glucoseCurveAt24Weeks('dismissed');
    const snapshot = await snapshotPatient(harness, patient);
    expect(orderOf(snapshot, orderIdOf('prenatal-24', 1))?.status).toBe('expired');
    await expectClosureUntouched(harness, beforeDelivery);
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
      delivery + 56,
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
