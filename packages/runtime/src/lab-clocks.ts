import { type ClinicId, FakeClock } from '@follow-up-engine/core';

/**
 * The evaluator lab's per-evaluator clock (docs/deploy.md#hosted-demo),
 * layered on top of {@link ensureLabClinicRecord} (`runtime.ts`), which
 * registers the sandbox clinic itself and keeps `activeClinicIds()` from
 * ever sweeping it on the shared clock's schedule. What is still missing
 * there is the clinic's *own* movable clock: this module adds it.
 *
 * **Design.** `Clock` stays the pure `now(): Date` port everywhere else in
 * core — nothing here makes it clinic-aware. Instead every lab clinic gets
 * its own {@link FakeClock} instance, kept in {@link LabClockRegistry} here
 * in the composition root. "See the impact on a date" moves *that* clock
 * only, one simulated day at a time, running `FollowUpEngine.runWatcher`/
 * `.runEscalation` directly for that one clinic with the clock's `now()`
 * (both already take an explicit `now: Date`, exactly like `Worker`'s own
 * sweep) — never through the shared worker or the shared
 * `POST /api/demo/clock/advance`. Document and record ingestion for a lab
 * patient uses a dedicated {@link IngestionService} bound to the same
 * clock, so `receivedAt` and "today" agree.
 *
 * In-memory, one process: the hosted demo already assumes a single replica
 * for its shared fake clock, so a restart resetting every lab clinic back
 * to "today" is consistent with that, and harmless for a disposable
 * sandbox.
 */
export class LabClockRegistry {
  readonly #clocks = new Map<ClinicId, FakeClock>();

  /** The clinic's clock, created at `defaultStart` the first time it is asked for. */
  ensure(clinicId: ClinicId, defaultStart: Date): FakeClock {
    let clock = this.#clocks.get(clinicId);
    if (clock === undefined) {
      clock = new FakeClock(defaultStart);
      this.#clocks.set(clinicId, clock);
    }
    return clock;
  }

  get(clinicId: ClinicId): FakeClock | undefined {
    return this.#clocks.get(clinicId);
  }
}
