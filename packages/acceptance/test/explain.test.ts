import {
  clinicId,
  type Expectation,
  type ExpectationExplanation,
  patientId,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  encounterResource,
  labOrderResource,
  noteResource,
  observationResource,
  prescriptionResource,
  transactionOf,
} from '../src/bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { snapshotPatient } from '../src/scenario-runner.ts';

/**
 * HIP-142 "Why this?": for every layer, `engine.explain` recomputes from the
 * stored record why an expectation exists and how its due date was
 * computed, citing only the patient's own records: the order behind a
 * pending result, the note behind a plan item, the prescription or the
 * results that enrolled the patient in a protocol, the visits that make a
 * cadence pattern.
 */

const MS_PER_DAY = 86_400_000;

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
}

async function explained(
  harness: EngineHarness,
  patient: string,
  ruleId: string,
): Promise<{ expectation: Expectation; why: ExpectationExplanation }> {
  const { expectations } = await snapshotPatient(harness, patientId(patient));
  const expectation = expectations.find(
    (candidate) => candidate.ruleId === ruleId && candidate.status === 'open',
  );
  if (expectation === undefined) {
    throw new Error(`expected an open ${ruleId} expectation for ${patient}`);
  }
  const [why, ...rest] = await harness.engine.explain(harness.clinicId, patientId(patient), [
    expectation.id,
  ]);
  expect(rest).toEqual([]);
  if (why === undefined) throw new Error('expected an explanation');
  return { expectation, why };
}

function visit(patient: string, id: string, at: Date, specialty = 'internal_medicine') {
  return encounterResource({ id, patientId: patient, specialty, at });
}

