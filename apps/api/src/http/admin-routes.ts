import {
  ConflictError,
  type RuleConfigView,
  type RuleOverrideChange,
  ValidationError,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import { z } from 'zod';
import type { AdminMessages } from '../i18n/index.ts';
import {
  type AdminRuleChangeView,
  type AdminRuleUpdateResult,
  AdminRuleUpdateSchema,
  type AdminRuleView,
} from './admin-schemas.ts';
import type { App } from './context.ts';
import { HttpError, readJson, readQuery } from './errors.ts';
import { followUpUser } from './security.ts';

function ruleView(rule: RuleConfigView, labels: AdminMessages): AdminRuleView {
  return {
    ruleId: rule.ruleId,
    layer: rule.layer,
    layerLabel: labels.layers[rule.layer],
    description: rule.description,
    defaults: rule.defaults,
    effective: rule.effective,
    version: rule.version,
    ...(rule.override === undefined
      ? {}
      : {
          override: {
            value: rule.override.override,
            version: rule.override.version,
            updatedAt: rule.override.updatedAt.toISOString(),
            updatedBy: rule.override.updatedBy,
            reason: rule.override.reason,
          },
        }),
  };
}

function changeView(change: RuleOverrideChange): AdminRuleChangeView {
  return {
    ruleId: change.ruleId,
    version: change.version,
    action: change.action,
    ...(change.previous === undefined ? {} : { previous: change.previous }),
    ...(change.next === undefined ? {} : { next: change.next }),
    actor: change.actor,
    reason: change.reason,
    at: change.at.toISOString(),
  };
}

/** A domain refusal as the 422 / 409 of this API, with this API's copy. */
function adminError(error: unknown, labels: AdminMessages): unknown {
  if (error instanceof ValidationError) {
    const known = labels.fields[error.field as keyof AdminMessages['fields']] as string | undefined;
    const message = known ?? labels.fields.unknownField;
    return new HttpError(422, 'invalid_request', labels.invalid, [{ path: error.field, message }]);
  }
  if (error instanceof ConflictError) {
    return new HttpError(409, 'stale_version', labels.staleVersion);
  }
  return error;
}

const HistoryQuerySchema = z.object({
  ruleId: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Per-clinic rule configuration (HIP-141), scope `admin:rules`:
 *
 * - `GET /api/admin/rules`: every rule of the clinic's validated config, its
 *   defaults, the override in force and the version new expectations carry;
 * - `PUT /api/admin/rules`: change one rule (`override: { dueInDays?, enabled? }`,
 *   or `null` to reset it), with a reason; the user from `X-FollowUp-User`;
 * - `GET /api/admin/rules/history`: who changed what, when, old → new, why.
 *
 * Changes apply to expectations created after them; existing ones keep the
 * deadline and the rule version they were created with.
 */
export function registerAdminRoutes(app: App, runtime: EngineRuntime): void {
  const rules = runtime.engine.ruleOverrides;

  app.get('/api/admin/rules', async (c) => {
    const labels = c.var.t.admin;
    const items = (await rules.list(c.var.clinicId)).map((rule) => ruleView(rule, labels));
    return c.json({ items });
  });

  app.get('/api/admin/rules/history', async (c) => {
    const query = readQuery(c, HistoryQuerySchema);
    const items = await rules.history(c.var.clinicId, {
      limit: query.limit ?? 100,
      ...(query.ruleId === undefined ? {} : { ruleId: query.ruleId }),
    });
    return c.json({ items: items.map(changeView) });
  });

  app.put('/api/admin/rules', async (c) => {
    const labels = c.var.t.admin;
    const body = await readJson(c, AdminRuleUpdateSchema);
    const meta = {
      actor: followUpUser(c) ?? '',
      reason: body.reason,
      ...(body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion }),
    };
    try {
      const result =
        body.override === null
          ? await rules.reset(c.var.clinicId, body.ruleId, meta)
          : await rules.set(c.var.clinicId, body.ruleId, body.override ?? {}, meta);
      c.var.log.info(
        {
          ruleId: body.ruleId,
          changed: result.change !== undefined,
          version: result.change?.version,
        },
        'rule override',
      );
      const response: AdminRuleUpdateResult = {
        changed: result.change !== undefined,
        ...(result.change === undefined
          ? { message: labels.unchanged }
          : { change: changeView(result.change) }),
        rule: ruleView(result.rule, labels),
      };
      return c.json(response);
    } catch (error) {
      throw adminError(error, labels);
    }
  });
}
