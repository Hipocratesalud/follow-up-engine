import {
  caseId,
  clinicId,
  type Expectation,
  type ExpectationId,
  patientId,
  PlanItemReviewConflictError,
  ValidationError,
} from '@follow-up-engine/core';
import { expectationToTask } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate, validateFhirR4 } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentBundle,
  encounterResource,
  labOrderResource,
  noteResource,
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
 * HIP-141: one-click confirmation of what the AI read for a plan item. The
 * note of day 0 asks for a control in one month (a `doctor_plan`
 * expectation due day 30); the clinician confirms it, corrects its date or
 * kind, or rejects it. Every verdict is audited (`plan_item_confirmed`,
 * `plan_item_corrected`, `plan_item_rejected`) and exported on the Task.
 */

const DOCTOR = 'dra-mora';
const PLAN_RULE = 'doctor_plan_followup';

function consultation(patient: string, options: { readonly lab?: boolean } = {}): unknown {
  return transactionOf(
    encounterResource({
      id: `enc-${patient}`,
      patientId: patient,
      specialty: 'internal_medicine',
      at: dayToDate(0),
    }),
    noteResource({
      id: `note-${patient}`,
      patientId: patient,
      encounterId: `enc-${patient}`,
      specialty: 'internal_medicine',
      text: 'Paciente estable, sin cambios. Control en 1 mes.',
      at: dayToDate(0),
    }),
    ...(options.lab === true
      ? [
          labOrderResource({
            id: `sr-${patient}`,
            patientId: patient,
            loinc: '4548-4',
            encounterId: `enc-${patient}`,
            at: dayToDate(0),
          }),
        ]
      : []),
  );
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
}

async function planItems(harness: EngineHarness, patient: string): Promise<Expectation[]> {
  return (await snapshotPatient(harness, patientId(patient))).expectations.filter(
    (expectation) => expectation.ruleId === PLAN_RULE,
  );
}

async function thePlanItem(harness: EngineHarness, patient: string): Promise<Expectation> {
  const [item, ...rest] = await planItems(harness, patient);
  expect(rest).toEqual([]);
  expect(item).toMatchObject({ layer: 'doctor_plan', matchKey: 'visit', status: 'open' });
  if (item === undefined) throw new Error('expected a plan item');
  return item;
}

function reviews(harness: EngineHarness, id: ExpectationId) {
  return harness.read((stores) => stores.planItemReviews.listForExpectation(harness.clinicId, id));
}

