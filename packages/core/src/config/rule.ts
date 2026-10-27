import { z } from 'zod';
import { EXPECTATION_LAYERS } from '../domain/expectation.ts';
import {
  ConfigIdSchema,
  ConfigVersionSchema,
  EscalationPolicySchema,
  EventCorrelationSchema,
  EventMatcherSchema,
  ReasonSchema,
  SuggestedActionSchema,
} from './common.ts';

/**
 * A versioned rule (config/rules/*.json): when `trigger` happens, expect one
 * of `fulfilledBy` within `dueInDays`, otherwise escalate.
 *
 * For `doctor_plan` rules the plan item's own `dueAt` wins and `dueInDays`
 * is the fallback.
 */
export const RuleSchema = z.strictObject({
  id: ConfigIdSchema,
  version: ConfigVersionSchema,
  layer: z.enum(EXPECTATION_LAYERS),
  /** English, for maintainers. */
  description: z.string().min(1),
  reason: ReasonSchema,
  trigger: EventMatcherSchema,
  dueInDays: z.number().int().positive(),
  fulfilledBy: z.array(EventCorrelationSchema).min(1),
  /** Events that replace the expectation (for example a newer order of the same test). */
  supersededBy: z.array(EventCorrelationSchema).optional(),
  /** Events that look like fulfillment but must not count (for example a cancelled appointment). */
  notFulfilledBy: z.array(EventMatcherSchema).optional(),
  /** Base priority of the case it opens; higher is more urgent. */
  priority: z.number().int().nonnegative(),
  escalationPolicy: EscalationPolicySchema,
  suggestedAction: SuggestedActionSchema,
});

export type Rule = z.infer<typeof RuleSchema>;
