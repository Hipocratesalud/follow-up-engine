import { loadConfigDirectory } from '@follow-up-engine/adapter-memory';
import { clinicId, type Expectation, patientId } from '@follow-up-engine/core';
import { expectationToTask } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate, validateFhirR4 } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  encounterResource,
  labOrderResource,
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

/**
 * HIP-141: per-clinic rule overrides, persisted, versioned and audited. A
 * change applies to expectations created after it (they carry the new rule
 * version); existing ones keep their deadline and version. A disabled rule
 * creates nothing new; a reset restores the versioned rule. Other clinics
 * are untouched.
 */

const LAB_RULE = 'lab_order_result_pending';
const LAB_DAYS = 15;
/** The versioned rule's own version (config/rules/universal.json). */
const LAB_VERSION =
  loadConfigDirectory().rules.find((rule) => rule.id === LAB_RULE)?.version ?? 'unknown';
const HBA1C = '4548-4';
const META = { actor: 'dr-ruiz', reason: 'Our lab answers in a week' };

type MakeHarness = (options: HarnessOptions) => Promise<EngineHarness>;

function labOrder(patient: string, id: string, day: number): unknown {
  const at = dayToDate(day);
  return transactionOf(
    encounterResource({ id: `enc-${id}`, patientId: patient, specialty: 'internal_medicine', at }),
    labOrderResource({
      id: `sr-${id}`,
      patientId: patient,
      loinc: HBA1C,
      encounterId: `enc-${id}`,
      at,
    }),
  );
}

async function labExpectation(
  harness: EngineHarness,
  patient: string,
  orderId: string,
): Promise<Expectation | undefined> {
  const all = await harness.read((stores) =>
    stores.expectations.listByPatient(harness.clinicId, patientId(patient)),
  );
  return all.find(
    (expectation) => expectation.ruleId === LAB_RULE && expectation.source.id === `sr-${orderId}`,
  );
}

function dueInDays(expectation: Expectation | undefined, from: number): number | undefined {
  return expectation === undefined
    ? undefined
    : Math.round((expectation.dueAt.getTime() - dayToDate(from).getTime()) / 86_400_000);
}

async function ingestAt(harness: EngineHarness, day: number, bundle: unknown): Promise<void> {
  harness.clock.set(dayToDate(day));
  await ingestBundle(harness, bundle, dayToDate(day));
}

