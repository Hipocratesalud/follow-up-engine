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
   * Days after a booked appointment's date within which its visit may still
   * be recorded. Past them with no visit, the booking no longer fulfills
   * anything (many hosts never mark a no-show) and what it fulfilled is open
   * again.
   */
  readonly bookingVisitGraceDays: number;
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
  bookingVisitGraceDays: 2,
};
