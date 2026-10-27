import {
  ACTIVE_CASE_STATUSES,
  clinicId,
  type DomainEvent,
  type DomainEventOf,
  type Expectation,
  type PatientId,
  patientId,
  RECONCILIATION_ACTOR,
  type ReconciliationRepair,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import {
  BASE_DATE,
  dayToDate,
  loadScenarios,
  loadSyntheticClinic,
} from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  encounterResource,
  labOrderResource,
  observationResource,
  transactionOf,
} from '../src/bundles.ts';
import { CrashingUnitOfWork, InjectedCrash, readClinicState, stageHistory } from '../src/clinic.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';
import { runScenario, scenarioExtractor } from '../src/scenario-runner.ts';

/**
 * HIP-141: the nightly reconciliation is a safety net for lost and
 * out-of-order events. It replays each patient's stored record through the
 * same annotator as live ingestion, compares, and repairs exactly what is
 * inconsistent (audited as `system` / `reconciliation`); on a clean clinic
 * it changes nothing, however many times it runs.
 */

const HBA1C = '4548-4';
const TIMEOUT = 300_000;

type MakeHarness = (options: HarnessOptions) => Promise<EngineHarness>;

function eventsOf<TType extends DomainEvent['type']>(
  events: readonly DomainEvent[],
  type: TType,
): DomainEventOf<TType>[] {
  return events.filter((event): event is DomainEventOf<TType> => event.type === type);
}

/** A consultation with a lab order of HbA1c on `day`. */
function labConsultation(patient: string, id: string, day: number): unknown {
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

/** A normal HbA1c result answering the order `sr-<id>`. */
function labResult(patient: string, id: string, day: number): unknown {
  return transactionOf(
    observationResource({
      id: `obs-${id}`,
      patientId: patient,
      loinc: HBA1C,
      value: 5.4,
      unit: '%',
      interpretation: 'N',
      basedOn: `sr-${id}`,
      at: dayToDate(day),
    }),
  );
}

/**
 * Fault injection: the bundle is stored (resources and events), but its
 * events are never annotated, as when a consumer crashed between the two or
 * an import skipped the annotator.
 */
async function storeWithoutAnnotating(
  harness: EngineHarness,
  bundle: unknown,
  at: Date,
): Promise<void> {
  const mapped = mapBundleToBatches(bundle, { clinicId: harness.clinicId, receivedAt: at });
  await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
    for (const { patientId: owner, resource } of mapped.resources) {
      await stores.clinicalRecords.saveResource(harness.clinicId, owner, resource, at);
    }
    for (const batch of mapped.batches) {
      await stores.clinicalRecords.appendEvents(harness.clinicId, batch.events);
    }
  });
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

async function expectationsOf(
  harness: EngineHarness,
  patient: PatientId,
): Promise<readonly Expectation[]> {
  return harness.read((stores) => stores.expectations.listByPatient(harness.clinicId, patient));
}

const PATIENTS = {
  droppedResult: patientId('rec-dropped-result'),
  droppedOrder: patientId('rec-dropped-order'),
  corrupted: patientId('rec-corrupted'),
  deletedCase: patientId('rec-deleted-case'),
  control: patientId('rec-control'),
} as const;
const ALL = Object.values(PATIENTS);

/**
 * Five patients, the same clinical story for a clean twin and a faulted
 * clinic: `faults` decides whether the faults are injected.
 */