function describeRuleOverrides(name: string, make: MakeHarness): void {
  const options = (suffix: string): HarnessOptions => ({
    clinicId: clinicId(`overrides-${suffix}-${name}`),
    start: BASE_DATE,
  });

  it('changes the deadline of new expectations only, and stamps them with the new version', async () => {
    const harness = await make(options('deadline'));
    await ingestAt(harness, 0, labOrder('pat-1', 'before', 0));
    const before = await labExpectation(harness, 'pat-1', 'before');
    expect(dueInDays(before, 0)).toBe(LAB_DAYS);
    expect(before?.ruleVersion).toBe(LAB_VERSION);

    harness.clock.set(dayToDate(1));
    const result = await harness.engine.ruleOverrides.set(
      harness.clinicId,
      LAB_RULE,
      { dueInDays: 10 },
      META,
    );
    expect(result.change).toMatchObject({ version: 1, action: 'set', next: { dueInDays: 10 } });
    expect(result.rule).toMatchObject({
      ruleId: LAB_RULE,
      defaults: { dueInDays: LAB_DAYS, enabled: true },
      effective: { dueInDays: 10, enabled: true },
      version: `${LAB_VERSION}+clinic.1`,
    });

    // (Another patient: a new order of the same test would supersede pat-1's.)
    await ingestAt(harness, 2, labOrder('pat-3', 'after', 2));
    await ingestAt(harness, 2, labOrder('pat-2', 'other', 2));
    const after = await labExpectation(harness, 'pat-3', 'after');
    expect(dueInDays(after, 2)).toBe(10);
    expect(after?.ruleVersion).toBe(`${LAB_VERSION}+clinic.1`);
    // The FHIR Task the host reads carries it, and is still valid R4.
    if (after === undefined) {
      throw new Error('the lab expectation created after the change is missing');
    }
    const task = expectationToTask(after);
    expect(JSON.stringify(task.extension)).toContain(`${LAB_VERSION}+clinic.1`);
    expect(validateFhirR4(task).issues).toEqual([]);
    expect(dueInDays(await labExpectation(harness, 'pat-2', 'other'), 2)).toBe(10);
    // The expectation created before the change keeps its deadline and version.
    expect(await labExpectation(harness, 'pat-1', 'before')).toEqual(before);

    // The watcher expires each on its own deadline: day 12 for the new one, day 15 for the old.
    harness.clock.set(dayToDate(12));
    await harness.engine.runWatcher(harness.clinicId, dayToDate(12));
    expect((await labExpectation(harness, 'pat-3', 'after'))?.status).toBe('expired');
    expect((await labExpectation(harness, 'pat-1', 'before'))?.status).toBe('open');
  });

  it('a disabled rule creates nothing new; what it created before still closes', async () => {
    const harness = await make(options('disabled'));
    await ingestAt(harness, 0, labOrder('pat-1', 'before', 0));
    harness.clock.set(dayToDate(1));
    const disabled = await harness.engine.ruleOverrides.disable(harness.clinicId, LAB_RULE, META);
    expect(disabled.rule.effective.enabled).toBe(false);

    await ingestAt(harness, 2, labOrder('pat-2', 'after', 2));
    expect(await labExpectation(harness, 'pat-2', 'after')).toBeUndefined();
    const catalog = await harness.engine.catalog(harness.clinicId);
    expect(catalog.rules.map((rule) => rule.id)).not.toContain(LAB_RULE);

    // The result of the order made before the switch still fulfills its expectation.
    await ingestAt(
      harness,
      4,
      transactionOf(
        observationResource({
          id: 'obs-before',
          patientId: 'pat-1',
          loinc: HBA1C,
          value: 5.4,
          unit: '%',
          interpretation: 'N',
          basedOn: 'sr-before',
          at: dayToDate(4),
        }),
      ),
    );
    expect((await labExpectation(harness, 'pat-1', 'before'))?.status).toBe('fulfilled');
  });

  it('reset restores the versioned rule; the history keeps who, when, old → new and why', async () => {
    const harness = await make(options('reset'));
    const clinic = harness.clinicId;
    harness.clock.set(dayToDate(1));
    await harness.engine.ruleOverrides.set(clinic, LAB_RULE, { dueInDays: 10 }, META);
    harness.clock.set(dayToDate(2));
    await harness.engine.ruleOverrides.disable(clinic, LAB_RULE, {
      actor: 'coordinator',
      reason: 'Paused while the lab changes provider',
    });
    harness.clock.set(dayToDate(3));
    const reset = await harness.engine.ruleOverrides.reset(clinic, LAB_RULE, {
      actor: 'coordinator',
      reason: 'New provider is live',
    });
    expect(reset.change).toMatchObject({ version: 3, action: 'reset' });
    expect(reset.rule).toMatchObject({
      effective: { dueInDays: LAB_DAYS, enabled: true },
      version: LAB_VERSION,
    });
    expect(reset.rule.override).toBeUndefined();

    await ingestAt(harness, 4, labOrder('pat-1', 'after-reset', 4));
    const restored = await labExpectation(harness, 'pat-1', 'after-reset');
    expect(dueInDays(restored, 4)).toBe(LAB_DAYS);
    expect(restored?.ruleVersion).toBe(LAB_VERSION);

    const history = await harness.engine.ruleOverrides.history(clinic, { ruleId: LAB_RULE });
    expect(history).toEqual([
      {
        clinicId: clinic,
        ruleId: LAB_RULE,
        version: 3,
        action: 'reset',
        previous: { dueInDays: 10, enabled: false },
        actor: 'coordinator',
        reason: 'New provider is live',
        at: dayToDate(3),
      },
      {
        clinicId: clinic,
        ruleId: LAB_RULE,
        version: 2,
        action: 'set',
        previous: { dueInDays: 10 },
        next: { dueInDays: 10, enabled: false },
        actor: 'coordinator',
        reason: 'Paused while the lab changes provider',
        at: dayToDate(2),
      },
      {
        clinicId: clinic,
        ruleId: LAB_RULE,
        version: 1,
        action: 'set',
        next: { dueInDays: 10 },
        actor: 'dr-ruiz',
        reason: 'Our lab answers in a week',
        at: dayToDate(1),
      },
    ]);
    // Setting the same value again changes nothing and writes no history.
    expect(
      (await harness.engine.ruleOverrides.set(clinic, LAB_RULE, { dueInDays: LAB_DAYS }, META))
        .change,
    ).toBeUndefined();
    expect(await harness.engine.ruleOverrides.history(clinic)).toHaveLength(3);
  });

  it('isolates clinics', async () => {
    const changed = await make(options('isolated-a'));
    const other = await make(options('isolated-b'));
    await changed.engine.ruleOverrides.set(changed.clinicId, LAB_RULE, { dueInDays: 5 }, META);
    await ingestAt(other, 0, labOrder('pat-1', 'b', 0));
    expect(dueInDays(await labExpectation(other, 'pat-1', 'b'), 0)).toBe(LAB_DAYS);
    expect(await other.engine.ruleOverrides.history(other.clinicId)).toEqual([]);
    const listed = await other.engine.ruleOverrides.list(other.clinicId);
    expect(listed.find((rule) => rule.ruleId === LAB_RULE)?.override).toBeUndefined();
  });

  it('validates: known rules and fields only, whole days of at least one, a reason', async () => {
    const harness = await make(options('validation'));
    const clinic = harness.clinicId;
    const rules = harness.engine.ruleOverrides;
    const cases: readonly [() => Promise<unknown>, string][] = [
      [() => rules.set(clinic, 'no_such_rule', { dueInDays: 10 }, META), 'ruleId'],
      [() => rules.set(clinic, 'protocol_diabetes_hba1c', { dueInDays: 10 }, META), 'ruleId'],
      [() => rules.set(clinic, LAB_RULE, { dueInDays: -3 }, META), 'dueInDays'],
      [() => rules.set(clinic, LAB_RULE, { dueInDays: 0 }, META), 'dueInDays'],
      [() => rules.set(clinic, LAB_RULE, { dueInDays: 2.5 }, META), 'dueInDays'],
      [() => rules.set(clinic, LAB_RULE, { priority: 90 }, META), 'priority'],
      [() => rules.set(clinic, LAB_RULE, {}, META), 'override'],
      [() => rules.set(clinic, LAB_RULE, { dueInDays: 10 }, { actor: 'x', reason: ' ' }), 'reason'],
      [() => rules.disable(clinic, LAB_RULE, { actor: '', reason: 'x' }), 'actor'],
    ];
    for (const [attempt, field] of cases) {
      await expect(attempt()).rejects.toMatchObject({ name: 'ValidationError', field });
    }
    expect(await rules.history(clinic)).toEqual([]);
    await expect(
      rules.set(clinic, LAB_RULE, { dueInDays: 10 }, { ...META, expectedVersion: 3 }),
    ).rejects.toMatchObject({ name: 'ConflictError' });
  });
}

describe('rule overrides (memory)', () => {
  describeRuleOverrides('memory', (options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('rule overrides'), () => {
  const database = useIsolatedDatabase();
  describeRuleOverrides('postgres', (options) => postgresHarness(database(), options));

  it('a change made by one process reaches another process at once (cache validated by revision)', async () => {
    const options = { clinicId: clinicId('overrides-two-processes'), start: BASE_DATE };
    const api = await postgresHarness(database(), options);
    const worker = await postgresHarness(database(), options);
    // The worker caches the clinic's rules.
    await ingestAt(worker, 0, labOrder('pat-1', 'first', 0));
    expect(dueInDays(await labExpectation(worker, 'pat-1', 'first'), 0)).toBe(LAB_DAYS);
    await api.engine.ruleOverrides.set(options.clinicId, LAB_RULE, { dueInDays: 7 }, META);
    await ingestAt(worker, 1, labOrder('pat-1', 'second', 1));
    const second = await labExpectation(worker, 'pat-1', 'second');
    expect(dueInDays(second, 1)).toBe(7);
    expect(second?.ruleVersion).toBe(`${LAB_VERSION}+clinic.1`);
  });
});
