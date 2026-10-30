import type { ClinicId, ExpectationId, PatientId } from './ids.ts';
import type { ResourceRef } from './resource.ts';

/**
 * What the engine records about an expectation outside a case (most closed
 * expectations never belong to one):
 *
 * - `closed_reason_reclassified`: a later fact changed what an already
 *   closed expectation's closure means (a `covered_by_order` plan item whose
 *   order the end of the pregnancy cancelled now reads `pregnancy_ended`).
 *   The expectation keeps its original `closedReason`, `closedAt` and
 *   `closedBy`; this entry is the history of the change.
 */
export const EXPECTATION_EVENT_TYPES = ['closed_reason_reclassified'] as const;
export type ExpectationEventType = (typeof EXPECTATION_EVENT_TYPES)[number];

/** Why a closure was reclassified. */
export const RECLASSIFICATION_CAUSES = ['episode_ended'] as const;
export type ReclassificationCause = (typeof RECLASSIFICATION_CAUSES)[number];

/**
 * Append-only audit entry of one expectation. Written by the engine
 * (`actor: 'engine'`), never updated or deleted. Ids, codes and dates only.
 */
export interface ExpectationEvent {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly expectationId: ExpectationId;
  readonly type: ExpectationEventType;
  readonly actor: 'engine';
  readonly at: Date;
  /** The reason the closure read as before (`covered_by_order`). */
  readonly fromReason: string;
  /** The reason it reads as from now on (`pregnancy_ended`). */
  readonly toReason: string;
  readonly cause: ReclassificationCause;
  /** The resource whose event caused it (the record that told the delivery). */
  readonly causedBy: ResourceRef;
  /**
   * The expectation whose own closure carried the change over (the order
   * the plan item was folded into, itself cancelled `pregnancy_ended`).
   */
  readonly relatedExpectationId?: ExpectationId;
}
