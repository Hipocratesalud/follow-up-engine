import { PLAN_ITEM_KINDS } from '@follow-up-engine/core';
import { z } from 'zod';

/*
 * The plan item review contract (HIP-141): how a reason or an expectation
 * read by the AI from a note shows its review state, and the bodies of the
 * confirm / correct / reject commands. Kept apart from schemas.ts, which
 * embeds `PlanItemViewSchema` in the reason and expectation views.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const PlanItemKindSchema = z.enum(PLAN_ITEM_KINDS);

export const PLAN_ITEM_REVIEW_STATES = ['pending', 'confirmed', 'corrected', 'rejected'] as const;

export const PlanItemViewSchema = z
  .object({
    kind: PlanItemKindSchema.meta({
      description: 'What the AI read the item asks for (follow_up_visit, lab, imaging, ...)',
    }),
    kindLabel: z.string(),
    review: z.enum(PLAN_ITEM_REVIEW_STATES).meta({
      description:
        'pending: nobody reviewed the reading yet; confirmed: a clinician confirmed it (or it is a correction); corrected: superseded by a correction; rejected: the note never asked for it',
    }),
    confirmedBy: z.string().optional().meta({ description: 'Display name of the clinician' }),
    confirmedAt: isoDate.optional(),
    correctionOf: z.string().optional().meta({
      description: 'A correction: the id of the expectation it replaced',
    }),
    actionable: z.boolean().meta({
      description:
        'The item can still be corrected or rejected (open or overdue, not reviewed by a clinician yet)',
    }),
  })
  .meta({ id: 'PlanItemView' });

/** `YYYY-MM-DD`, the clinic's calendar day the item is due. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const PlanItemCorrectionRequestSchema = z
  .object({
    dueDate: z
      .string()
      .regex(CALENDAR_DAY)
      .refine((value) => !Number.isNaN(Date.parse(`${value}T12:00:00Z`)))
      .optional()
      .meta({
        description: 'The corrected due day (YYYY-MM-DD); the item is due at noon UTC that day',
        example: '2026-04-15',
      }),
    kind: PlanItemKindSchema.optional().meta({ description: 'The corrected kind' }),
  })
  .meta({ id: 'PlanItemCorrectionRequest' });

export type PlanItemView = z.infer<typeof PlanItemViewSchema>;
export type PlanItemCorrectionRequest = z.infer<typeof PlanItemCorrectionRequestSchema>;
