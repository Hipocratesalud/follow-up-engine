import {
  type Clinic,
  type ClinicId,
  type Clock,
  FakeClock,
  type FollowUpEngine,
} from '@follow-up-engine/core';
import { IngestionService } from './ingestion.ts';
import { ensureLabClinic as ensureLabClinicRecord, type EngineRuntime } from './runtime.ts';

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

/**
 * Ensures the evaluator's lab clinic (idempotent) and its own clock,
 * started at the shared runtime clock's current date the first time this
 * evaluator is seen (the lab's own "today").
 */
export async function ensureLabClinicAndClock(
  runtime: EngineRuntime,
  clocks: LabClockRegistry,
  evaluatorEmail: string,
): Promise<{ readonly clinic: Clinic; readonly clock: FakeClock }> {
  const clinic = await ensureLabClinicRecord(runtime, evaluatorEmail);
  const clock = clocks.ensure(clinic.id, runtime.clock.now());
  return { clinic, clock };
}

/** A fresh {@link IngestionService} bound to a lab clinic's own clock (never the shared one). */
export function labIngestion(runtime: EngineRuntime, clock: Clock): IngestionService {
  return new IngestionService({ storage: runtime.storage, engine: runtime.engine, clock });
}

/** One watcher + escalation pass's effect on a lab clinic, for one simulated day. */
interface DayImpact {
  readonly expectationsExpired: number;
  readonly casesOpened: number;
  readonly casesEscalated: number;
}

/** One watcher + escalation pass for a lab clinic at a given simulated instant. */
async function sweepLabClinic(
  engine: FollowUpEngine,
  clinicId: ClinicId,
  now: Date,
): Promise<DayImpact> {
  const watcherReport = await engine.runWatcher(clinicId, now);
  const escalationReport = await engine.runEscalation(clinicId, now);
  return {
    expectationsExpired: watcherReport.expired,
    casesOpened: watcherReport.casesOpened.length,
    casesEscalated: new Set(
      escalationReport.steps
        .filter((step) => step.action === 'escalate_to_coordinator')
        .map((step) => step.caseId),
    ).size,
  };
}

export interface LabClockAdvance {
  readonly from: Date;
  readonly to: Date;
  /** Summed over every simulated day crossed, "the impact on a date" (docs/deploy.md#hosted-demo). */
  readonly expectationsExpired: number;
  readonly casesOpened: number;
  readonly casesEscalated: number;
}

/** A lab clinic's date was asked to move to the past. */
export class InvalidLabDateError extends Error {
  override readonly name = 'InvalidLabDateError';
  constructor() {
    super('A lab clinic date can only move forward');
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Moves a lab clinic's own clock forward to `target`, one simulated day at
 * a time (so cases open and escalate on the day they are due, not all at
 * once at the end — the same reasoning as the shared clock's
 * `Worker.advanceFakeClock`, scoped to one clinic and one clock). Already
 * at or past `target`: a no-op. Throws {@link InvalidLabDateError} for a
 * `target` before the clinic's current date.
 */
export async function setLabClinicDate(
  runtime: EngineRuntime,
  clock: FakeClock,
  clinicId: ClinicId,
  target: Date,
): Promise<LabClockAdvance> {
  const from = clock.now();
  const targetMs = target.getTime();
  if (targetMs < from.getTime()) {
    throw new InvalidLabDateError();
  }
  let cursor = from.getTime();
  let expectationsExpired = 0;
  let casesOpened = 0;
  let casesEscalated = 0;
  while (cursor < targetMs) {
    cursor = Math.min(cursor + ONE_DAY_MS, targetMs);
    const stepDate = new Date(cursor);
    clock.set(stepDate);
    const impact = await sweepLabClinic(runtime.engine, clinicId, stepDate);
    expectationsExpired += impact.expectationsExpired;
    casesOpened += impact.casesOpened;
    casesEscalated += impact.casesEscalated;
  }
  return { from, to: clock.now(), expectationsExpired, casesOpened, casesEscalated };
}
