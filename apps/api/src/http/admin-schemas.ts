import { EXPECTATION_LAYERS, MAX_OVERRIDE_DUE_IN_DAYS } from '@follow-up-engine/core';
import { z } from 'zod';

/**
 * JSON contract of the rule configuration API (`/api/admin/rules`, scope
 * `admin:rules`): per-clinic overrides of the versioned rules, audited.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const RuleOverrideValueSchema = z
  .object({
    dueInDays: z.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .meta({
    id: 'RuleOverrideValue',
    description: `Only these fields; dueInDays a whole number from 1 to ${String(MAX_OVERRIDE_DUE_IN_DAYS)}`,
  });

export const AdminRuleSchema = z
  .object({
    ruleId: z.string(),
    layer: z.enum(EXPECTATION_LAYERS),
    layerLabel: z.string(),
    description: z.string().meta({ description: 'English, for maintainers' }),
    defaults: z.object({ dueInDays: z.number().int(), enabled: z.literal(true) }),
    effective: z.object({ dueInDays: z.number().int(), enabled: z.boolean() }),
    version: z.string().meta({
      description: 'The version new expectations of the rule carry: `1.1.0` or `1.1.0+clinic.2`',
    }),
    override: z
      .object({
        value: RuleOverrideValueSchema,
        version: z.number().int().meta({ description: 'Pass it as expectedVersion to change it' }),
        updatedAt: isoDate,
        updatedBy: z.string(),
        reason: z.string(),
      })
      .optional(),
  })
  .meta({ id: 'AdminRule' });

export const AdminRuleListSchema = z
  .object({ items: z.array(AdminRuleSchema) })
  .meta({ id: 'AdminRuleList' });

export const AdminRuleChangeSchema = z
  .object({
    ruleId: z.string(),
    version: z.number().int(),
    action: z.enum(['set', 'reset']),
    previous: RuleOverrideValueSchema.optional(),
    next: RuleOverrideValueSchema.optional(),
    actor: z.string(),
    reason: z.string(),
    at: isoDate,
  })
  .meta({ id: 'AdminRuleChange' });

export const AdminRuleHistorySchema = z
  .object({ items: z.array(AdminRuleChangeSchema) })
  .meta({ id: 'AdminRuleHistory' });

export const AdminRuleUpdateSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(120),
    override: z.unknown().meta({
      description:
        '`{ dueInDays?, enabled? }` merged into the rule override; `null` resets the rule',
    }),
    reason: z.string().max(500).meta({ description: 'Why (kept in the audit trail)' }),
    expectedVersion: z.number().int().min(0).optional().meta({
      description: "The rule's override version you read (0: never changed); 409 when stale",
    }),
  })
  .meta({ id: 'AdminRuleUpdate' });

export const AdminRuleUpdateResultSchema = z
  .object({
    changed: z.boolean(),
    message: z.string().optional(),
    change: AdminRuleChangeSchema.optional(),
    rule: AdminRuleSchema,
  })
  .meta({ id: 'AdminRuleUpdateResult' });

export type AdminRuleView = z.infer<typeof AdminRuleSchema>;
export type AdminRuleChangeView = z.infer<typeof AdminRuleChangeSchema>;
export type AdminRuleUpdateResult = z.infer<typeof AdminRuleUpdateResultSchema>;
