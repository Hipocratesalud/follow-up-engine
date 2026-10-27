import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  clinicId,
  type DismissInput,
  type Expectation,
  type FollowUpCase,
  patientId,
  SUPPRESSED_FOR_PATIENT,
  ValidationError,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  conditionResource,
  encounterResource,
  observationResource,
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
 * HIP-136: "Descartar" needs a reason with an effect. The reason is the
 * case's feedback (one input); "No aplica a este paciente" can stop the rule
 * for that patient only, in every layer and in the backfill, until someone
 * reactivates it. A known diabetic's HbA1c is expected every 90 days by the
 * diabetes protocol: a result on day 0 opens a case on day 90.
 */

const HBA1C_RULE = 'protocol_diabetes_hba1c';
const USER = { type: 'user', id: 'dra-mora' } as const;

/** The value, which the test just asserted is there. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

async function day(harness: EngineHarness, n: number, bundles: readonly unknown[] = []) {
  const now = dayToDate(n);
  harness.clock.set(now);
  for (const bundle of bundles) {
    await ingestBundle(harness, bundle, now);
  }
  await harness.engine.runWatcher(harness.clinicId, now);
  await harness.engine.runEscalation(harness.clinicId, now);
}

/** A diabetology visit of a known diabetic with an HbA1c at target. */
function diabeticVisit(patient: string, at: number, suffix = '1'): unknown {
  return transactionOf(
    encounterResource({
      id: `enc-${patient}-${suffix}`,
      patientId: patient,
      specialty: 'diabetology',
      at: dayToDate(at),
    }),
    conditionResource({
      id: `cond-${patient}`,
      patientId: patient,
      icd10: 'E11.9',
      verification: 'confirmed',
      at: dayToDate(at),
    }),
    hba1c(patient, at, suffix),
  );
}

function hba1c(patient: string, at: number, suffix: string) {
  return observationResource({
    id: `obs-${patient}-${suffix}`,
    patientId: patient,
    loinc: '4548-4',
    value: 7,
    unit: '%',
    at: dayToDate(at),
  });
}

function hba1cResult(patient: string, at: number, suffix: string): unknown {
  return transactionOf(hba1c(patient, at, suffix));
}

async function expectationsOf(harness: EngineHarness, patient: string): Promise<Expectation[]> {
  return (await snapshotPatient(harness, patientId(patient))).expectations.filter(
    (expectation) => expectation.ruleId === HBA1C_RULE,
  );
}

/** Active cases with an HbA1c reason (the protocol's 6-month visit has cases of its own). */
async function activeCases(harness: EngineHarness, patient: string): Promise<FollowUpCase[]> {
  return (await snapshotPatient(harness, patientId(patient))).cases.filter(
    (followUpCase) =>
      ['open', 'notified', 'snoozed', 'escalated'].includes(followUpCase.status) &&
      followUpCase.ruleIds.includes(HBA1C_RULE),
  );
}

/** Day 0 visit, day 90 the HbA1c case. */
async function hba1cCase(harness: EngineHarness, patient: string): Promise<FollowUpCase> {
  await day(harness, 0, [diabeticVisit(patient, 0)]);
  await day(harness, 90);
  const [followUpCase, ...rest] = await activeCases(harness, patient);
  expect(rest).toEqual([]);
  expect(followUpCase?.reasons.map((reason) => reason.reasonCode)).toEqual([HBA1C_RULE]);
  return defined(followUpCase);
}

