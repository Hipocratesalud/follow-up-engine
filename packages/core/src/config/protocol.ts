import { z } from 'zod';
import { PLAN_ITEM_KINDS } from '../domain/clinical-event.ts';
import {
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
  }),
  items: z
    .array(
      z.strictObject({
        key: ConfigIdSchema,
        kind: z.enum(PLAN_ITEM_KINDS),
        reason: ReasonSchema,
        everyDays: z.number().int().positive(),
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
