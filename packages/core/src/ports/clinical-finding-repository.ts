import type {
  ClinicalFinding,
  ClinicalReviewRun,
  FindingCategory,
  FindingFlag,
  FindingInboxRelease,
  FindingMode,
  FindingReview,
  FindingSeverity,
  FindingStatus,
  FindingTexts,
} from '../domain/clinical-finding.ts';
import type { ClinicId, PatientId } from '../domain/ids.ts';

export interface FindingListQuery {
  readonly mode?: FindingMode;
  readonly statuses?: readonly FindingStatus[];
  readonly categories?: readonly FindingCategory[];
  readonly severities?: readonly FindingSeverity[];
  readonly patientId?: PatientId;
  /** Only findings released to the inbox at or after this instant (the daily cap's count). */
  readonly releasedSince?: Date;
  /** Newest first. */
  readonly limit: number;
  /** Opaque cursor from a previous page of the same query; anything else throws `InvalidCursorError`. */
  readonly cursor?: string;
}

export interface FindingPage {
  readonly items: readonly ClinicalFinding[];
  readonly nextCursor?: string;
}

/** Counts of the findings matching a query (the batch review header). */
export interface FindingCounts {
  readonly total: number;
  readonly byStatus: Readonly<Partial<Record<FindingStatus, number>>>;
  readonly byCategory: Readonly<Partial<Record<FindingCategory, number>>>;
  readonly bySeverity: Readonly<Partial<Record<FindingSeverity, number>>>;
  /** Per category, per status: the precision of each category in the shadow review. */
  readonly byCategoryStatus: Readonly<
    Partial<Record<FindingCategory, Readonly<Partial<Record<FindingStatus, number>>>>>
  >;
}

/** Clinical reviewer findings (`clinical_findings`). Adapters throw `TenantMismatchError` on a foreign `clinicId`. */
export interface ClinicalFindingRepository {
  /** Inserts a new finding. Throws `ConflictError` on an existing id. */
  create(clinicId: ClinicId, finding: ClinicalFinding): Promise<void>;

  get(clinicId: ClinicId, id: string): Promise<ClinicalFinding | undefined>;

  /** Records the clinician's verdict (the status becomes the verdict). Throws `NotFoundError`. */
  review(clinicId: ClinicId, id: string, review: FindingReview): Promise<ClinicalFinding>;

  /** Replaces the finding's words per locale (a translation arrived). Throws `NotFoundError`. */
  setTexts(clinicId: ClinicId, id: string, texts: FindingTexts): Promise<ClinicalFinding>;

  /** Marks the finding released to the doctor's inbox. Throws `NotFoundError`. */
  release(clinicId: ClinicId, id: string, release: FindingInboxRelease): Promise<void>;

  /**
   * Findings of a patient with this dedup key that are still open, or were
   * created or reviewed at or after `since` (the 90-day window).
   */
  findDuplicates(
    clinicId: ClinicId,
    patientId: PatientId,
    dedupKey: string,
    since: Date,
  ): Promise<readonly ClinicalFinding[]>;

  /** Newest first (`createdAt` descending, then id). */
  list(clinicId: ClinicId, query: FindingListQuery): Promise<FindingPage>;

  /** Counts over `mode` (all findings when absent), ignoring paging. */
  counts(
    clinicId: ClinicId,
    query: Pick<FindingListQuery, 'mode' | 'patientId'>,
  ): Promise<FindingCounts>;
}

/** Aggregates over review runs (cost and noise metrics of the PRD). */
export interface ReviewRunStats {
  readonly runs: number;
  readonly patientsReviewed: number;
  readonly findings: number;
  readonly discarded: number;
  readonly duplicates: number;
  readonly degraded: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly costUsd: number;
}

/** Review runs (`clinical_review_runs`). */
export interface ClinicalReviewRunRepository {
  /** Inserts a run. Throws `ConflictError` on an existing id. */
  record(clinicId: ClinicId, run: ClinicalReviewRun): Promise<void>;

  get(clinicId: ClinicId, id: string): Promise<ClinicalReviewRun | undefined>;

  /** When the patient was last reviewed (any status but `failed`), if ever. */
  lastReviewedAt(clinicId: ClinicId, patientId: PatientId): Promise<Date | undefined>;

  /** Totals of the runs started at or after `since`. */
  stats(clinicId: ClinicId, since: Date): Promise<ReviewRunStats>;
}

/** Finding category flags per clinic and specialty (`finding_flags`). */
export interface FindingFlagRepository {
  /** Every flag of the clinic (clinic-wide ones have no `specialty`). */
  list(clinicId: ClinicId): Promise<readonly FindingFlag[]>;

  /** Inserts or replaces the flag keyed by clinic, category and specialty. */
  upsert(clinicId: ClinicId, flag: FindingFlag): Promise<void>;
}
