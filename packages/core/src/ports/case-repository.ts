import type { CaseStatus, FollowUpCase } from '../domain/case.ts';
import type { Origin } from '../domain/common.ts';
import type { CaseId, ClinicId, PatientId } from '../domain/ids.ts';

/** Inbox query. All filters are optional and combined with AND. */
export interface CaseListQuery {
  readonly statuses?: readonly CaseStatus[];
  readonly patientId?: PatientId;
  readonly assignee?: string;
  readonly origin?: Origin;
  /** Only cases already released to the inbox (`releaseAt` absent or `<= releasedAsOf`). */
  readonly releasedAsOf?: Date;
  /**
   * Only cases not released yet (`releaseAt > unreleasedAsOf`): the backfill's
   * "patients to recover".
   */
  readonly unreleasedAsOf?: Date;
  /** Default `priority` (descending, then `createdAt` ascending). */
  readonly orderBy?: 'priority' | 'created_at' | 'next_action_at';
  readonly limit: number;
  /** Opaque cursor from a previous page. */
  readonly cursor?: string;
}

export interface CasePage {
  readonly items: readonly FollowUpCase[];
  readonly nextCursor?: string;
}

export interface CaseReadOptions {
  /**
   * Read to write: the case is locked until the transaction ends (Postgres
   * `SELECT ... FOR UPDATE`), so a concurrent command on the same case waits
   * and then sees this one's outcome instead of overwriting it. Transactions
   * of the memory adapter are serialized, which is equivalent.
   */
  readonly forUpdate?: boolean;
}

/** Persists cases. Adapters throw `TenantMismatchError` if `value.clinicId !== clinicId`. */
export interface CaseRepository {
  get(clinicId: ClinicId, id: CaseId, options?: CaseReadOptions): Promise<FollowUpCase | undefined>;

  /** The active (`ACTIVE_CASE_STATUSES`) case for a dedup key, if any. */
  findActiveByDedupKey(
    clinicId: ClinicId,
    dedupKey: string,
    options?: CaseReadOptions,
  ): Promise<FollowUpCase | undefined>;

  /** Throws `ConflictError` if an active case with the same `dedupKey` exists. */
  create(clinicId: ClinicId, value: FollowUpCase): Promise<void>;

  /** Replaces a stored case. Throws `NotFoundError` if it does not exist. */
  update(clinicId: ClinicId, value: FollowUpCase): Promise<void>;

  /**
   * Sets the priority of an active case, and nothing else (no `updatedAt`):
   * the derived priority is recomputed on every watcher tick without
   * overwriting what a concurrent command changed. `false` when the case is
   * missing or no longer active.
   */
  setPriority(clinicId: ClinicId, id: CaseId, priority: number): Promise<boolean>;

  list(clinicId: ClinicId, query: CaseListQuery): Promise<CasePage>;

  /**
   * Active cases the worker must act on: `nextActionAt <= now`, or snoozed
   * with `snoozedUntil <= now`. By that instant ascending. Locked for the
   * rest of the transaction; a case another transaction is changing right
   * now is skipped (Postgres `FOR UPDATE SKIP LOCKED`): the next sweep takes it.
   */
  findDueForAction(clinicId: ClinicId, now: Date, limit: number): Promise<readonly FollowUpCase[]>;
}