async function buildWorld(harness: EngineHarness, faults: boolean): Promise<void> {
  const p = PATIENTS;
  await day(harness, 0, [
    labConsultation(p.droppedResult, 'a', 0),
    labConsultation(p.corrupted, 'c', 0),
    labConsultation(p.deletedCase, 'd', 0),
    labConsultation(p.control, 'e', 0),
  ]);
  await day(harness, 3, [labResult(p.corrupted, 'c', 3), labResult(p.control, 'e', 3)]);
  // The order of patient B is lost in the faulted clinic.
  const order = labConsultation(p.droppedOrder, 'b', 5);
  if (faults) {
    harness.clock.set(dayToDate(5));
    await storeWithoutAnnotating(harness, order, dayToDate(5));
    await day(harness, 5);
  } else {
    await day(harness, 5, [order]);
  }
  for (let n = 6; n <= 19; n += 1) {
    await day(harness, n);
  }
  // A's lab expired into a case on day 15; its result arrives on day 20, and
  // is lost in the faulted clinic.
  const result = labResult(p.droppedResult, 'a', 20);
  if (faults) {
    harness.clock.set(dayToDate(20));
    await storeWithoutAnnotating(harness, result, dayToDate(20));
    await day(harness, 20);
  } else {
    await day(harness, 20, [result]);
  }
  for (let n = 21; n <= 25; n += 1) {
    await day(harness, n);
  }
  if (!faults) {
    return;
  }
  // C's fulfilled expectation loses its closure (a lost write).
  const [fulfilled] = await expectationsOf(harness, p.corrupted);
  if (fulfilled?.status !== 'fulfilled') {
    throw new Error('setup: patient C should have a fulfilled lab expectation');
  }
  await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
    const open: { -readonly [K in keyof Expectation]: Expectation[K] } = {
      ...fulfilled,
      status: 'open',
      updatedAt: dayToDate(25),
    };
    delete open.closedAt;
    delete open.closedBy;
    delete open.closedReason;
    await stores.expectations.update(harness.clinicId, open);
  });
  // D's case row disappears.
  const [expired] = await expectationsOf(harness, p.deletedCase);
  if (expired?.caseId === undefined) {
    throw new Error('setup: patient D should have an expired expectation in a case');
  }
  await harness.deleteCaseRow(expired.caseId);
}

/** The state a reconciliation must restore: expectations by key and status class, active cases by reasons. */
async function semanticState(harness: EngineHarness): Promise<string> {
  return harness.read(async (stores) => {
    const lines: string[] = [];
    for (const patient of ALL) {
      const expectations = await stores.expectations.listByPatient(harness.clinicId, patient);
      const keyOf = new Map(expectations.map((e) => [e.id, e.idempotencyKey]));
      for (const expectation of expectations) {
        const status =
          expectation.status === 'open' || expectation.status === 'expired'
            ? 'unmet'
            : expectation.status;
        lines.push(`${patient} ${expectation.idempotencyKey} ${status}`);
      }
      const active = await stores.cases.list(harness.clinicId, {
        patientId: patient,
        statuses: ACTIVE_CASE_STATUSES,
        limit: 100,
      });
      for (const followUpCase of active.items) {
        const reasons = followUpCase.reasons.map((reason) => keyOf.get(reason.expectationId));
        lines.push(`${patient} case ${followUpCase.dedupKey} [${reasons.sort().join(',')}]`);
      }
    }
    return lines.sort().join('\n');
  });
}

function summary(repairs: readonly ReconciliationRepair[]): string[] {
  return repairs.map((repair) => `${repair.patientId} ${repair.kind}`).sort();
}

