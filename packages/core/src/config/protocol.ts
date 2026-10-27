import { z } from 'zod';
import { PLAN_ITEM_KINDS } from '../domain/clinical-event.ts';
import {
  CodingSchema,
  ConfigIdSchema,
  ConfigVersionSchema,
  EscalationPolicySchema,
  EventCorrelationSchema,
  ReasonSchema,
  SuggestedActionSchema,
} from './common.ts';

/**
 * A versioned care protocol (config/protocols/*.json): a cadence of
 * expectations for patients with a condition. Protocols only fill what the
 * doctor's plan for the consultation did not already cover.
 */
export const ProtocolSchema = z.strictObject({
  id: ConfigIdSchema,
  version: ConfigVersionSchema,
  /** English, for maintainers. */
  description: z.string().min(1),
  reason: ReasonSchema,
  enrollment: z.strictObject({
    /** ICD-10 codes or code prefixes (`E11` matches `E11.9`). */
    conditionCodes: z.array(z.string().min(1)).min(1),
    /** `probable` also enrolls inferred conditions. */
    minimumStatus: z.enum(['confirmed', 'probable']),
    /**
     * Medications that make the condition probable when no diagnosis is
     * coded: case-insensitive substrings of the medication text.
     */
    medications: z
      .array(
        z.strictObject({
          match: z.array(z.string().min(1)).min(1),
          conditionCode: z.string().min(1),
        }),
      )
      .optional(),
    /** Results that make the condition probable (`value >= gte`, or `abnormal` without a value). */
    results: z
      .array(
        z.strictObject({
          code: CodingSchema,
          gte: z.number(),
          conditionCode: z.string().min(1),
        }),
      )
      .optional(),
  }),
  /** Case group of every item (see `Rule.caseGroup`). Defaults to the protocol reason code. */
  caseGroup: ConfigIdSchema.optional(),
  items: z
    .array(
      z.strictObject({
        key: ConfigIdSchema,
        kind: z.enum(PLAN_ITEM_KINDS),
        reason: ReasonSchema,
        everyDays: z.number().int().positive(),
        /** The test the item expects, for lab and imaging items (match key and coverage). */
        code: CodingSchema.optional(),
        fulfilledBy: z.array(EventCorrelationSchema).min(1),
        priority: z.number().int().nonnegative(),
        suggestedAction: SuggestedActionSchema,
      }),
    )
    .min(1),
  escalationPolicy: EscalationPolicySchema,
});

export type Protocol = z.infer<typeof ProtocolSchema>;
export type ProtocolItem = Protocol['items'][number];
