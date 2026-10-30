import type { Clinic, ClinicId, Clock, FakeClock, FollowUpEngine } from '@follow-up-engine/core';
import type { LabClockRegistry } from './lab-clocks.ts';
import { IngestionService } from './ingestion.ts';
import { ensureLabClinic as ensureLabClinicRecord, type EngineRuntime } from './runtime.ts';

export { LabClockRegistry } from './lab-clocks.ts';

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
  // The order agent's no-response ladder runs on this clinic's clock too, day by day.
  await runtime.orderAgent.scheduleLadder(clinicId, from, clock.now());
  return { from, to: clock.now(), expectationsExpired, casesOpened, casesEscalated };
}
