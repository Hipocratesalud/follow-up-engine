import type { CaseEventActor } from './case.ts';
import type { ClinicId, PatientId } from './ids.ts';

/**
 * The nightly reconciliation sweep: a safety net for events whose effect was
 * lost (a crashed consumer, an import that skipped the annotator, a bug since
 * fixed). Each patient's stored record is replayed through the same
 * annotator as live ingestion, the outcome is compared with what is stored,
 * and only the differences are repaired, each one audited.
 */

/** Who every reconciliation repair is attributed to in the audit trail. */
export const RECONCILIATION_ACTOR: CaseEventActor = { type: 'system', id: 'reconciliation' };

/** The `reason` of every audit entry a reconciliation repair writes. */
export const RECONCILIATION_REASON = 'reconciliation';

/**
 * What a repair changed:
 * - `expectation_created`: the record asks for it and it did not exist (its event was never annotated);
 * - `expectation_fulfilled` / `_superseded` / `_cancelled`: the record closes it and it was still open;
 * - `expectation_reopened`: what closed it no longer stands in the record;
 * - `expectation_unlinked`: grouped into a case that no longer exists, open again for a new case;
 * - `condition_recorded`: the record establishes a condition the patient did not have;
 * - `case_opened`: a repaired expectation was already overdue and opened (or joined) a case;
 * - `case_resolved`: every reason of an active case is closed.
 */
export const RECONCILIATION_REPAIR_KINDS = [
  'expectation_created',
  'expectation_fulfilled',
  'expectation_superseded',
  'expectation_cancelled',
  'expectation_reopened',
  'expectation_unlinked',
  'condition_recorded',
  'case_opened',
  'case_resolved',
] as const;
export type ReconciliationRepairKind = (typeof RECONCILIATION_REPAIR_KINDS)[number];

/** Counts of repairs by kind; kinds with none are absent. */
export type RepairCounts = Readonly<Partial<Record<ReconciliationRepairKind, number>>>;

/** One audited repair (append-only). Ids and codes only: never a diagnosis or free text. */
export interface ReconciliationRepair {
  readonly clinicId: ClinicId;
  readonly runId: string;
  readonly patientId: PatientId;
  readonly kind: ReconciliationRepairKind;
  /** The expectation, case or condition repaired (`<system>|<code>` for a condition). */
  readonly entityId: string;
  readonly ruleId?: string;
  /** Status before and after (expectations and cases). */
  readonly from?: string;
  readonly to?: string;
  /** Machine code of what the record says (`fulfilled_by_result`, `source_withdrawn`, ...). */
  readonly detail?: string;
  readonly actor: CaseEventActor;
  readonly reason: typeof RECONCILIATION_REASON;
  readonly at: Date;
}

/**
 * Which patients a run looks at: `recent`, those with events stored since
 * the previous completed run (the whole clinic the first time); `all`,
 * every patient (a full sweep).
 */
export const RECONCILIATION_SCOPES = ['recent', 'all'] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];

export const RECONCILIATION_STATUSES = ['running', 'completed', 'failed'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** What a run did so far. Counters only grow, patient by patient. */
export interface ReconciliationCounts {
  readonly patientsScanned: number;
  /** Patients with at least one repair. */
  readonly patientsRepaired: number;
  /** Patients changed by someone else while the run looked at them: left for the next run. */
  readonly patientsSkipped: number;
  readonly repairs: number;
  readonly repairsByKind: RepairCounts;
}

export const ZERO_RECONCILIATION_COUNTS: ReconciliationCounts = {
  patientsScanned: 0,
  patientsRepaired: 0,
  patientsSkipped: 0,
  repairs: 0,
  repairsByKind: {},
};

/** Adds two sets of counters. */
export function addReconciliationCounts(
  left: ReconciliationCounts,
  right: ReconciliationCounts,
): ReconciliationCounts {
  const repairsByKind: Partial<Record<ReconciliationRepairKind, number>> = {
    ...left.repairsByKind,
  };
  for (const kind of RECONCILIATION_REPAIR_KINDS) {
    const added = right.repairsByKind[kind] ?? 0;
    if (added > 0) {
      repairsByKind[kind] = (repairsByKind[kind] ?? 0) + added;
    }
  }
  return {
    patientsScanned: left.patientsScanned + right.patientsScanned,
    patientsRepaired: left.patientsRepaired + right.patientsRepaired,
    patientsSkipped: left.patientsSkipped + right.patientsSkipped,
    repairs: left.repairs + right.repairs,
    repairsByKind,
  };
}

/** The stored state of one reconciliation run. Resumable from `cursor`. */
export interface ReconciliationRun extends ReconciliationCounts {
  readonly clinicId: ClinicId;
  readonly runId: string;
  readonly scope: ReconciliationScope;
  readonly status: ReconciliationStatus;
  /**
   * The clinic's event watermark when the run started: the next `recent`
   * run looks at patients with events stored after it.
   */
  readonly watermark?: string;
  /** `recent`: the previous run's watermark (absent: the whole clinic). */
  readonly since?: string;
  /** Last patient fully reconciled; pass as `after` to `listPatientIds`. */
  readonly cursor?: PatientId;
  readonly lastError?: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt?: Date;
}