function explainScenarios(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-why-${name}-${String(Date.now())}`),
    start: BASE_DATE,
  });

  it('universal: a lab order explains its pending result with the order, the rule days and what fulfills it', async () => {
    const harness = await makeHarness(options('universal'));
    await day(harness, 0, [
      transactionOf(
        visit('p-lab', 'enc-lab', dayToDate(0)),
        labOrderResource({
          id: 'sr-hba1c',
          patientId: 'p-lab',
          loinc: '4548-4',
          encounterId: 'enc-lab',
          at: dayToDate(0),
        }),
      ),
    ]);
    const { expectation, why } = await explained(harness, 'p-lab', 'lab_order_result_pending');
    expect(why.layer).toBe('universal');
    expect(why.due).toMatchObject({
      basis: 'rule_days',
      anchorRole: 'trigger',
      anchorAt: dayToDate(0),
      days: 15,
      configuredDays: 15,
      dueAt: expectation.dueAt,
    });
    expect(why.due.anchor).toMatchObject({
      type: 'service_request.created',
      source: { resourceType: 'ServiceRequest', id: 'sr-hba1c' },
    });
    expect(why.fulfilledBy).toMatchObject({
      expects: 'lab',
      code: { code: '4548-4' },
      orderId: 'sr-hba1c',
    });
    // An IFCC HbA1c answers the order too.
    expect(why.fulfilledBy.equivalentCodes).toContain('59261-8');
    expect(why.fulfilledBy.events).toContain('result.received');
    // Once the result arrives, the explanation names it as what closed it.
    await day(harness, 5, [
      transactionOf(
        observationResource({
          id: 'obs-hba1c',
          patientId: 'p-lab',
          loinc: '4548-4',
          value: 6.1,
          unit: '%',
          basedOn: 'sr-hba1c',
          at: dayToDate(5),
        }),
      ),
    ]);
    const [closed] = await harness.engine.explain(harness.clinicId, patientId('p-lab'), [
      expectation.id,
    ]);
    expect(closed?.closedBy).toMatchObject({
      type: 'result.received',
      source: { resourceType: 'Observation', id: 'obs-hba1c' },
    });
  });

  it("doctor's plan: the note, the doctor's words and the date the doctor gave", async () => {
    const harness = await makeHarness(options('plan'));
    await day(harness, 0, [
      transactionOf(
        visit('p-plan', 'enc-plan', dayToDate(0)),
        noteResource({
          id: 'note-plan',
          patientId: 'p-plan',
          encounterId: 'enc-plan',
          specialty: 'internal_medicine',
          text: 'Paciente estable, sin cambios. Control en 1 mes.',
          at: dayToDate(0),
        }),
      ),
    ]);
    const { why } = await explained(harness, 'p-plan', 'doctor_plan_followup');
    expect(why.due).toMatchObject({
      basis: 'plan_date',
      anchorRole: 'note',
      anchorAt: dayToDate(0),
    });
    expect(why.due.days).toBeGreaterThanOrEqual(28);
    expect(why.due.days).toBeLessThanOrEqual(31);
    expect(why.plan).toMatchObject({ documentId: 'note-plan', specialty: 'internal_medicine' });
    expect(why.plan?.quote).toMatch(/1 mes/);
    expect(why.plan?.note?.text).toContain('Control en 1 mes');
    expect(why.fulfilledBy.expects).toBe('follow_up_visit');
    expect(why.fulfilledBy.events).toEqual(
      expect.arrayContaining(['encounter.finished', 'appointment.booked']),
    );
    // "Control en 1 mes" booked two weeks late is the plan being followed: 3 days at least.
    expect(why.due.bookingToleranceDays).toBeGreaterThanOrEqual(3);
  });

  it('protocol enrolled by a prescription: the prescription is the evidence and the HbA1c counts from it', async () => {
    const harness = await makeHarness(options('medication'));
    await day(harness, 0, [
      transactionOf(
        visit('p-met', 'enc-met', dayToDate(0), 'diabetology'),
        prescriptionResource({
          id: 'mr-metformin',
          patientId: 'p-met',
          text: 'Metformina 850 mg c/12h',
          durationDays: 90,
          encounterId: 'enc-met',
          at: dayToDate(0),
        }),
      ),
    ]);
    const { expectation, why } = await explained(harness, 'p-met', 'protocol_diabetes_hba1c');
    expect(why.layer).toBe('protocol');
    expect(why.protocol).toMatchObject({
      protocolId: 'diabetes',
      itemKey: 'hba1c',
      schedule: { type: 'interval', everyDays: 90 },
      enrollment: {
        episode: 'active',
        basis: 'medication',
        condition: { code: { code: 'E14' }, sourceType: 'inferred_from_medication' },
      },
    });
    expect(why.protocol?.status).toMatch(/draft|ready_for_signoff|validated/);
    expect(why.protocol?.enrollment.evidence).toEqual([
      expect.objectContaining({
        type: 'medication.prescribed',
        source: { resourceType: 'MedicationRequest', id: 'mr-metformin' },
      }),
    ]);
    expect(why.due).toMatchObject({
      basis: 'protocol_interval',
      anchorRole: 'enrollment',
      configuredDays: 90,
      days: 90,
    });
    expect(expectation.dueAt.getTime() - dayToDate(0).getTime()).toBe(90 * MS_PER_DAY);
    expect(why.fulfilledBy).toMatchObject({ expects: 'lab', code: { code: '4548-4' } });
  });

  it('protocol enrolled by results: every result past the threshold, and the next HbA1c counts from the last one', async () => {
    const harness = await makeHarness(options('results'));
    await day(harness, 0, [
      transactionOf(
        visit('p-a1c', 'enc-a1c', dayToDate(0), 'internal_medicine'),
        observationResource({
          id: 'obs-a1c-high',
          patientId: 'p-a1c',
          loinc: '4548-4',
          value: 7.4,
          unit: '%',
          interpretation: 'H',
          encounterId: 'enc-a1c',
          at: dayToDate(0),
        }),
      ),
    ]);
    const { why } = await explained(harness, 'p-a1c', 'protocol_diabetes_hba1c');
    expect(why.protocol?.enrollment).toMatchObject({
      episode: 'active',
      basis: 'results',
      condition: { sourceType: 'inferred_from_result' },
      threshold: { code: { code: '4548-4' }, gte: 6.5 },
    });
    expect(why.protocol?.enrollment.evidence).toEqual([
      expect.objectContaining({
        type: 'result.received',
        source: { resourceType: 'Observation', id: 'obs-a1c-high' },
      }),
    ]);
    // The HbA1c that enrolled the patient is also the last one done: + 90 days.
    expect(why.due).toMatchObject({
      basis: 'protocol_interval',
      anchorRole: 'last_done',
      anchorAt: dayToDate(0),
      days: 90,
    });
  });

  it('cadence: the visit history, the usual interval and the expected next visit', async () => {
    const harness = await makeHarness(options('cadence'));
    for (const [index, at] of [0, 30, 60].entries()) {
      await day(harness, at, [
        transactionOf(visit('p-cad', `enc-cad-${String(index)}`, dayToDate(at), 'psychology')),
      ]);
    }
    const { expectation, why } = await explained(harness, 'p-cad', 'cadence_break');
    expect(why.layer).toBe('cadence');
    expect(why.cadence).toMatchObject({
      specialty: 'psychology',
      usualIntervalDays: 30,
      multiplier: 3,
      patternVisitIds: ['enc-cad-0', 'enc-cad-1', 'enc-cad-2'],
    });
    expect(why.cadence?.visits.map((encounter) => encounter.occurredAt)).toEqual([
      dayToDate(0),
      dayToDate(30),
      dayToDate(60),
    ]);
    expect(why.due).toMatchObject({
      basis: 'cadence',
      anchorRole: 'last_visit',
      anchorAt: dayToDate(60),
      days: 90,
      configuredDays: 90,
    });
    expect(expectation.dueAt).toEqual(dayToDate(150));
    expect(why.fulfilledBy.specialties).toEqual(['psychology']);
  });
}

const TIMEOUT_MS = 30_000;

describe('"Why this?": engine.explain (memory)', { timeout: TIMEOUT_MS }, () => {
  explainScenarios((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('"Why this?": engine.explain'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    explainScenarios((options) => postgresHarness(database(), options));
  },
);
