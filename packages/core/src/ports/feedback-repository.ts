import type { CaseFeedback } from '../domain/case.ts';
import type { CaseId, ClinicId } from '../domain/ids.ts';

/** Append-only store of clinician feedback on cases. */
export interface FeedbackRepository {
  /** Throws `ConflictError` if the id already exists. */
  record(clinicId: ClinicId, feedback: CaseFeedback): Promise<void>;

  /** Oldest first; feedback recorded on the same instant keeps recording order (the last one is the latest verdict). */
  listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseFeedback[]>;

  /** Feedback created at or after `since`, oldest first (evals, rule tuning). */
  listSince(clinicId: ClinicId, since: Date, limit: number): Promise<readonly CaseFeedback[]>;
}
