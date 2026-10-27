import { z } from 'zod';
import { PLAN_ITEM_KINDS } from '../domain/clinical-event.ts';
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
  /**
   * What the rule expects to happen. Drives the match key (`visit` or the
   * trigger's code) and which events count as fulfillment. Defaults to
   * `lab`/`imaging` for orders of that category and `follow_up_visit` otherwise.
   */
  expects: z.enum(PLAN_ITEM_KINDS).optional(),
  /**
   * Expectations of rules sharing a case group merge into one case per
   * patient (`<patientId>:<caseGroup>`). Defaults to the reason code.
   */
  caseGroup: ConfigIdSchema.optional(),
  /**
   * What `dueInDays` counts from: the trigger event (default) or the end of
   * the prescribed treatment (`startAt + durationDays`).
   */
  dueFrom: z.enum(['trigger', 'treatment_end']).optional(),
  /** Parameters of a `cadence` rule: due after `multiplier` times the patient's usual interval. */
  cadence: z
    .strictObject({
      multiplier: z.number().positive(),
      /**
       * Visits of the same specialty the patient must already have (the
       * latest one included) before the next one is expected: 2 means one
       * interval, the PRD's minimum pattern.
       */
      minPreviousVisits: z.number().int().positive(),
      /** Intervals shorter than this are ignored (same-week repeats). */
      minIntervalDays: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type Rule = z.infer<typeof RuleSchema>;
