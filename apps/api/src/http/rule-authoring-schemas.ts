import { z } from 'zod';

/** "Draft a rule": the clinician's words and the agent's mode (`live` needs a real model). */
export const RuleDraftRequestSchema = z
  .object({
    request: z.string().trim().min(1).max(500),
    mode: z.enum(['scripted', 'live']),
  })
  .strict()
  .meta({ id: 'AuthoredRuleDraftRequest' });

/** Enable or discard a clinic rule, with an optional reason for the history. */
export const RuleDecisionSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict()
  .meta({ id: 'AuthoredRuleDecision' });

const AuthoredRuleSchema = z
  .object({
    ruleId: z.string(),
    status: z.enum(['draft', 'enabled', 'disabled']),
    live: z.boolean(),
    version: z.number().int(),
    request: z.string(),
    labels: z.object({ en: z.string(), es: z.string() }),
    kind: z.enum(['rule', 'protocol']),
    definition: z.record(z.string(), z.unknown()),
    baseline: z.record(z.string(), z.unknown()).optional(),
    provenance: z.record(z.string(), z.unknown()),
    ruleLabels: z.record(z.string(), z.string()),
    validatedBy: z.string().optional(),
    validatedAt: z.string().optional(),
  })
  .meta({ id: 'AuthoredRule' });

export const AuthoredRuleListSchema = z
  .object({ items: z.array(AuthoredRuleSchema), liveAvailable: z.boolean() })
  .meta({ id: 'AuthoredRuleList' });

export const AuthoredRuleDraftResultSchema = z
  .object({
    status: z.enum(['drafted', 'failed']),
    rule: AuthoredRuleSchema.optional(),
    reason: z.enum(['no_submission', 'abstained', 'invalid_submission']).optional(),
    issues: z.array(z.string()).optional(),
    run: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AuthoredRuleDraftResult' });

export const AuthoredRuleDecisionResultSchema = z
  .object({
    ruleId: z.string(),
    version: z.number().int(),
    removed: z.boolean().optional(),
    rule: AuthoredRuleSchema.optional(),
  })
  .meta({ id: 'AuthoredRuleDecisionResult' });
