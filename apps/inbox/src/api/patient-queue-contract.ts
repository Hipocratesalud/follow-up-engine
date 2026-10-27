import type {
  CaseListView,
  CaseReasonView,
  CaseStatus,
  CaseView,
  Layer,
  Origin,
  PatientContact,
  PatientExpectationView,
  PatientSummary,
  PriorityBand,
  ProtocolRef,
} from './contract.ts';

/*
 * The patient queue and plan item review contract (HIP-141), mirroring
 * apps/api/src/http/patient-queue-schemas.ts and plan-item-schemas.ts.
 */

export interface PlanItemReviewResponse {
  expectation: PatientExpectationView;
  replacement?: PatientExpectationView;
  casesResolved: string[];
}

/** One card of the patient queue: the patient and every case, most urgent first. */
export interface PatientQueueItem {
  patient: PatientSummary;
  priority: number;
  priorityBand: PriorityBand;
  priorityLabel: string;
  status: CaseStatus;
  caseCount: number;
  reasonCount: number;
  topReason?: CaseReasonView;
  layers: Layer[];
  protocols: ProtocolRef[];
  escalation: {
    currentStep: number;
    escalated: boolean;
    next?: { caseId: string; label: string; at: string };
  };
  nextAction: { caseId: string; label: string };
  origin: Origin;
  openedAt: string;
  /** The newest live case (else the newest case). */
  latestOpenedAt: string;
  assignees: string[];
  patientContact: PatientContact;
  /** Active cases first (most urgent first), then the closed ones. */
  cases: CaseView[];
}

export interface PatientQueuePage {
  items: PatientQueueItem[];
  nextCursor?: string;
  /** Patients matching the query, across all pages. */
  total: number;
  /** Their cases. */
  totalCases: number;
}

export interface PatientQueueQuery {
  view?: CaseListView;
  origin?: Origin;
  assignee?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}
