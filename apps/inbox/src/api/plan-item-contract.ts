/*
 * The plan item review contract (HIP-141), mirroring
 * apps/api/src/http/plan-item-schemas.ts. Kept apart from contract.ts, which
 * embeds `PlanItemView` in the reason and expectation views.
 */

/** What a plan item asks for (the same values as `PlanItemKind` in contract.ts). */
export const PLAN_ITEM_KINDS = ['follow_up_visit', 'lab', 'imaging', 'session', 'other'] as const;
export type PlanItemViewKind = (typeof PLAN_ITEM_KINDS)[number];

/** How a doctor's-plan reason or expectation shows the AI reading and its review. */
export interface PlanItemView {
  kind: PlanItemViewKind;
  kindLabel: string;
  /** `pending`: nobody reviewed the reading; `corrected`: superseded by a correction. */
  review: 'pending' | 'confirmed' | 'corrected' | 'rejected';
  confirmedBy?: string;
  confirmedAt?: string;
  /** A correction: the expectation it replaced. */
  correctionOf?: string;
  /** Open or overdue, not closed by a clinician: it can still be corrected or rejected. */
  actionable: boolean;
}

export interface PlanItemCorrectionRequest {
  /** `YYYY-MM-DD`. */
  dueDate?: string;
  kind?: PlanItemViewKind;
}

export type PlanItemCommand = 'confirm' | 'correct' | 'reject';