function describeReconciliation(name: string, make: MakeHarness): void {
  const options = (suffix: string): HarnessOptions => ({
    clinicId: clinicId(`reconcile-${suffix}-${name}`),
    start: BASE_DATE,
  });

  it(
    'repairs exactly what a lost event, a corrupted status and a deleted case left, and audits it',
    async () => {
      const twin = await make(options('twin'));
      await buildWorld(twin, false);
      const faulted = await make(options('faulted'));
      await buildWorld(faulted, true);
      const before = await faulted.pendingEvents();

      const report = await faulted.engine.reconciliation.run(faulted.clinicId, { scope: 'all' });

      const p = PATIENTS;
      expect(summary(report.repairs)).toEqual(
        [
          `${p.droppedResult} expectation_fulfilled`,
          `${p.droppedResult} case_resolved`,
          `${p.droppedOrder} expectation_created`,
          `${p.droppedOrder} case_opened`,
          `${p.corrupted} expectation_fulfilled`,
          `${p.deletedCase} expectation_unlinked`,
          `${p.deletedCase} case_opened`,
        ].sort(),
      );
      expect(report.repairs.every((repair) => repair.actor.type === 'system')).toBe(true);
      expect(report.run).toMatchObject({
        status: 'completed',
        scope: 'all',
        patientsScanned: 5,
        patientsRepaired: 4,
        patientsSkipped: 0,
        repairs: 7,
        repairsByKind: {
          expectation_fulfilled: 2,
          expectation_created: 1,
          expectation_unlinked: 1,
          case_opened: 2,
          case_resolved: 1,
        },
      });
      // The repaired clinic is, in substance, the clinic that lost nothing.
      expect(await semanticState(faulted)).toBe(await semanticState(twin));

      // Every case it touched is audited as the reconciliation.
      const touched = report.repairs.filter((repair) => repair.kind.startsWith('case_'));
      for (const repair of touched) {
        const trail = await faulted.read((stores) =>
          stores.audit.listForCase(faulted.clinicId, repair.entityId as never),
        );
        const last = trail.at(-1);
        expect(last?.actor).toEqual(RECONCILIATION_ACTOR);
        expect(last?.payload['reason']).toBe('reconciliation');
      }
      // The repair log keeps every repair of the run.
      expect(
        summary(
          await faulted.engine.reconciliation.repairs(faulted.clinicId, {
            runId: report.run.runId,
          }),
        ),
      ).toEqual(summary(report.repairs));

      // Webhooks: the run's counts, and the alert because it repaired something.
      const emitted = (await faulted.pendingEvents()).slice(before.length);
      const [completed] = eventsOf(emitted, 'reconciliation.completed');
      const [alert] = eventsOf(emitted, 'reconciliation.repairs_found');
      expect(completed?.payload).toMatchObject({ runId: report.run.runId, repairs: 7 });
      expect(alert?.payload).toMatchObject({ patientsRepaired: 4, repairs: 7 });
      expect(eventsOf(emitted, 'case.resolved')).toHaveLength(1);
      expect(eventsOf(emitted, 'case.opened')).toHaveLength(2);

      // Run twice = same state: the second run repairs nothing and emits no alert.
      const state = (await readClinicState(faulted, ALL)).fingerprint;
      const again = await faulted.engine.reconciliation.run(faulted.clinicId, { scope: 'all' });
      expect(again.repairs).toEqual([]);
      expect((await readClinicState(faulted, ALL)).fingerprint).toBe(state);
      const afterSecond = (await faulted.pendingEvents()).slice(before.length + emitted.length);
      expect(eventsOf(afterSecond, 'reconciliation.repairs_found')).toEqual([]);
      expect(eventsOf(afterSecond, 'reconciliation.completed')).toHaveLength(1);

      // The clean twin: nothing to repair.
      const clean = await twin.engine.reconciliation.run(twin.clinicId, { scope: 'all' });
      expect(clean.repairs).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    '`recent` looks only at patients with events stored since the last run',
    async () => {
      const harness = await make(options('recent'));
      await buildWorld(harness, false);
      const first = await harness.engine.reconciliation.run(harness.clinicId);
      expect(first.run).toMatchObject({ scope: 'recent', patientsScanned: 5, repairs: 0 });
      expect(first.run.since).toBeUndefined();
      // A lost event for one patient after the first run: only that patient is looked at.
      harness.clock.set(dayToDate(26));
      await storeWithoutAnnotating(
        harness,
        labConsultation(PATIENTS.control, 'late', 26),
        dayToDate(26),
      );
      const second = await harness.engine.reconciliation.run(harness.clinicId);
      // The lost consultation's lab order, and the visit pattern its second visit makes.
      expect(second.run).toMatchObject({
        scope: 'recent',
        since: first.run.watermark,
        patientsScanned: 1,
        repairs: 2,
      });
      expect(
        second.repairs.map((repair) => `${repair.kind} ${repair.ruleId ?? ''}`).sort(),
      ).toEqual([
        'expectation_created cadence_break',
        'expectation_created lab_order_result_pending',
      ]);
      const third = await harness.engine.reconciliation.run(harness.clinicId);
      expect(third.run).toMatchObject({ patientsScanned: 0, repairs: 0 });
    },
    TIMEOUT,
  );

  it(
    'never applies a rule change retroactively: what a disabled rule did not create stays absent',
    async () => {
      const harness = await make(options('retroactive'));
      const meta = { actor: 'ops', reason: 'lab paused' };
      harness.clock.set(dayToDate(0));
      await harness.engine.ruleOverrides.disable(
        harness.clinicId,
        'lab_order_result_pending',
        meta,
      );
      await day(harness, 1, [labConsultation(PATIENTS.control, 'paused', 1)]);
      await day(harness, 2, [labConsultation(PATIENTS.corrupted, 'other', 2)]);
      harness.clock.set(dayToDate(3));
      await harness.engine.ruleOverrides.reset(harness.clinicId, 'lab_order_result_pending', meta);
      await harness.engine.ruleOverrides.set(
        harness.clinicId,
        'imaging_order_result_pending',
        { dueInDays: 20 },
        meta,
      );
      const report = await harness.engine.reconciliation.run(harness.clinicId, { scope: 'all' });
      expect(report.repairs).toEqual([]);
      expect(
        (await expectationsOf(harness, PATIENTS.control)).filter(
          (expectation) => expectation.ruleId === 'lab_order_result_pending',
        ),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'resumes a crashed run after the last patient it finished, with the same totals',
    async () => {
      let crashing: CrashingUnitOfWork | undefined;
      const harness = await make({
        ...options('resume'),
        wrapUnitOfWork: (unitOfWork) => (crashing = new CrashingUnitOfWork(unitOfWork)),
      });
      await buildWorld(harness, true);
      // Start, plan and repair two patients, then die in the middle of the third.
      crashing?.arm(6);
      await expect(
        harness.engine.reconciliation.run(harness.clinicId, { scope: 'all', runId: 'nightly-1' }),
      ).rejects.toBeInstanceOf(InjectedCrash);
      crashing?.disarm();
      const interrupted = await harness.read((stores) =>
        stores.reconciliation.get(harness.clinicId, 'nightly-1'),
      );
      expect(interrupted?.status).toBe('running');
      expect(interrupted?.patientsScanned).toBeGreaterThan(0);
      expect(interrupted?.patientsScanned).toBeLessThan(5);

      const resumed = await harness.engine.reconciliation.run(harness.clinicId, { scope: 'all' });
      expect(resumed.resumed).toBe(true);
      expect(resumed.run).toMatchObject({
        runId: 'nightly-1',
        status: 'completed',
        patientsScanned: 5,
        patientsRepaired: 4,
        repairs: 7,
      });
      const all = await harness.engine.reconciliation.repairs(harness.clinicId, {
        runId: 'nightly-1',
      });
      expect(all).toHaveLength(7);
      expect(new Set(all.map((repair) => `${repair.kind}:${repair.entityId}`)).size).toBe(7);
    },
    TIMEOUT,
  );

  it(
    'is a no-op on the synthetic clinic after its backfill and three weeks of sweeps',
    async () => {
      const { patients } = loadSyntheticClinic();
      const ids = patients.map((patient) => patientId(patient.patientId));
      const harness = await make(options('synthetic'));
      await stageHistory(harness, patients);
      await harness.engine.backfill.run(harness.clinicId);
      for (let n = 1; n <= 21; n += 1) {
        await day(harness, n);
      }
      const before = await readClinicState(harness, ids);
      const report = await harness.engine.reconciliation.run(harness.clinicId, { scope: 'all' });
      expect(report.run).toMatchObject({ patientsScanned: patients.length, repairs: 0 });
      expect((await readClinicState(harness, ids)).fingerprint).toBe(before.fingerprint);
    },
    TIMEOUT,
  );
}

describe('reconciliation (memory)', () => {
  describeReconciliation('memory', (options) => Promise.resolve(memoryHarness(options)));

  const scenarios = loadScenarios();
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    'is a no-op at the end of the %s scenario, run twice',
    async (name, scenario) => {
      const harness = memoryHarness({
        clinicId: clinicId(`reconcile-scenario-${name}`),
        start: BASE_DATE,
        extractor: scenarioExtractor(scenario),
      });
      expect(await runScenario(harness, scenario)).toEqual([]);
      const patients = [patientId(scenario.patientId)];
      const before = (await readClinicState(harness, patients)).fingerprint;
      for (let run = 0; run < 2; run += 1) {
        const report = await harness.engine.reconciliation.run(harness.clinicId, { scope: 'all' });
        expect(report.repairs).toEqual([]);
        expect((await readClinicState(harness, patients)).fingerprint).toBe(before);
      }
    },
  );
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('reconciliation'), () => {
  const database = useIsolatedDatabase();
  describeReconciliation('postgres', (options) => postgresHarness(database(), options));

  const scenarios = loadScenarios();
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    'is a no-op at the end of the %s scenario',
    async (name, scenario) => {
      const harness = await postgresHarness(database(), {
        clinicId: clinicId(`reconcile-scenario-${name}`),
        start: BASE_DATE,
        extractor: scenarioExtractor(scenario),
      });
      expect(await runScenario(harness, scenario)).toEqual([]);
      const report = await harness.engine.reconciliation.run(harness.clinicId, { scope: 'all' });
      expect(report.repairs).toEqual([]);
    },
    60_000,
  );
});
