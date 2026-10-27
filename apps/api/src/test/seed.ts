import type { ClinicId } from '@follow-up-engine/core';
import { type EngineRuntime, registerDemoClinic, Worker } from '@follow-up-engine/runtime';
import { BASE_DATE, loadSyntheticClinic } from '@follow-up-engine/testkit';

/*
 * Loads the synthetic demo clinic (packages/testkit, fictional patients
 * only) the way a real clinic is switched on: through the initial backfill.
 * Every patient's FHIR Bundles are imported as history (resources stored,
 * events staged, nothing annotated), then `engine.backfill.run` replays each
 * patient's two years in order, with the clock at the end of the history
 * (`BASE_DATE`). History closes most of what it expected; what is still
 * unmet becomes held cases (`origin: 'backfill'`). Finally the watcher runs,
 * which releases day 0's batch to the inbox; the rest wait among the
 * patients to recover ("Por recuperar").
 */

/** Fixed run id: seeding an already seeded database is a no-op. */
export const SEED_RUN_ID = 'seed-synthetic-clinic';

export interface SeedOptions {
  readonly apiKey: string;
  /** The inbox key (`VITE_API_KEY`): inbox and demo scopes (fake clock), never `fhir:write`. */
  readonly inboxApiKey?: string;
  /** Only the first N patients (by id). All 148 by default. */
  readonly patients?: number;
  /**
   * Only every `count`-th patient (by id) from `index`: lets several
   * runtimes seed disjoint parts of the clinic at once (`demo:record`).
   */
  readonly slice?: { readonly index: number; readonly count: number };
  /** Called every 100 staged bundles. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface SeedReport {
  readonly clinicId: ClinicId;
  /** False when the database already held the seeded clinic: nothing was replayed. */
  readonly seeded: boolean;
  readonly patients: number;
  readonly bundles: number;
  readonly eventsStaged: number;
  readonly documentsProcessed: number;
  readonly expectationsCreated: number;
  readonly expectationsFulfilled: number;
  /** Backfill cases the replay opened (held until their release day). */
  readonly casesOpened: number;
  /** Released to the inbox (day 0's batch). */
  readonly casesReleased: number;
  /** Still held: listed among the patients to recover. */
  readonly casesHeld: number;
  readonly stageMs: number;
  readonly backfillMs: number;
  readonly ms: number;
}

export async function seedSyntheticClinic(
  runtime: EngineRuntime,
  options: SeedOptions,
): Promise<SeedReport> {
  const clock = runtime.fakeClock;
  if (clock === undefined) {
    throw new Error('Seeding replays two years of history: run it with CLOCK=fake');
  }
  const started = performance.now();
  const clinic = await registerDemoClinic(runtime, options.apiKey, options.inboxApiKey);
  const synthetic = loadSyntheticClinic();
  const patients = [...synthetic.patients]
    .sort((left, right) => left.patientId.localeCompare(right.patientId))
    .slice(0, options.patients ?? synthetic.patients.length)
    .filter(
      (_, position) =>
        options.slice === undefined || position % options.slice.count === options.slice.index,
    );
  const bundles = patients.flatMap((patient) => patient.entries);
  clock.set(BASE_DATE);

  const previous = await runtime.engine.backfill.status(clinic.id, SEED_RUN_ID);
  const alreadySeeded = previous?.status === 'completed';

  let eventsStaged = 0;
  if (!alreadySeeded) {
    // The clinic directory (organization, practitioners) first, so the inbox
    // can name each case's treating practitioner.
    const earliest = bundles.reduce(
      (min, entry) => (entry.at < min ? entry.at : min),
      BASE_DATE.toISOString(),
    );
    await runtime.ingestion.stageHistory(
      clinic.id,
      {
        resourceType: 'Bundle',
        type: 'batch',
        entry: [synthetic.clinic.organization, ...synthetic.clinic.practitioners].map(
          (resource) => ({
            resource,
            request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
          }),
        ),
      },
      new Date(earliest),
    );
    for (const [index, entry] of bundles.entries()) {
      const staging = await runtime.ingestion.stageHistory(
        clinic.id,
        entry.bundle,
        new Date(entry.at),
      );
      eventsStaged += staging.staged;
      if ((index + 1) % 100 === 0) {
        options.onProgress?.(index + 1, bundles.length);
      }
    }
  }
  const staged = performance.now();

  const report = alreadySeeded
    ? undefined
    : await runtime.engine.backfill.run(clinic.id, { runId: SEED_RUN_ID });
  const progress = report?.progress ?? previous;
  const replayed = performance.now();

  // The run already released day 0's batch; the watcher sweep does it on
  // every pass (and opens whatever is due today), as the worker would.
  await new Worker(runtime).runSweeps([clinic.id]);
  const count = async (query: { releasedAsOf: Date } | { unreleasedAsOf: Date }) =>
    (
      await runtime.storage.stores.cases.list(clinic.id, {
        origin: 'backfill',
        ...query,
        limit: 1_000,
      })
    ).items.length;
  const now = clock.now();

  return {
    clinicId: clinic.id,
    seeded: !alreadySeeded,
    patients: patients.length,
    bundles: bundles.length,
    eventsStaged,
    documentsProcessed: progress?.documentsProcessed ?? 0,
    expectationsCreated: progress?.expectationsCreated ?? 0,
    expectationsFulfilled: progress?.expectationsFulfilled ?? 0,
    casesOpened: progress?.casesOpened ?? 0,
    casesReleased: await count({ releasedAsOf: now }),
    casesHeld: await count({ unreleasedAsOf: now }),
    stageMs: Math.round(staged - started),
    backfillMs: Math.round(replayed - staged),
    ms: Math.round(performance.now() - started),
  };
}
