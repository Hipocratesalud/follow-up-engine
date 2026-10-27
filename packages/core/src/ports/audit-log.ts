import type { CaseEvent } from '../domain/case.ts';
import type { CaseId, ClinicId } from '../domain/ids.ts';

/** Append-only audit trail of cases. Entries are never updated or deleted. */
export interface AuditLog {
  append(clinicId: ClinicId, event: CaseEvent): Promise<void>;

  /** Chronological. */
  listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseEvent[]>;
}
