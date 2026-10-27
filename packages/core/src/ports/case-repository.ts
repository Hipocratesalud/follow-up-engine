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
  /** Opaque cursor from a previous page of the same query; anything else throws `InvalidCursorError`. */
  readonly cursor?: string;
}

export interface CasePage {
  readonly items: readonly FollowUpCase[];
  readonly nextCursor?: string;
}

/**
 * The filters of a {@link CaseListQuery}, for the patient queue: they select
 * cases, which are then grouped by patient. `patientIds` narrows to a set of
 * patients (a name search; empty selects nobody).
 */
export interface CaseFilter extends Omit<
  CaseListQuery,
  'patientId' | 'orderBy' | 'limit' | 'cursor'
> {
  readonly patientIds?: readonly PatientId[];
}

/**
 * The patient queue (HIP-141): one item per patient with every matching
 * case. The engine keeps one case per patient and reason group (escalation,
 * deduplication and audit stay per reason); the clinic works one card per
 * patient.
 */
export interface PatientQueueQuery extends CaseFilter {
  /**
   * `priority` (default): the patient whose most urgent case ranks highest
   * first, then the patient whose oldest case is oldest, then the patient
   * id. `created_at`: the patient whose oldest case is oldest first.
   */
  readonly orderBy?: 'priority' | 'created_at';
  /** Patients per page. */
  readonly limit: number;
  /** Opaque cursor from a previous page of the same query; anything else throws `InvalidCursorError`. */
  readonly cursor?: string;
}

/** One patient of the queue and their matching cases, most urgent first (priority, then oldest). */
export interface PatientCases {
  readonly patientId: PatientId;
  readonly cases: readonly FollowUpCase[];
}

export interface PatientCasePage {
  readonly items: readonly PatientCases[];
  readonly nextCursor?: string;
}

/** How many cases match a filter, and how many patients they belong to. */
export interface CaseCount {
  readonly patients: number;
  readonly cases: number;
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
   * The matching cases grouped by patient, a page of patients at a time
   * (keyset pagination in Postgres, so a page never splits a patient).
   */
  listPatients(clinicId: ClinicId, query: PatientQueueQuery): Promise<PatientCasePage>;

  /** The number of matching cases and of distinct patients among them. */
  count(clinicId: ClinicId, filter: CaseFilter): Promise<CaseCount>;

  /**
   * Active cases the worker must act on: `nextActionAt <= now`, or snoozed
   * with `snoozedUntil <= now`. By that instant ascending. Locked for the
   * rest of the transaction; a case another transaction is changing right
   * now is skipped (Postgres `FOR UPDATE SKIP LOCKED`): the next sweep takes it.
   */
  findDueForAction(clinicId: ClinicId, now: Date, limit: number): Promise<readonly FollowUpCase[]>;
}
