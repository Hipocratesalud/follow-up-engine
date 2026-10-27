import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import { clinicId, type FollowUpCase } from '@follow-up-engine/core';
import { BASE_DATE, dayToDate, loadSyntheticClinic } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { stageHistory } from '../src/clinic.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

/*
 * HIP-113: the initial backfill of the whole synthetic clinic, then the
 * watcher at the activation date, as the demo seed does. Day 0 releases at
 * most `dailyCaseCapPerOwner` cases per owner (the treating practitioner,
 * else the front desk); the rest wait among the patients to recover and come
 * out on the following days, never more than the cap per owner and day.
 */

const { patients } = loadSyntheticClinic();
const TIMEOUT = 300_000;

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  }
  return counts;
}

const ownerOf = (followUpCase: FollowUpCase): string => followUpCase.assignee ?? '';

function releaseCap(make: (options: HarnessOptions) => Promise<EngineHarness>): void {
  let sequence = 0;

  async function seeded(cap?: number): Promise<EngineHarness> {
    sequence += 1;
    const harness = await make({
      clinicId: clinicId(`clinic-release-cap-${String(sequence)}-${String(Date.now())}`),
      start: BASE_DATE,
      extractor: new FakeNoteExtractor(),
      ...(cap === undefined ? {} : { settings: { dailyCaseCapPerOwner: cap } }),
    });
    await stageHistory(harness, patients);
    await harness.engine.backfill.run(harness.clinicId);
    await harness.engine.runWatcher(harness.clinicId, BASE_DATE);
    await harness.engine.runEscalation(harness.clinicId, BASE_DATE);
    return harness;
  }

  async function backfillCases(harness: EngineHarness, now: Date) {
    return harness.read(async (stores) => {
      const list = async (query: { releasedAsOf: Date } | { unreleasedAsOf: Date }) =>
        (await stores.cases.list(harness.clinicId, { origin: 'backfill', ...query, limit: 1000 }))
          .items;
      const all = (await stores.cases.list(harness.clinicId, { origin: 'backfill', limit: 1000 }))
        .items;
      return {
        all,
        released: await list({ releasedAsOf: now }),
        held: await list({ unreleasedAsOf: now }),
      };
    });
  }

  /** The cases whose reasons were all due by the activation date: released by the daily batches. */
  async function onlyScheduled(
    harness: EngineHarness,
    cases: readonly FollowUpCase[],
  ): Promise<FollowUpCase[]> {
    return harness.read(async (stores) => {
      const scheduled: FollowUpCase[] = [];
      for (const followUpCase of cases) {
        const reasons = await Promise.all(
          followUpCase.reasons.map((reason) =>
            stores.expectations.get(harness.clinicId, reason.expectationId),
          ),
        );
        if (reasons.every((reason) => reason !== undefined && reason.dueAt <= BASE_DATE)) {
          scheduled.push(followUpCase);
        }
      }
      return scheduled;
    });
  }

  it(
    'day 0 releases at most the default cap (20) per owner; the rest waits to be recovered',
    async () => {
      const harness = await seeded();
      const { all, released, held } = await backfillCases(harness, BASE_DATE);
      const owners = countBy(all, ownerOf);
      const releasedPerOwner = countBy(released, ownerOf);
      expect(released.length + held.length).toBe(all.length);
      expect(released.length).toBeLessThanOrEqual(20 * owners.size);
      for (const [owner, total] of owners) {
        // Every owner gets their 20 most urgent cases today, never more.
        expect(releasedPerOwner.get(owner) ?? 0).toBeLessThanOrEqual(Math.min(20, total));
      }
      for (const followUpCase of held) {
        expect(followUpCase.nextActionAt).toBeUndefined();
      }
    },
    TIMEOUT,
  );

  it(
    'with a smaller cap, day 0 holds back the excess and the following days release it',
    async () => {
      const cap = 5;
      const harness = await seeded(cap);
      const day0 = await backfillCases(harness, BASE_DATE);
      const owners = countBy(day0.all, ownerOf);
      const perOwnerDay0 = countBy(day0.released, ownerOf);
      expect(Math.max(...perOwnerDay0.values())).toBe(cap);
      expect(day0.released.length).toBeLessThanOrEqual(cap * owners.size);
      expect(day0.held.length).toBeGreaterThan(0);
      let previous = day0.released;
      for (let day = 1; day <= 30; day += 1) {
        const now = dayToDate(day);
        harness.clock.set(now);
        await harness.engine.runWatcher(harness.clinicId, now);
        const { released } = await backfillCases(harness, now);
        const before = new Set(previous.map((followUpCase) => followUpCase.id));
        const today = released.filter((followUpCase) => !before.has(followUpCase.id));
        // A held case that a reason falling due today joins is released at once, outside
        // the batches (it is actionable now); the daily batches stay within the cap.
        const batch = await onlyScheduled(harness, today);
        expect(Math.max(0, ...countBy(batch, ownerOf).values())).toBeLessThanOrEqual(cap);
        previous = released;
      }
      const end = await backfillCases(harness, dayToDate(30));
      // Everything recent enough to notify is out by now; only too-old cases stay to recover.
      for (const followUpCase of end.held) {
        expect(followUpCase.releaseAt?.getUTCFullYear()).toBe(9999);
      }
      expect(end.released.length).toBeGreaterThan(day0.released.length);
    },
    TIMEOUT,
  );
}

describe('backfill release cap per owner, HIP-113 (memory)', () => {
  releaseCap((options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('backfill release cap per owner, HIP-113'), () => {
  const database = useIsolatedDatabase();
  releaseCap((options) => postgresHarness(database(), options));
});
