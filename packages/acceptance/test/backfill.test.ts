import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  BACKFILL_UNSCHEDULED_RELEASE_AT,
  type BackfillCounts,
  type BackfillReport,
  clinicId,
  type DomainEvent,
  type DomainEventOf,
  isActiveCaseStatus,
  LlmBudgetExceededError,
  type NoteExtraction,
  type NoteExtractionInput,
  type NoteExtractor,
  patientId,
} from '@follow-up-engine/core';
import { BASE_DATE, dayToDate, loadSyntheticClinic } from '@follow-up-engine/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ClinicState,
  CrashingUnitOfWork,
  InjectedCrash,
  readClinicState,
  stageHistory,
} from '../src/clinic.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

const { patients } = loadSyntheticClinic();
const PATIENT_IDS = patients.map((patient) => patientId(patient.patientId));
const NOTE_COST_USD = 0.002;
const TIMEOUT = 300_000;

/** A note extractor that runs out of budget after `allowed` calls, until topped up. */
class BudgetedExtractor implements NoteExtractor {
  readonly #inner = new FakeNoteExtractor({ costUsd: NOTE_COST_USD });
  #remaining: number;

  constructor(allowed: number) {
    this.#remaining = allowed;
  }

  topUp(): void {
    this.#remaining = Number.POSITIVE_INFINITY;
  }

  extract(clinic: Parameters<NoteExtractor['extract']>[0], input: NoteExtractionInput) {
    if (this.#remaining <= 0) {
      return Promise.reject<NoteExtraction>(new LlmBudgetExceededError(clinic));
    }
    this.#remaining -= 1;
    return this.#inner.extract(clinic, input);
  }
}

const COUNT_KEYS = [
  'patientsScanned',
  'eventsProcessed',
  'documentsProcessed',
  'expectationsCreated',
  'expectationsFulfilled',
  'casesOpened',
] as const;

function countsOf(report: BackfillReport): Omit<BackfillCounts, 'llmCostUsd'> {
  return Object.fromEntries(COUNT_KEYS.map((key) => [key, report.progress[key]])) as Omit<
    BackfillCounts,
    'llmCostUsd'
  >;
}

function eventsOf<TType extends DomainEvent['type']>(
  events: readonly DomainEvent[],
  type: TType,
): DomainEventOf<TType>[] {
  return events.filter((event): event is DomainEventOf<TType> => event.type === type);
}

let sequence = 0;

