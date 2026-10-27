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

/** Persists cases. Adapters throw `TenantMismatchError` if `value.clinicId !== clinicId`. */
export interface CaseRepository {
  get(clinicId: ClinicId, id: CaseId): Promise<FollowUpCase | undefined>;

  /** The active (`ACTIVE_CASE_STATUSES`) case for a dedup key, if any. */
  findActiveByDedupKey(clinicId: ClinicId, dedupKey: string): Promise<FollowUpCase | undefined>;

  /** Throws `ConflictError` if an active case with the same `dedupKey` exists. */
  create(clinicId: ClinicId, value: FollowUpCase): Promise<void>;

  /** Replaces a stored case. Throws `NotFoundError` if it does not exist. */
  update(clinicId: ClinicId, value: FollowUpCase): Promise<void>;

  list(clinicId: ClinicId, query: CaseListQuery): Promise<CasePage>;

  /**
   * Active cases the worker must act on: `nextActionAt <= now`, or snoozed
   * with `snoozedUntil <= now`. By that instant ascending.
   */
  findDueForAction(clinicId: ClinicId, now: Date, limit: number): Promise<readonly FollowUpCase[]>;
}
