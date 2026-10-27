/** Engine-wide tunables. Defaults come from the PRD; apps may override them. */
export interface EngineSettings {
  /** At most one follow-up contact request per patient in this many days, whatever the number of cases. */
  readonly patientContactWindowDays: number;
  /** `dueBy` of a patient contact request, in days from the request. */
  readonly patientContactDueInDays: number;
  /** Plan items below this model confidence do not create expectations. */
  readonly minPlanItemConfidence: number;
  /** Conditions read from notes below this confidence are ignored. */
  readonly minExtractedConditionConfidence: number;
  /** Owner of a case when the treating practitioner is unknown. */
  readonly frontDeskOwner: string;
  /** Owner of a case escalated to coordination. */
  readonly coordinatorOwner: string;
  /** Page size of the deadline and escalation sweeps (one transaction per page). */
  readonly sweepBatchSize: number;
  /** Patients per page of the initial backfill (each patient is its own transaction). */
  readonly backfillPageSize: number;
  /**
   * Old history sent through live ingestion: a batch whose newest clinical
   * date is more than this many days before it arrived is history, not a
   * new fact. What it leaves already overdue is routed like the backfill:
   * never contacts the patient automatically, and is held among the patients
   * to recover when overdue by more than the clinic's
   * `backfillNotifyMaxAgeDays`.
   */
  readonly lateHistoryDays: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  patientContactWindowDays: 14,
  patientContactDueInDays: 7,
  minPlanItemConfidence: 0.5,
  minExtractedConditionConfidence: 0.5,
  frontDeskOwner: 'front_desk',
  coordinatorOwner: 'coordinator',
  sweepBatchSize: 200,
  backfillPageSize: 50,
  lateHistoryDays: 90,
};
