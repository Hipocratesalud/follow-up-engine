import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type ClinicalEvent, type Expectation, patientId } from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import { BASE_DATE, dayToDate } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import {
  appointmentResource,
  conditionResource,
  encounterResource,
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
 * HIP-135, QA round 3 clinical #2 (seed patients pat-0020, pat-0016): a
 * diabetic seen on day -500 books the next control for day -400 and keeps
 * it; ten minutes after that visit the next booking (for day -300) is made,
 * and later cancelled or never kept. The visit of day -400 is the last one:
 * the protocol visit is unmet since day -220, live or replayed by the
 * backfill. Before, a protocol visit counted from the kept booking was
 * fulfilled by the very visit that kept it, so nothing reopened when the
 * next booking fell through; and a booking made in the consultation's own
 * Bundle anchored the next visit on itself.
 */

const FIRST_VISIT = -500;
const LAST_VISIT = -400;
const BOOKED_FOR = -300;
const CANCELLED_ON = -303;
/** Moves the history so the last visit is day -185 and the next booking, for day 3, is still ahead. */
const PENDING_SHIFT = 215;
/** How the last booking ended; `cancelled-unversioned` is the seed fixtures' form (no `meta`). */
const OUTCOMES = ['cancelled', 'cancelled-unversioned', 'never-kept'] as const;
type Outcome = (typeof OUTCOMES)[number] | 'pending';

const atDay = (day: number, minutes = 0): Date =>
  new Date(dayToDate(day).getTime() + minutes * 60_000);

/** The patient's history, one host Bundle per moment, oldest first, as `[instant, bundle]`. */
function history(
  patient: string,
  outcome: Outcome,
  nextFor = BOOKED_FOR,
  shift = 0,
): [Date, unknown][] {
  const at = (day: number, minutes = 0): Date => atDay(day + shift, minutes);
  const visit = (n: number, day: number): unknown =>
    transactionOf(
      encounterResource({
        id: `${patient}-enc${String(n)}`,
        patientId: patient,
        specialty: 'diabetology',
        at: at(day),
      }),
      conditionResource({
        id: `${patient}-dm2-${String(n)}`,
        patientId: patient,
        icd10: 'E11',
        verification: 'confirmed',
        at: at(day),
      }),
    );
  const booking = (
    n: number,
    input: {
      status: 'booked' | 'cancelled';
      bookedOn: number;
      start: number;
      on: Date;
      version: number;
    },
  ): unknown => {
    const resource = appointmentResource({
      id: `${patient}-appt${String(n)}`,
      patientId: patient,
      specialty: 'diabetology',
      start: at(input.start),
      bookedAt: at(input.bookedOn, 10),
      status: input.status,
      version: input.version,
      at: input.on,
    });
    if (outcome !== 'cancelled-unversioned') return transactionOf(resource);
    // The seed fixtures send Appointments without `meta` (no versionId, no lastUpdated).
    return transactionOf(
      Object.fromEntries(
        Object.entries(resource).filter(([field]) => field !== 'meta'),
      ) as typeof resource,
    );
  };
  const next = { bookedOn: LAST_VISIT, start: nextFor };
  return [
    [at(FIRST_VISIT), visit(1, FIRST_VISIT)],
    [
      at(FIRST_VISIT, 10),
      booking(1, {
        status: 'booked',
        bookedOn: FIRST_VISIT,
        start: LAST_VISIT,
        on: at(FIRST_VISIT, 10),
        version: 1,
      }),
    ],
    [at(LAST_VISIT, 30), visit(2, LAST_VISIT)],
    [
      at(LAST_VISIT, 40),
      booking(2, { status: 'booked', ...next, on: at(LAST_VISIT, 40), version: 1 }),
    ],
    ...(outcome === 'cancelled' || outcome === 'cancelled-unversioned'
      ? ([
          [
            at(CANCELLED_ON),
            booking(2, { status: 'cancelled', ...next, on: at(CANCELLED_ON), version: 2 }),
          ],
        ] as [Date, unknown][])
      : []),
  ];
}

async function visitExpectations(harness: EngineHarness, patient: string) {
  const { expectations } = await snapshotPatient(harness, patientId(patient));
  return expectations
    .filter((expectation: Expectation) => expectation.ruleId === 'protocol_diabetes_visit')
    .map((expectation) => ({
      status: expectation.status,
      dueAt: expectation.dueAt.toISOString().slice(0, 10),
      source: `${expectation.source.resourceType}/${expectation.source.id}`,
    }))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

function suite(make: (options: HarnessOptions) => Promise<EngineHarness>) {
  let sequence = 0;
  const harnessFor = (name: string) => {
    sequence += 1;
    return make({
      clinicId: clinicId(`clinic-bf-bookings-${name}-${String(sequence)}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
    });
  };
  const due = (day: number) => dayToDate(day).toISOString().slice(0, 10);

  async function backfilled(name: string, outcome: Outcome, nextFor = BOOKED_FOR, shift = 0) {
    const harness = await harnessFor(name);
    const patient = `p-${name}`;
    const events: ClinicalEvent[] = [];
    for (const [instant, bundle] of history(patient, outcome, nextFor, shift)) {
      events.push(
        ...mapBundleToBatches(bundle, {
          clinicId: harness.clinicId,
          receivedAt: instant,
        }).batches.flatMap((batch) => batch.events),
      );
    }
    await harness.engine.backfill.stage({
      clinicId: harness.clinicId,
      patientId: patientId(patient),
      receivedAt: dayToDate(0),
      events,
    });
    await harness.engine.backfill.run(harness.clinicId);
    return { harness, patient };
  }

  async function live(name: string, outcome: Outcome, nextFor = BOOKED_FOR, shift = 0) {
    const harness = await harnessFor(name);
    const patient = `p-${name}`;
    for (const [instant, bundle] of history(patient, outcome, nextFor, shift)) {
      harness.clock.set(instant);
      await ingestBundle(harness, bundle, instant);
      await harness.engine.runWatcher(harness.clinicId, instant);
    }
    harness.clock.set(dayToDate(0));
    await harness.engine.runWatcher(harness.clinicId, dayToDate(0));
    return { harness, patient };
  }

  it.each(OUTCOMES)(
    'a booking that was %s neither fulfills nor moves the visit due 180 days after the last one',
    async (outcome) => {
      const fromBackfill = await backfilled(`bf-${outcome}`, outcome);
      const fromLive = await live(`live-${outcome}`, outcome);
      const unmet = {
        status: 'expired',
        dueAt: due(LAST_VISIT + 180),
        source: `Encounter/p-bf-${outcome}-enc2`,
      };
      expect(await visitExpectations(fromBackfill.harness, fromBackfill.patient)).toContainEqual(
        unmet,
      );
      expect(
        (await visitExpectations(fromBackfill.harness, fromBackfill.patient)).filter(
          (expectation) =>
            expectation.status === 'fulfilled' && expectation.dueAt > due(FIRST_VISIT + 180),
        ),
      ).toEqual([]);
      // The same history sent live (control).
      expect(await visitExpectations(fromLive.harness, fromLive.patient)).toContainEqual({
        ...unmet,
        source: `Encounter/p-live-${outcome}-enc2`,
      });
    },
  );

  it('a booking still pending (made in time, for after today) fulfills the visit: no visit case', async () => {
    // pat-0044: the next control is booked for tomorrow, 8 days after the
    // protocol visit was due but within its tolerance.
    for (const run of [
      await backfilled('bf-pending', 'pending', LAST_VISIT + 188, PENDING_SHIFT),
      await live('live-pending', 'pending', LAST_VISIT + 188, PENDING_SHIFT),
    ]) {
      const { harness, patient } = run;
      expect(await visitExpectations(harness, patient)).toEqual([
        {
          status: 'fulfilled',
          dueAt: due(FIRST_VISIT + 180 + PENDING_SHIFT),
          source: `Encounter/${patient}-enc1`,
        },
        {
          status: 'fulfilled',
          dueAt: due(LAST_VISIT + 180 + PENDING_SHIFT),
          source: `Encounter/${patient}-enc2`,
        },
      ]);
      const { cases } = await snapshotPatient(harness, patientId(patient));
      expect(cases.flatMap((c) => c.ruleIds)).not.toContain('protocol_diabetes_visit');
    }
  });
}

const TIMEOUT_MS = 30_000;

describe('backfill bookings (memory)', { timeout: TIMEOUT_MS }, () => {
  suite((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(
  postgresTitle('backfill bookings'),
  { timeout: TIMEOUT_MS },
  () => {
    const database = useIsolatedDatabase();
    suite((options) => postgresHarness(database(), options));
  },
);