function backfillSuite(make: (options: HarnessOptions) => Promise<EngineHarness>): void {
  async function stagedClinic(
    name: string,
    overrides: Partial<HarnessOptions> = {},
  ): Promise<EngineHarness> {
    sequence += 1;
    const harness = await make({
      clinicId: clinicId(`clinic-backfill-${name}-${String(sequence)}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor({ costUsd: NOTE_COST_USD }),
      ...overrides,
    });
    await stageHistory(harness, patients);
    return harness;
  }

  let reference: { harness: EngineHarness; report: BackfillReport; state: ClinicState };

  beforeAll(async () => {
    const harness = await stagedClinic('reference');
    const report = await harness.engine.backfill.run(harness.clinicId);
    reference = { harness, report, state: await readClinicState(harness, PATIENT_IDS) };
  }, TIMEOUT);

  it('replays all 120 patients into a plausible, prioritized recovery list', () => {
    const { report, state } = reference;
    expect(report.progress.status).toBe('completed');
    expect(report.progress.patientsScanned).toBe(120);
    expect(report.progress.documentsProcessed).toBeGreaterThan(600);
    // History closes most of what it expected; what is left are real gaps.
    expect(report.progress.expectationsFulfilled).toBeGreaterThan(
      report.progress.expectationsCreated / 2,
    );
    const casesPerPatient = new Map<string, number>();
    for (const followUpCase of state.cases) {
      casesPerPatient.set(
        followUpCase.patientId,
        (casesPerPatient.get(followUpCase.patientId) ?? 0) + 1,
      );
      expect(followUpCase.origin).toBe('backfill');
      expect(followUpCase.reasons.length).toBeLessThanOrEqual(8);
    }
    expect(state.cases.length).toBeGreaterThan(40);
    expect(state.cases.length).toBeLessThan(150);
    expect(Math.max(...casesPerPatient.values())).toBeLessThanOrEqual(3);
    expect(report.release?.scheduled).toBe(state.cases.length);
  });

  it('emits backfill.completed with counts that match the stored data', async () => {
    const { harness, report, state } = reference;
    const [completed] = eventsOf(await harness.pendingEvents(), 'backfill.completed');
    const backfillExpectations = state.expectations.filter((e) => e.origin === 'backfill');
    const notes = await harness.read(async (stores) => {
      let total = 0;
      for (const patient of PATIENT_IDS) {
        total += (
          await stores.clinicalRecords.listEventsForPatient(harness.clinicId, patient, {
            types: ['note.received'],
          })
        ).length;
      }
      return total;
    });
    expect(completed?.payload).toMatchObject({
      runId: report.progress.runId,
      shadow: false,
      ...countsOf(report),
      casesScheduled: state.cases.length,
      casesNotNotified: 0,
    });
    expect(completed?.payload.expectationsCreated).toBe(backfillExpectations.length);
    expect(completed?.payload.expectationsFulfilled).toBe(
      backfillExpectations.filter((e) => e.status === 'fulfilled').length,
    );
    expect(completed?.payload.casesOpened).toBe(state.cases.length);
    expect(completed?.payload.documentsProcessed).toBe(notes);
    expect(completed?.payload.llmCostUsd).toBeCloseTo(notes * NOTE_COST_USD, 6);
  });

  it(
    'is idempotent: running it again creates nothing and changes nothing',
    async () => {
      const { harness, state } = reference;
      const again = await harness.engine.backfill.run(harness.clinicId, { runId: 'second' });
      expect(again.progress).toMatchObject({
        status: 'completed',
        patientsScanned: 120,
        expectationsCreated: 0,
        expectationsFulfilled: 0,
        casesOpened: 0,
        llmCostUsd: 0,
      });
      expect((await readClinicState(harness, PATIENT_IDS)).fingerprint).toBe(state.fingerprint);
    },
    TIMEOUT,
  );

  it(
    'resumes after a crash midway and completes with the same totals and state',
    async () => {
      let crashing: CrashingUnitOfWork | undefined;
      const harness = await stagedClinic('crash', {
        wrapUnitOfWork: (unitOfWork) => (crashing = new CrashingUnitOfWork(unitOfWork)),
      });
      // Start + a page + ~60 patients (two transactions each), then die mid-patient.
      crashing?.arm(125);
      await expect(harness.engine.backfill.run(harness.clinicId)).rejects.toBeInstanceOf(
        InjectedCrash,
      );
      const interrupted = await harness.engine.backfill.status(harness.clinicId);
      expect(interrupted?.status).toBe('running');
      expect(interrupted?.patientsScanned).toBeGreaterThan(0);
      expect(interrupted?.patientsScanned).toBeLessThan(120);

      crashing?.disarm();
      const resumed = await harness.engine.backfill.run(harness.clinicId);
      expect(resumed.resumed).toBe(true);
      expect(countsOf(resumed)).toEqual(countsOf(reference.report));
      expect(resumed.progress.llmCostUsd).toBeCloseTo(reference.report.progress.llmCostUsd, 6);
      expect((await readClinicState(harness, PATIENT_IDS)).fingerprint).toBe(
        reference.state.fingerprint,
      );
    },
    TIMEOUT,
  );

  it(
    'pauses when the LLM budget runs out, alerts, and resumes to the same totals',
    async () => {
      const extractor = new BudgetedExtractor(250);
      const harness = await stagedClinic('budget', { extractor });
      const paused = await harness.engine.backfill.run(harness.clinicId);
      expect(paused.progress.status).toBe('paused_budget');
      expect(paused.progress.lastError).toBe('llm_budget_exceeded');
      const [alert] = eventsOf(await harness.pendingEvents(), 'backfill.paused');
      expect(alert?.payload).toMatchObject({
        runId: paused.progress.runId,
        reason: 'llm_budget_exceeded',
        patientsScanned: paused.progress.patientsScanned,
      });
      expect(paused.progress.patientsScanned).toBeLessThan(120);

      extractor.topUp();
      const resumed = await harness.engine.backfill.run(harness.clinicId);
      expect(resumed.resumed).toBe(true);
      expect(resumed.progress.status).toBe('completed');
      expect(countsOf(resumed)).toEqual(countsOf(reference.report));
      expect((await readClinicState(harness, PATIENT_IDS)).fingerprint).toBe(
        reference.state.fingerprint,
      );
    },
    TIMEOUT,
  );

  it(
    'releases daily batches within the cap per owner and never contacts patients itself',
    async () => {
      const cap = 3;
      const harness = await stagedClinic('cap', {
        settings: { dailyCaseCapPerOwner: cap, allowPatientContact: true },
      });
      const report = await harness.engine.backfill.run(harness.clinicId);
      const total = report.progress.casesOpened;
      expect(report.release?.perDay.length).toBeGreaterThan(3);
      const releasedPerDay: number[] = [];
      let visible = 0;
      for (let day = 0; day < 60; day += 1) {
        const now = dayToDate(day);
        harness.clock.set(now);
        const watcher = await harness.engine.runWatcher(harness.clinicId, now);
        await harness.engine.runEscalation(harness.clinicId, now);
        const released = await harness.read(async (stores) => {
          const cases = await Promise.all(
            watcher.casesReleased.map((id) => stores.cases.get(harness.clinicId, id)),
          );
          return cases;
        });
        const perOwner = new Map<string, number>();
        for (const followUpCase of released) {
          const owner = followUpCase?.assignee ?? '';
          perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
        }
        // Day 0 was released by the run itself.
        expect(Math.max(0, ...perOwner.values())).toBeLessThanOrEqual(cap);
        releasedPerDay.push(released.length);
        const page = await harness.read((stores) =>
          stores.cases.list(harness.clinicId, {
            origin: 'backfill',
            releasedAsOf: now,
            limit: 1000,
          }),
        );
        expect(page.items.length).toBeGreaterThanOrEqual(visible);
        visible = page.items.length;
      }
      expect(visible).toBe(total);
      expect(releasedPerDay.slice(1).some((count) => count > 0)).toBe(true);
      const backfillCases = new Set(
        (
          await harness.read((stores) =>
            stores.cases.list(harness.clinicId, { origin: 'backfill', limit: 1000 }),
          )
        ).items.map((followUpCase) => followUpCase.id),
      );
      const events = await harness.pendingEvents();
      // Live cases of the following weeks may ask for contact; backfill cases never do.
      const contacts = eventsOf(events, 'patient_contact.requested');
      expect(contacts.filter((event) => backfillCases.has(event.payload.caseId))).toEqual([]);
      expect(
        eventsOf(events, 'case.opened').filter((event) => event.payload.origin === 'backfill'),
      ).toHaveLength(total);
    },
    TIMEOUT,
  );

  it(
    'lists cases too old to notify among the patients to recover, never releasing them',
    async () => {
      const harness = await stagedClinic('age', { settings: { backfillNotifyMaxAgeDays: 120 } });
      const report = await harness.engine.backfill.run(harness.clinicId);
      const notNotified = report.release?.notNotified ?? 0;
      expect(notNotified).toBeGreaterThan(0);
      const recovery = () =>
        harness.read((stores) =>
          stores.cases.list(harness.clinicId, {
            origin: 'backfill',
            unreleasedAsOf: harness.clock.now(),
            limit: 1000,
          }),
        );
      const held = (await recovery()).items;
      expect(held).toHaveLength(notNotified);
      for (const followUpCase of held) {
        expect(followUpCase.releaseAt).toEqual(BACKFILL_UNSCHEDULED_RELEASE_AT);
        expect(followUpCase.nextActionAt).toBeUndefined();
        expect(isActiveCaseStatus(followUpCase.status)).toBe(true);
      }
      for (let day = 1; day <= 30; day += 1) {
        harness.clock.set(dayToDate(day));
        await harness.engine.runWatcher(harness.clinicId, dayToDate(day));
      }
      // Only something due now (a live reason joining the case) brings one back to the inbox.
      const stillHeld = new Set((await recovery()).items.map((followUpCase) => followUpCase.id));
      const comeBack = held.filter((followUpCase) => !stillHeld.has(followUpCase.id));
      await harness.read(async (stores) => {
        for (const followUpCase of comeBack) {
          const current = await stores.cases.get(harness.clinicId, followUpCase.id);
          const reasons = await Promise.all(
            (current?.reasons ?? []).map((reason) =>
              stores.expectations.get(harness.clinicId, reason.expectationId),
            ),
          );
          expect(reasons.some((reason) => (reason?.dueAt ?? BASE_DATE) > BASE_DATE)).toBe(true);
        }
      });
    },
    TIMEOUT,
  );

  it(
    'in shadow mode computes and stores everything but releases nothing until scheduled',
    async () => {
      const harness = await stagedClinic('shadow');
      const report = await harness.engine.backfill.run(harness.clinicId, { shadow: true });
      expect(report.progress.shadow).toBe(true);
      expect(report.release).toBeUndefined();
      expect(report.progress.casesOpened).toBe(reference.report.progress.casesOpened);
      const visible = () =>
        harness.read((stores) =>
          stores.cases.list(harness.clinicId, {
            origin: 'backfill',
            releasedAsOf: BASE_DATE,
            limit: 1000,
          }),
        );
      await harness.engine.runWatcher(harness.clinicId, BASE_DATE);
      expect((await visible()).items).toEqual([]);
      expect(eventsOf(await harness.pendingEvents(), 'case.opened')).toEqual([]);

      const plan = await harness.engine.backfill.schedule(harness.clinicId, BASE_DATE);
      expect(plan.scheduled).toBe(report.progress.casesOpened);
      const released = await harness.engine.backfill.release(harness.clinicId, BASE_DATE);
      expect(released).toHaveLength(plan.perDay[0] ?? 0);
      expect((await visible()).items.length).toBe(plan.perDay[0]);
    },
    TIMEOUT,
  );
}

describe('initial backfill of the synthetic clinic (memory)', () => {
  backfillSuite((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('initial backfill of the synthetic clinic'),
  () => {
    const database = useIsolatedDatabase();
    backfillSuite((options) => postgresHarness(database(), options));
  },
);
