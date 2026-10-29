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

/** One chip of the reason-type filter: an engine layer, with the patients it currently matches. */
export interface LayerFacet {
  layer: Layer;
  label: string;
  count: number;
}

/** One chip of the condition filter: a protocol of the catalog. */
export interface ProtocolFacet {
  id: string;
  label: string;
  count: number;
}

/**
 * Counts for the filter bar, over the current view, search and owner: each
 * ignores only its own filter, so picking a layer never hides a protocol
 * count and back.
 */
export interface PatientQueueFacets {
  layers: LayerFacet[];
  protocols: ProtocolFacet[];
}

export interface PatientQueuePage {
  items: PatientQueueItem[];
  nextCursor?: string;
  /** Patients matching the query, across all pages. */
  total: number;
  /** Their cases. */
  totalCases: number;
  facets: PatientQueueFacets;
}

export interface PatientQueueQuery {
  view?: CaseListView;
  origin?: Origin;
  assignee?: string;
  q?: string;
  /** Comma-separated layer ids: a patient matches if any open reason is in one of them. */
  layer?: string;
  /** Comma-separated protocol ids (from the catalog); same OR-match rule as `layer`. */
  protocol?: string;
  cursor?: string;
  limit?: number;
}
