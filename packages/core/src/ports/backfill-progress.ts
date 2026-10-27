import type { BackfillCounts } from '../domain/backfill.ts';
import type { ClinicId, PatientId } from '../domain/ids.ts';

/**
 * Lifecycle of an initial backfill run:
 * - `running`: patients are being replayed (or the worker crashed and the run waits to resume);
 * - `paused_budget`: the clinic's LLM budget ran out; resumes from the cursor once there is budget;
 * - `completed`, `failed`: terminal.
 */
export const BACKFILL_STATUSES = ['running', 'paused_budget', 'completed', 'failed'] as const;
export type BackfillStatus = (typeof BACKFILL_STATUSES)[number];

/** Statuses of a run that is not finished: at most one per clinic. */
export const UNFINISHED_BACKFILL_STATUSES = [
  'running',
  'paused_budget',
] as const satisfies readonly BackfillStatus[];

/** The stored state of one backfill run. */
export interface BackfillProgress extends BackfillCounts {
  readonly clinicId: ClinicId;
  readonly runId: string;
  readonly status: BackfillStatus;
  /** Shadow run: everything is computed and stored, nothing is released to the inbox. */
  readonly shadow: boolean;
  /** Last patient fully processed; pass as `after` to `listPatientIds`. */
  readonly cursor?: PatientId;
  /** Why the run failed or paused. */
  readonly lastError?: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt?: Date;
}

/**
 * Progress of the initial backfill, so a crashed or redeployed worker resumes
 * from the last processed patient instead of starting over. Part of
 * `TransactionalStores`: `advance` runs in the same transaction as the
 * patient's writes, so progress and its effects commit together.
 */
export interface BackfillProgressStore {
  /**
   * Starts a run in `running`. Throws `ConflictError` if the clinic already
   * has an unfinished run or the run id exists.
   */
  start(
    clinicId: ClinicId,
    runId: string,
    options: { readonly now: Date; readonly shadow?: boolean },
  ): Promise<BackfillProgress>;

  get(clinicId: ClinicId, runId: string): Promise<BackfillProgress | undefined>;

  /** The clinic's unfinished run (`running` or `paused_budget`), if any, to resume it. */
  findRunning(clinicId: ClinicId): Promise<BackfillProgress | undefined>;

  /**
   * Moves the cursor past a processed patient and adds `delta` to the
   * counters. Throws `NotFoundError` unless the run is `running`.
   */
  advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: BackfillCounts; readonly now: Date },
  ): Promise<BackfillProgress>;

  /** `running` → `paused_budget`. Throws `NotFoundError` unless the run is `running`. */
  pause(
    clinicId: ClinicId,
    runId: string,
    step: { readonly reason: string; readonly now: Date },
  ): Promise<BackfillProgress>;

  /** `paused_budget` or `running` → `running`. Throws `NotFoundError` if the run is finished or unknown. */
  resume(clinicId: ClinicId, runId: string, now: Date): Promise<BackfillProgress>;

  /** Marks an unfinished run `completed` or `failed`. Throws `NotFoundError` unless it is unfinished. */
  finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<BackfillProgress>;
}
