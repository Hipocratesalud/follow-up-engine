import type { ClinicId, PatientId } from '../domain/ids.ts';
import type {
  ReconciliationCounts,
  ReconciliationRepair,
  ReconciliationRun,
  ReconciliationScope,
} from '../domain/reconciliation.ts';

/**
 * Runs of the nightly reconciliation and the repairs they made. Part of
 * `TransactionalStores`: a patient's repairs, their audit entries and the
 * run's cursor commit together, so a crashed run resumes after the last
 * patient it finished and never repairs one twice.
 */
export interface ReconciliationStore {
  /** `ConflictError` when the clinic has an unfinished run, or the run id exists. */
  start(
    clinicId: ClinicId,
    runId: string,
    options: {
      readonly scope: ReconciliationScope;
      readonly since?: string;
      readonly watermark?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun>;

  get(clinicId: ClinicId, runId: string): Promise<ReconciliationRun | undefined>;

  /** The clinic's unfinished (`running`) run: at most one. */
  findRunning(clinicId: ClinicId): Promise<ReconciliationRun | undefined>;

  /** The most recently started completed run. */
  lastCompleted(clinicId: ClinicId): Promise<ReconciliationRun | undefined>;

  /** Runs, most recently started first. */
  list(
    clinicId: ClinicId,
    query: { readonly limit: number },
  ): Promise<readonly ReconciliationRun[]>;

  /** Moves the cursor past a patient and adds to the counters. `NotFoundError` unless running. */
  advance(
    clinicId: ClinicId,
    runId: string,
    step: {
      readonly cursor: PatientId;
      readonly delta: ReconciliationCounts;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun>;

  /** `NotFoundError` unless running. */
  finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun>;

  /** Appends audited repairs (never updated or deleted). */
  recordRepairs(clinicId: ClinicId, repairs: readonly ReconciliationRepair[]): Promise<void>;

  /** Repairs in the order they were made (only a run's, or a patient's, when given). */
  listRepairs(
    clinicId: ClinicId,
    query: { readonly runId?: string; readonly patientId?: PatientId; readonly limit: number },
  ): Promise<readonly ReconciliationRepair[]>;
}
