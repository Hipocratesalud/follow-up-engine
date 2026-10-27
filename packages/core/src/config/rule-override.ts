import { z } from 'zod';
import { MAX_OVERRIDE_DUE_IN_DAYS, type RuleOverride } from '../domain/rule-override.ts';

/**
 * A clinic's override of a rule, validated: only known fields
 * (`dueInDays`, `enabled`), a deadline of at least one whole day and at
 * most {@link MAX_OVERRIDE_DUE_IN_DAYS}. Strict: any other field is refused,
 * so a typo never silently does nothing.
 */
export const RuleOverrideSchema = z.strictObject({
  dueInDays: z.number().int().min(1).max(MAX_OVERRIDE_DUE_IN_DAYS).optional(),
  enabled: z.boolean().optional(),
});

/** A validated override without `undefined`-valued keys. */
export function parsedRuleOverride(value: z.infer<typeof RuleOverrideSchema>): RuleOverride {
  return {
    ...(value.dueInDays === undefined ? {} : { dueInDays: value.dueInDays }),
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
  };
}
