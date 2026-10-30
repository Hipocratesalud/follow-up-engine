import type { Evidence, Origin, Reason } from './common.ts';
import type { CaseId, ClinicId, ExpectationId, PatientId } from './ids.ts';
import type { ResourceRef } from './resource.ts';

/** Where an expectation comes from, in the order the annotator applies them. */
export const EXPECTATION_LAYERS = ['universal', 'doctor_plan', 'cadence', 'protocol'] as const;
export type ExpectationLayer = (typeof EXPECTATION_LAYERS)[number];

/**
 * Lifecycle of an expectation. `open` is watched by the deadline sweep;
 * `expired` means it is grouped into a case and can still close late
 * (`fulfilled`, `superseded`, `cancelled`) while that case is active. The
 * other statuses are terminal.
 */
export const EXPECTATION_STATUSES = [
  'open',
  'fulfilled',
  'superseded',
  'expired',
  'cancelled',
] as const;
export type ExpectationStatus = (typeof EXPECTATION_STATUSES)[number];

/**
 * A closed expectation's closure read in the light of a later fact, never a
 * rewrite of it. A doctor's-plan test folded into the order of the same
 * visit (`covered_by_order`) whose order the end of the pregnancy then
 * cancelled (`pregnancy_ended`): the plan item's original closure stays as
 * it was, and this says it is gone because the pregnancy ended.
 */
export interface ClosureReclassification {
  /** The reason the closure reads as now (`pregnancy_ended`). */
  readonly closedReason: string;
  /** When the engine reclassified it. */
  readonly at: Date;
  /** The resource whose event led to it (the record that told the delivery). */
  readonly by: ResourceRef;
}

/**
 * Why a closed expectation is gone, as it reads now: its reclassification
 * when a later fact changed the meaning of its closure, else its
 * `closedReason`. What the inbox, the FHIR `Task.statusReason` and the
 * order agent show.
 */
export function effectiveClosedReason(
  expectation: Pick<Expectation, 'closedReason' | 'reclassification'>,
): string | undefined {
  return expectation.reclassification?.closedReason ?? expectation.closedReason;
}

/**
 * Something that should happen for a patient by a date ("imaging result
 * within 30 days of the order"). Persisted and exposed as a FHIR `Task`;
 * `status` maps to `Task.businessStatus`.
 */
export interface Expectation {
  readonly id: ExpectationId;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  /** Deduplicates creation: the same trigger never yields two expectations. */
  readonly idempotencyKey: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly layer: ExpectationLayer;
  /** The resource that triggered it (order, prescription, note, ...). */
  readonly source: ResourceRef;
  /**
   * What a fulfilling event must match, derived from the rule's `fulfilledBy`
   * (for example `order:<orderId>` or `code:<system>|<code>`).
   */
  readonly matchKey: string;
  readonly dueAt: Date;
  readonly status: ExpectationStatus;
  /** The case it was grouped into once it expired. */
  readonly caseId?: CaseId;
  /** Machine code explaining a terminal status (for example `fulfilled_by_result`). */
  readonly closedReason?: string;
  readonly closedAt?: Date;
  /**
   * The resource whose event closed it (the result, the encounter, the
   * appointment, the newer order). A cancelled appointment reopens what it
   * fulfilled.
   */
  readonly closedBy?: ResourceRef;
  /**
   * What the closure reads as now, when a later fact changed its meaning
   * (`closedReason`, `closedAt` and `closedBy` keep the original closure,
   * never rewritten). Each reclassification is also an append-only
   * `closed_reason_reclassified` entry of the expectation event log. Read
   * the reason through {@link effectiveClosedReason}.
   */
  readonly reclassification?: ClosureReclassification;
  /**
   * Fulfilled by a booking: when to check that the visit took place (the
   * appointment date plus the grace days). A booking whose date passed with
   * no visit stops fulfilling and the expectation is open again.
   */
  readonly recheckAt?: Date;
  /**
   * `critical`: triggered by a panic result. Due sooner and ranked above
   * every other reason (see the case priority model).
   */
  readonly severity?: 'critical';
  readonly origin: Origin;
  readonly protocolId?: string;
  readonly protocolVersion?: string;
  readonly reason: Reason;
  /** Present for `doctor_plan` expectations: the quote from the note. */
  readonly evidence?: Evidence;
  /**
   * `doctor_plan` only: how confidently the extractor read the item from the
   * note (0 to 1). An item inside the clinic's ambiguous band goes to the
   * adjudicator (see `domain/adjudication.ts`).
   */
  readonly confidence?: number;
  /**
   * A clinician confirmed what the AI read (`doctor_plan` only, HIP-141):
   * their host user id. A correction is confirmed by whoever made it.
   */
  readonly confirmedBy?: string;
  readonly confirmedAt?: Date;
  /**
   * A clinician's correction: the expectation this one replaced (superseded
   * with `corrected_by_clinician`). It keeps that one's source and evidence.
   */
  readonly correctionOf?: ExpectationId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
