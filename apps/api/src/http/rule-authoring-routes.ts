import {
  type AuthoredRuleView,
  type ClinicId,
  ConflictError,
  LlmBudgetExceededError,
  NotFoundError,
  type RuleAuthoringOutcome,
} from '@follow-up-engine/core';
import { ensureLabClinicAndClock, type EngineRuntime } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { InboxPresenter } from '../inbox/presenter.ts';
import type { App, AppEnv } from './context.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { requireEvaluator } from './lab-records-routes.ts';
import { seedRuleAuthoringSamples } from './rule-authoring-samples.ts';
import { RuleDecisionSchema, RuleDraftRequestSchema } from './rule-authoring-schemas.ts';
import { actorId, followUpUser } from './security.ts';

/** The wire shape of a clinic-authored rule: the stored record plus what the page needs to show it. */
export function authoredRuleView(
  rule: AuthoredRuleView,
  baseline: unknown,
  ruleLabels: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  const { authored } = rule;
  const status = rule.live ? 'enabled' : authored.status === 'enabled' ? 'disabled' : 'draft';
  return {
    ruleId: rule.ruleId,
    status,
    live: rule.live,
    version: rule.version,
    updatedAt: rule.updatedAt.toISOString(),
    updatedBy: rule.updatedBy,
    request: authored.request,
    labels: authored.labels,
    kind: authored.definition.kind,
    definition:
      authored.definition.kind === 'rule' ? authored.definition.rule : authored.definition.protocol,
    ...(baseline === undefined ? {} : { baseline }),
    provenance: authored.provenance,
    ruleLabels,
    ...(authored.validatedBy === undefined ? {} : { validatedBy: authored.validatedBy }),
    ...(authored.validatedAt === undefined ? {} : { validatedAt: authored.validatedAt }),
  };
}

function runView(outcome: RuleAuthoringOutcome): Record<string, unknown> {
  const { run } = outcome;
  return {
    stopReason: run.stopReason,
    steps: run.steps,
    toolCalls: run.toolCalls,
    trace: run.trace,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    modelId: run.modelId,
    promptVersion: run.promptVersion,
  };
}

/**
 * The rule-authoring agent's routes (docs/agent/rule-authoring.md). The
 * same commands serve two places:
 *
 * - the evaluator lab, `/api/demo/lab/rules/*`, on each evaluator's own
 *   sandbox clinic and clock (registered only on a fake clock, like the
 *   rest of `/api/demo/*`), with sample patients to dry-run against;
 * - a real clinic, `/api/admin/rules/authored/*` (scope `admin:rules`, the
 *   clinician from `X-FollowUp-User`), next to `PUT /api/admin/rules`.
 *
 * A draft never runs: only "enable", by a named clinician, makes it live.
 */