function planItemReview(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-plan-${name}-${String(Date.now())}`),
    start: BASE_DATE,
  });

  it('confirm marks the item confirmedBy, audits it once, and exports it on the Task', async () => {
    const harness = await makeHarness(options('confirm'));
    await day(harness, 0, [consultation('p-confirm')]);
    const item = await thePlanItem(harness, 'p-confirm');
    harness.clock.set(dayToDate(1));
    const result = await harness.engine.planItems.confirm(harness.clinicId, item.id, DOCTOR);
    expect(result.expectation).toMatchObject({
      status: 'open',
      confirmedBy: DOCTOR,
      confirmedAt: dayToDate(1),
    });
    expect(await thePlanItem(harness, 'p-confirm')).toEqual(result.expectation);
    // Confirming again changes nothing and audits nothing.
    const again = await harness.engine.planItems.confirm(harness.clinicId, item.id, 'dr-rivas');
    expect(again.review).toBeUndefined();
    expect(again.expectation.confirmedBy).toBe(DOCTOR);
    expect(await reviews(harness, item.id)).toMatchObject([
      {
        type: 'plan_item_confirmed',
        userId: DOCTOR,
        at: dayToDate(1),
        before: { kind: 'follow_up_visit', dueAt: item.dueAt },
      },
    ]);
    const task = expectationToTask(result.expectation);
    expect(validateFhirR4(task).valid).toBe(true);
    expect(task.extension).toContainEqual({
      url: 'https://hipocratesalud.com/fhir/StructureDefinition/follow-up-confirmed-by',
      valueString: DOCTOR,
    });
  });

  it('correct supersedes the item with a corrected one that keeps the evidence', async () => {
    const harness = await makeHarness(options('correct'));
    await day(harness, 0, [consultation('p-correct')]);
    const item = await thePlanItem(harness, 'p-correct');
    harness.clock.set(dayToDate(2));
    const result = await harness.engine.planItems.correct(
      harness.clinicId,
      item.id,
      { dueAt: dayToDate(60) },
      DOCTOR,
    );
    expect(result.expectation).toMatchObject({
      id: item.id,
      status: 'superseded',
      closedReason: 'corrected_by_clinician',
    });
    expect(result.replacement).toMatchObject({
      status: 'open',
      dueAt: dayToDate(60),
      matchKey: 'visit',
      evidence: item.evidence,
      source: item.source,
      confirmedBy: DOCTOR,
      correctionOf: item.id,
    });
    expect(await reviews(harness, item.id)).toMatchObject([
      {
        type: 'plan_item_corrected',
        before: { kind: 'follow_up_visit', dueAt: dayToDate(30) },
        after: { kind: 'follow_up_visit', dueAt: dayToDate(60) },
        replacementId: result.replacement?.id,
      },
    ]);
    // Day 31: nothing is overdue any more; the corrected item expires on day 60.
    await day(harness, 31);
    expect((await snapshotPatient(harness, patientId('p-correct'))).cases).toEqual([]);
    await day(harness, 61);
    const { cases } = await snapshotPatient(harness, patientId('p-correct'));
    expect(cases.map((item) => item.reasons.map((reason) => reason.expectationId))).toEqual([
      [result.replacement?.id],
    ]);
    // The superseded item says why on its Task; the correction points at it.
    const old = expectationToTask(result.expectation);
    expect(old.status).toBe('cancelled');
    expect(old.statusReason?.coding?.[0]?.code).toBe('corrected_by_clinician');
    const corrected = expectationToTask(result.replacement ?? item);
    expect(validateFhirR4(corrected).valid).toBe(true);
    expect(validateFhirR4(old).valid).toBe(true);
    // A corrected item cannot be corrected or rejected again; its correction can.
    await expect(
      harness.engine.planItems.reject(harness.clinicId, item.id, DOCTOR),
    ).rejects.toMatchObject({ name: 'PlanItemReviewConflictError', reason: 'already_reviewed' });
  });

  it('a corrected date is decided against the record: a booking that now comes in time fulfills it', async () => {
    const harness = await makeHarness(options('booking'));
    // The patient booked for day 58: too late for "control en 1 mes" (due day 30).
    await day(harness, 0, [consultation('p-booking')]);
    await day(harness, 5, [
      appointmentBundle({
        id: 'appt-p-booking',
        patientId: 'p-booking',
        specialty: 'internal_medicine',
        start: dayToDate(58),
        bookedAt: dayToDate(5),
      }),
    ]);
    const item = await thePlanItem(harness, 'p-booking');
    // The doctor meant two months: the booking keeps the corrected plan.
    const result = await harness.engine.planItems.correct(
      harness.clinicId,
      item.id,
      { dueAt: dayToDate(60) },
      DOCTOR,
    );
    expect(result.replacement).toMatchObject({
      status: 'fulfilled',
      closedReason: 'fulfilled_by_appointment',
      closedBy: { resourceType: 'Appointment', id: 'appt-p-booking' },
    });
  });

  it('correcting an overdue item in a case keeps the case when it is still overdue', async () => {
    const harness = await makeHarness(options('in-case'));
    await day(harness, 0, [consultation('p-in-case')]);
    await day(harness, 31);
    const item = (await planItems(harness, 'p-in-case'))[0];
    expect(item).toMatchObject({ status: 'expired' });
    const caseIdOf = item?.caseId ?? caseId('none');
    // The note meant a lab, not a visit, and it was due a week earlier.
    const result = await harness.engine.planItems.correct(
      harness.clinicId,
      item?.id ?? ('' as ExpectationId),
      { kind: 'lab', dueAt: dayToDate(23) },
      DOCTOR,
    );
    expect(result.casesResolved).toEqual([]);
    expect(result.replacement).toMatchObject({
      status: 'expired',
      caseId: caseIdOf,
      matchKey: 'lab',
    });
    const followUpCase = await harness.read((stores) =>
      stores.cases.get(harness.clinicId, caseIdOf),
    );
    expect(followUpCase?.status).toBe('open');
    expect(followUpCase?.reasons.map((reason) => reason.expectationId)).toEqual([
      item?.id,
      result.replacement?.id,
    ]);
    const audit = await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, caseIdOf),
    );
    expect(audit.at(-1)).toMatchObject({
      type: 'plan_item_corrected',
      actor: { type: 'user', id: DOCTOR },
      payload: {
        expectationId: item?.id,
        replacementId: result.replacement?.id,
        kind: 'follow_up_visit',
        correctedKind: 'lab',
      },
    });
  });

  it('reject cancels the item and resolves the case when it was its only reason', async () => {
    const harness = await makeHarness(options('reject'));
    await day(harness, 0, [consultation('p-reject', { lab: true })]);
    await day(harness, 31);
    const item = (await planItems(harness, 'p-reject'))[0];
    const planCase = item?.caseId ?? caseId('none');
    const result = await harness.engine.planItems.reject(
      harness.clinicId,
      item?.id ?? ('' as ExpectationId),
      DOCTOR,
    );
    expect(result.expectation).toMatchObject({
      status: 'cancelled',
      closedReason: 'rejected_by_clinician',
    });
    expect(result.casesResolved).toEqual([planCase]);
    const { cases } = await snapshotPatient(harness, patientId('p-reject'));
    // The plan's case resolved; the pending lab result's case stays.
    expect(cases.find((candidate) => candidate.id === planCase)).toMatchObject({
      status: 'resolved',
      resolution: { kind: 'not_needed', resolvedBy: DOCTOR },
    });
    expect(cases.filter((candidate) => candidate.status === 'open').map((c) => c.ruleIds)).toEqual([
      ['lab_order_result_pending'],
    ]);
    const events = (await harness.pendingEvents()).filter(
      (event) => event.type === 'case.resolved',
    );
    expect(events).toMatchObject([{ payload: { caseId: planCase, resolution: 'not_needed' } }]);
    const audit = await harness.read((stores) =>
      stores.audit.listForCase(harness.clinicId, planCase),
    );
    expect(audit.map((event) => event.type).slice(-2)).toEqual(['plan_item_rejected', 'resolved']);
    expect(await reviews(harness, result.expectation.id)).toMatchObject([
      { type: 'plan_item_rejected', caseId: planCase, userId: DOCTOR },
    ]);
    const task = expectationToTask(result.expectation);
    expect(task.statusReason?.coding?.[0]?.code).toBe('rejected_by_clinician');
    expect(validateFhirR4(task).valid).toBe(true);
    // Re-reading the note never brings a rejected item back.
    await day(harness, 32, [consultation('p-reject', { lab: true })]);
    expect((await planItems(harness, 'p-reject')).map((e) => e.status)).toEqual(['cancelled']);
  });

  it('refuses what is not a reviewable plan item, an empty correction or a missing clinician', async () => {
    const harness = await makeHarness(options('refuse'));
    await day(harness, 0, [consultation('p-refuse', { lab: true })]);
    const all = (await snapshotPatient(harness, patientId('p-refuse'))).expectations;
    const lab = all.find((expectation) => expectation.ruleId === 'lab_order_result_pending');
    const item = await thePlanItem(harness, 'p-refuse');
    await expect(
      harness.engine.planItems.confirm(harness.clinicId, lab?.id ?? item.id, DOCTOR),
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'layer' });
    await expect(
      harness.engine.planItems.correct(harness.clinicId, item.id, { dueAt: item.dueAt }, DOCTOR),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      harness.engine.planItems.reject(harness.clinicId, item.id, ' '),
    ).rejects.toMatchObject({ field: 'userId' });
    await expect(
      harness.engine.planItems.confirm(harness.clinicId, 'exp-nope' as ExpectationId, DOCTOR),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    // An item the record already closed has nothing to correct or reject.
    await day(harness, 20, [
      transactionOf(
        encounterResource({
          id: 'enc-p-refuse-2',
          patientId: 'p-refuse',
          specialty: 'internal_medicine',
          at: dayToDate(20),
        }),
      ),
    ]);
    expect((await planItems(harness, 'p-refuse'))[0]?.status).toBe('fulfilled');
    await expect(
      harness.engine.planItems.reject(harness.clinicId, item.id, DOCTOR),
    ).rejects.toBeInstanceOf(PlanItemReviewConflictError);
    // Its reading can still be confirmed (extraction quality).
    const confirmed = await harness.engine.planItems.confirm(harness.clinicId, item.id, DOCTOR);
    expect(confirmed.expectation).toMatchObject({ status: 'fulfilled', confirmedBy: DOCTOR });
    expect(await reviews(harness, item.id)).toHaveLength(1);
  });
}

const TIMEOUT_MS = 30_000;

describe('plan item review: confirm, correct, reject (memory)', { timeout: TIMEOUT_MS }, () => {
  planItemReview((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('plan item review: confirm, correct, reject'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    planItemReview((options) => postgresHarness(database(), options));
  },
);