function dismissalAndSuppression(makeHarness: (options: HarnessOptions) => Promise<EngineHarness>) {
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-dismiss-${name}-${String(Date.now())}`),
    start: BASE_DATE,
    extractor: new FakeNoteExtractor(),
  });

  it('a dismissal needs a consistent reason', async () => {
    const harness = await makeHarness(options('validation'));
    const { id } = await hba1cCase(harness, 'p-validation');
    const dismiss = (input: DismissInput) =>
      harness.engine.cases.dismiss(harness.clinicId, id, USER, input);
    await expect(dismiss({} as DismissInput)).rejects.toBeInstanceOf(ValidationError);
    await expect(dismiss({ reason: 'other' })).rejects.toBeInstanceOf(ValidationError);
    await expect(dismiss({ reason: 'other', note: '   ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      dismiss({ reason: 'wrong_interval', suppressRuleIds: [HBA1C_RULE] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      dismiss({ reason: 'not_applicable_to_patient', suppressRuleIds: ['cadence_break'] }),
    ).rejects.toBeInstanceOf(ValidationError);
    // What a clinician asks for (an order, the plan, an abnormal result) is
    // never switched off for one patient: only protocol items and the visit pattern.
    for (const ruleId of ['lab_order_result_pending', 'doctor_plan_followup']) {
      await expect(
        harness.engine.suppressions.suppress(harness.clinicId, {
          patientId: patientId('p-validation'),
          ruleId,
          actor: USER,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    // Nothing happened on the failed attempts.
    expect((await activeCases(harness, 'p-validation')).map((c) => c.id)).toEqual([id]);
    expect(
      await harness.read((stores) =>
        stores.suppressions.listForPatient(harness.clinicId, patientId('p-validation')),
      ),
    ).toEqual([]);
    expect(
      await harness.read((stores) => stores.feedback.listForCase(harness.clinicId, id)),
    ).toEqual([]);
  });

  it('the dismissal reason is the case feedback: one input', async () => {
    const harness = await makeHarness(options('feedback'));
    const { id } = await hba1cCase(harness, 'p-feedback');
    const result = await harness.engine.cases.dismiss(harness.clinicId, id, USER, {
      reason: 'already_done',
      note: 'Lo hizo en otro laboratorio',
    });
    expect(result.followUpCase).toMatchObject({
      status: 'dismissed',
      resolution: { kind: 'not_needed', dismissReason: 'already_done', resolvedBy: USER.id },
    });
    expect(result.suppressions).toEqual([]);
    const feedback = await harness.read((stores) =>
      stores.feedback.listForCase(harness.clinicId, id),
    );
    expect(feedback).toMatchObject([
      {
        useful: false,
        reason: 'already_done',
        comment: 'Lo hizo en otro laboratorio',
        authorId: USER.id,
      },
    ]);
    expect(
      (await harness.pendingEvents()).filter((event) => event.type === 'case.resolved'),
    ).toMatchObject([{ payload: { caseId: id, resolution: 'not_needed' } }]);
  });

  it('not applicable to the patient: the rule never comes back for them, only for others', async () => {
    const harness = await makeHarness(options('suppress'));
    const suppressedCase = await hba1cCase(harness, 'p-suppressed');
    const { suppressions } = await harness.engine.cases.dismiss(
      harness.clinicId,
      suppressedCase.id,
      USER,
      { reason: 'not_applicable_to_patient', suppressRuleIds: [HBA1C_RULE] },
    );
    expect(suppressions).toMatchObject([
      {
        patientId: 'p-suppressed',
        ruleId: HBA1C_RULE,
        dismissReason: 'not_applicable_to_patient',
        caseId: suppressedCase.id,
        createdBy: USER.id,
        createdAt: dayToDate(90),
      },
    ]);
    expect(suppressions[0]?.revokedAt).toBeUndefined();
    // Another patient, dismissed for another reason: nothing suppressed.
    const otherCase = await hba1cCase(harness, 'p-other');
    await harness.engine.cases.dismiss(harness.clinicId, otherCase.id, USER, {
      reason: 'wrong_interval',
    });

    // A new HbA1c moves the protocol's anchor for both patients.
    await day(harness, 100, [
      hba1cResult('p-suppressed', 100, '2'),
      hba1cResult('p-other', 100, '2'),
    ]);
    await day(harness, 191);
    expect(await expectationsOf(harness, 'p-suppressed')).toMatchObject([
      { status: 'cancelled', closedReason: SUPPRESSED_FOR_PATIENT },
    ]);
    expect(await activeCases(harness, 'p-suppressed')).toEqual([]);
    const other = await expectationsOf(harness, 'p-other');
    expect(other.map((expectation) => expectation.status)).toEqual(['expired', 'expired']);
    expect(await activeCases(harness, 'p-other')).toHaveLength(1);

    // Listed on the patient page, with who, when and why.
    expect(
      await harness.engine.suppressions.list(harness.clinicId, patientId('p-suppressed')),
    ).toMatchObject([{ ruleId: HBA1C_RULE, reason: { code: HBA1C_RULE } }]);
    expect(await harness.engine.suppressions.list(harness.clinicId, patientId('p-other'))).toEqual(
      [],
    );
  });

  it('reactivated: the rule fires again for the patient', async () => {
    const harness = await makeHarness(options('reactivate'));
    const followUpCase = await hba1cCase(harness, 'p-back');
    const [suppression] = (
      await harness.engine.cases.dismiss(harness.clinicId, followUpCase.id, USER, {
        reason: 'not_applicable_to_patient',
        suppressRuleIds: [HBA1C_RULE],
      })
    ).suppressions;
    await day(harness, 95);
    expect(await activeCases(harness, 'p-back')).toEqual([]);
    const revoked = await harness.engine.suppressions.reactivate(
      harness.clinicId,
      defined(suppression).id,
      USER,
    );
    expect(revoked).toMatchObject({ revokedAt: dayToDate(95), revokedBy: USER.id });
    await expect(
      harness.engine.suppressions.reactivate(harness.clinicId, revoked.id, USER),
    ).rejects.toThrow();
    // Still overdue: the reminder it withdrew is back, as a new case.
    await day(harness, 96);
    const [again] = await activeCases(harness, 'p-back');
    expect(again?.id).not.toBe(followUpCase.id);
    expect(again?.reasons.map((reason) => reason.reasonCode)).toEqual([HBA1C_RULE]);
    expect(
      await harness.engine.suppressions.list(harness.clinicId, patientId('p-back'), {
        activeOnly: true,
      }),
    ).toEqual([]);
  });

  it('reactivated after the test was done meanwhile: no stale case, the next one counts from it', async () => {
    const harness = await makeHarness(options('reactivate-done'));
    const followUpCase = await hba1cCase(harness, 'p-done');
    const [suppression] = (
      await harness.engine.cases.dismiss(harness.clinicId, followUpCase.id, USER, {
        reason: 'not_applicable_to_patient',
        suppressRuleIds: [HBA1C_RULE],
      })
    ).suppressions;
    await day(harness, 100, [hba1cResult('p-done', 100, '2')]);
    harness.clock.set(dayToDate(101));
    await harness.engine.suppressions.reactivate(harness.clinicId, defined(suppression).id, USER);
    await day(harness, 102);
    expect(await activeCases(harness, 'p-done')).toEqual([]);
    const live = (await expectationsOf(harness, 'p-done')).filter(
      (expectation) => expectation.status === 'open',
    );
    expect(live.map((expectation) => expectation.dueAt)).toEqual([dayToDate(190)]);
  });

  it('a suppression is respected by the backfill', async () => {
    const harness = await makeHarness(options('backfill'));
    harness.clock.set(dayToDate(0));
    await harness.engine.suppressions.suppress(harness.clinicId, {
      patientId: patientId('p-bf-suppressed'),
      ruleId: HBA1C_RULE,
      note: 'Paciente en cuidados paliativos',
      actor: USER,
    });
    await expect(
      harness.engine.suppressions.suppress(harness.clinicId, {
        patientId: patientId('p-bf-suppressed'),
        ruleId: 'no_such_rule',
        actor: USER,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    for (const patient of ['p-bf-suppressed', 'p-bf-other']) {
      const history = mapBundleToBatches(diabeticVisit(patient, -60), {
        clinicId: harness.clinicId,
        receivedAt: dayToDate(-60),
      });
      for (const batch of history.batches) {
        await harness.engine.backfill.stage(batch);
      }
    }
    await harness.engine.backfill.run(harness.clinicId);
    expect(await expectationsOf(harness, 'p-bf-suppressed')).toEqual([]);
    expect(await expectationsOf(harness, 'p-bf-other')).toMatchObject([
      { status: 'open', dueAt: dayToDate(30), origin: 'backfill' },
    ]);
  });

  it('calibration counts dismissals by reason and the useful rate per rule', async () => {
    const harness = await makeHarness(options('calibration'));
    const cases = [];
    for (const patient of ['p-cal-1', 'p-cal-2', 'p-cal-3']) {
      await day(harness, 0, [diabeticVisit(patient, 0)]);
    }
    await day(harness, 90);
    for (const patient of ['p-cal-1', 'p-cal-2', 'p-cal-3']) {
      cases.push(...(await activeCases(harness, patient)));
    }
    const [first, second, third] = cases as [FollowUpCase, FollowUpCase, FollowUpCase];
    await harness.engine.cases.dismiss(harness.clinicId, first.id, USER, {
      reason: 'wrong_interval',
    });
    await harness.engine.cases.dismiss(harness.clinicId, second.id, USER, {
      reason: 'not_applicable_to_patient',
      suppressRuleIds: [HBA1C_RULE],
    });
    await harness.engine.cases.recordFeedback(harness.clinicId, third.id, {
      useful: true,
      authorId: USER.id,
    });
    const report = await harness.engine.calibration(harness.clinicId);
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]).toMatchObject({
      ruleId: HBA1C_RULE,
      layer: 'protocol',
      casesWithFeedback: 3,
      useful: 1,
      notUseful: 2,
      dismissals: {
        wrong_interval: 1,
        not_applicable_to_patient: 1,
        handled_elsewhere: 0,
        already_done: 0,
        wrong_diagnosis: 0,
        other: 0,
      },
      notUsefulReasons: { wrong_interval: 1, not_applicable_to_patient: 1 },
    });
    expect(report.rules[0]?.usefulRate).toBeCloseTo(1 / 3);
    // `since` excludes what came before it.
    expect(
      (await harness.engine.calibration(harness.clinicId, { since: dayToDate(91) })).rules,
    ).toEqual([]);
  });
}

const TIMEOUT_MS = 30_000;

describe('dismissal and per-patient suppression (memory)', { timeout: TIMEOUT_MS }, () => {
  dismissalAndSuppression((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('dismissal and per-patient suppression'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    dismissalAndSuppression((options) => postgresHarness(database(), options));
  },
);