export function registerRuleAuthoringRoutes(
  app: App,
  runtime: EngineRuntime,
  options: { readonly lab: boolean },
): void {
  const authored = runtime.engine.authoredRules;

  /** What the page shows next to the record: the rule it adapts, and the names of the rules it overlaps. */
  async function present(
    c: Context<AppEnv>,
    clinicId: ClinicId,
    rule: AuthoredRuleView,
  ): Promise<Record<string, unknown>> {
    const presenter = await InboxPresenter.create(runtime, clinicId, c.var.t);
    const catalog = await runtime.engine.catalog(clinicId);
    const basedOn = rule.authored.provenance.basedOn;
    const baseline =
      basedOn === undefined
        ? undefined
        : (catalog.rules.find((item) => item.id === basedOn) ??
          catalog.protocols.find((item) => item.id === basedOn));
    const ids = new Set(rule.authored.provenance.dryRun.overlaps.byRule.map((item) => item.ruleId));
    const ruleLabels = Object.fromEntries(
      [...ids].map((ruleId) => [ruleId, presenter.reasonLabel(ruleId)]),
    );
    return authoredRuleView(rule, baseline, ruleLabels);
  }

  async function views(c: Context<AppEnv>, clinicId: ClinicId): Promise<Record<string, unknown>[]> {
    const rules = await authored.list(clinicId);
    return Promise.all(rules.map((rule) => present(c, clinicId, rule)));
  }

  async function draft(
    c: Context<AppEnv>,
    clinicId: ClinicId,
    actor: string,
    now: Date | undefined,
  ): Promise<Response> {
    const body = await readJson(c, RuleDraftRequestSchema);
    if (body.mode === 'live' && !runtime.liveAgent) {
      throw new HttpError(422, 'agent_live_unavailable', c.var.t.errors.agentLiveUnavailable);
    }
    let outcome: RuleAuthoringOutcome;
    try {
      outcome = await runtime.ruleAuthoring.draft(clinicId, {
        request: body.request,
        mode: body.mode,
        actor,
        ...(now === undefined ? {} : { now }),
      });
    } catch (error) {
      if (error instanceof LlmBudgetExceededError) {
        throw new HttpError(429, 'llm_budget_exceeded', c.var.t.errors.ruleAuthoringBudget);
      }
      throw error;
    }
    c.var.log.info(
      {
        actor: actorId(c),
        mode: body.mode,
        status: outcome.status,
        steps: outcome.run.steps,
        costUsd: outcome.run.costUsd,
        ...(outcome.status === 'drafted'
          ? { ruleId: outcome.rule.ruleId }
          : { reason: outcome.reason }),
      },
      'rule draft',
    );
    if (outcome.status === 'drafted') {
      return c.json(
        {
          status: 'drafted',
          rule: await present(c, clinicId, outcome.rule),
          run: runView(outcome),
        },
        201,
      );
    }
    return c.json({
      status: 'failed',
      reason: outcome.reason,
      issues: outcome.issues,
      run: runView(outcome),
    });
  }

  async function decide(
    c: Context<AppEnv>,
    clinicId: ClinicId,
    actor: string,
    decision: 'enable' | 'discard',
  ): Promise<Response> {
    const ruleId = c.req.param('ruleId') ?? '';
    const body = await readJson(c, RuleDecisionSchema);
    try {
      const meta = { actor, ...(body.reason === undefined ? {} : { reason: body.reason }) };
      const result =
        decision === 'enable'
          ? await authored.enable(clinicId, ruleId, meta)
          : await authored.discard(clinicId, ruleId, meta);
      c.var.log.info(
        { actor: actorId(c), ruleId, decision, version: result.change.version },
        'rule decision',
      );
      return c.json({
        ruleId,
        version: result.change.version,
        ...(result.rule === undefined
          ? { removed: true }
          : { rule: await present(c, clinicId, result.rule) }),
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new HttpError(409, 'rule_state_changed', c.var.t.errors.ruleStateChanged);
      }
      if (error instanceof NotFoundError) {
        throw new HttpError(404, 'rule_not_found', c.var.t.errors.ruleNotFound);
      }
      throw error;
    }
  }

  // A real clinic (scope admin:rules): the clinician is the X-FollowUp-User.
  function clinician(c: Context<AppEnv>): string {
    const user = followUpUser(c);
    if (user === undefined) {
      throw new HttpError(422, 'invalid_request', c.var.t.errors.ruleAuthoringUser);
    }
    return user;
  }
  app.get('/api/admin/rules/authored', async (c) =>
    c.json({ items: await views(c, c.var.clinicId), liveAvailable: runtime.liveAgent }),
  );
  app.post('/api/admin/rules/authored', (c) => draft(c, c.var.clinicId, clinician(c), undefined));
  app.post('/api/admin/rules/authored/:ruleId/enable', (c) =>
    decide(c, c.var.clinicId, clinician(c), 'enable'),
  );
  app.post('/api/admin/rules/authored/:ruleId/discard', (c) =>
    decide(c, c.var.clinicId, clinician(c), 'discard'),
  );

  if (!options.lab) return;

  // The evaluator lab: each evaluator's own sandbox clinic, on its own clock.
  async function lab(c: Context<AppEnv>) {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(
      runtime,
      runtime.labClocks,
      evaluatorEmail,
    );
    return { evaluatorEmail, clinicId: clinic.id, clock };
  }

  app.get('/api/demo/lab/rules', async (c) => {
    const { clinicId } = await lab(c);
    const patients = await runtime.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.clinicalRecords.listPatientIds(clinicId, { limit: 500 }),
    );
    return c.json({
      items: await views(c, clinicId),
      liveAvailable: runtime.liveAgent,
      patients: patients.patientIds.length,
    });
  });

  app.post('/api/demo/lab/rules/drafts', async (c) => {
    const { clinicId, clock, evaluatorEmail } = await lab(c);
    const response = await draft(c, clinicId, evaluatorEmail, clock.now());
    await trackEvaluatorEvent(runtime, {
      clinicId,
      evaluatorEmail,
      action: 'lab_rule_drafted',
      entityType: 'rule',
      entityId: 'draft',
      payload: { status: response.status },
    });
    return response;
  });

  app.post('/api/demo/lab/rules/samples', async (c) => {
    const { clinicId, clock, evaluatorEmail } = await lab(c);
    const added = await seedRuleAuthoringSamples(runtime, clinicId, clock);
    await trackEvaluatorEvent(runtime, {
      clinicId,
      evaluatorEmail,
      action: 'lab_rule_samples_added',
      entityType: 'clinic',
      entityId: clinicId,
      payload: { added },
    });
    return c.json({ added }, 201);
  });

  for (const decision of ['enable', 'discard'] as const) {
    app.post(`/api/demo/lab/rules/:ruleId/${decision}`, async (c) => {
      const { clinicId, evaluatorEmail } = await lab(c);
      const response = await decide(c, clinicId, evaluatorEmail, decision);
      await trackEvaluatorEvent(runtime, {
        clinicId,
        evaluatorEmail,
        action: decision === 'enable' ? 'lab_rule_enabled' : 'lab_rule_discarded',
        entityType: 'rule',
        entityId: c.req.param('ruleId'),
        payload: {},
      });
      return response;
    });
  }
}
