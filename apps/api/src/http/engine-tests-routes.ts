import { patientId as toPatientId } from '@follow-up-engine/core';
import {
  ensureLabClinicAndClock,
  type EngineRuntime,
  type LabClockRegistry,
  setLabClinicDate,
} from '@follow-up-engine/runtime';
import { ENGINE_TESTS, engineTestDef } from './engine-tests-catalog.ts';
import {
  type EngineTestStepValue,
  EngineTestFreeformRequestSchema,
  EngineTestStepRequestSchema,
  EngineTestVerdictSchema,
} from './engine-tests-schemas.ts';
import { applyFreeform, freshEngineTestPatient, stepsOf } from './engine-tests-scenarios.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { requireEvaluator } from './lab-records-routes.ts';
import { actorId } from './security.ts';
import type { App } from './context.ts';

const VERDICT_EVENTS_LIMIT = 2_000;

/** A `YYYY-MM-DD` day, or an ISO instant (the scenario's own `day0`), read at noon UTC when it is bare. */
function parseDay0(value: string): Date {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, 'invalid_day0', 'day0 is not a valid date');
  }
  return parsed;
}

/** A short, human-readable summary of what the physician submitted, for the audit trail. */
function summarizeInput(value: EngineTestStepValue): string {
  switch (value.action) {
    case 'record':
      return `record:${value.entry.kind}@${value.recordDate}`;
    case 'document':
      return `document:${value.documentType}@${value.documentDate}${value.file === undefined ? '' : ':file'}`;
    case 'clock':
      return `clock:${value.targetDate}`;
    case 'rule_timeframe':
      return `rule_timeframe:${String(value.dueInDays)}d`;
    case 'confirm_plan':
      return 'confirm_plan';
    case 'rule_card':
      return 'rule_card';
  }
}

/**
 * The guided "Engine tests" page (docs/deploy.md#engine-tests): a
 * non-technical physician performs each numbered step themselves — loading
 * a pre-filled but editable form through the same lab ingestion paths — and
 * reads the real engine's own timeline, expectations and automatic check.
 * Registered only on a fake clock, alongside the rest of `/api/demo/*`.
 */
export function registerEngineTestsRoutes(
  app: App,
  runtime: EngineRuntime,
  labClocks: LabClockRegistry,
): void {
  app.get('/api/demo/engine-tests', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const events = await runtime.storage.evaluatorEvents.list({
      clinicId: clinic.id,
      evaluatorEmail,
      limit: VERDICT_EVENTS_LIMIT,
    });
    const reviewed = new Set(
      events.items
        .filter((event) => event.action === 'engine_test_verdict')
        .map((event) => event.payload?.['scenarioId'])
        .filter((scenarioId): scenarioId is string => typeof scenarioId === 'string'),
    );
    return c.json({
      items: ENGINE_TESTS.map((test) => ({
        id: test.id,
        group: test.group,
        ...(test.ruleId === undefined ? {} : { ruleId: test.ruleId }),
        stepCount: stepsOf(test).length,
        reviewed: reviewed.has(test.id),
      })),
      progress: { reviewed: reviewed.size, total: ENGINE_TESTS.length },
    });
  });

  /** Starts (or restarts) a scenario on a brand-new fictitious patient, with every step's pre-filled suggestion. */
  app.post('/api/demo/engine-tests/:id/start', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const def = engineTestDef(c.req.param('id'));
    if (def === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const { clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const day0 = clock.now();
    const patient = freshEngineTestPatient();
    const steps = stepsOf(def).map((step, index) => ({
      step: index + 1,
      action: step.action,
      suggestion: step.buildSuggestion(day0),
    }));
    c.var.log.info({ actor: actorId(c), scenarioId: def.id }, 'engine test started');
    return c.json({ id: def.id, patientId: patient.id, day0: day0.toISOString(), steps });
  });

  /** Applies one step's (possibly edited) input through the real engine and returns its outcome. */
  app.post('/api/demo/engine-tests/:id/steps/:n', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const def = engineTestDef(c.req.param('id'));
    if (def === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const stepNumber = Number(c.req.param('n'));
    const steps = stepsOf(def);
    const step = steps[stepNumber - 1];
    if (!Number.isInteger(stepNumber) || step === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const body = await readJson(c, EngineTestStepRequestSchema);
    if (body.value.action !== step.action) {
      throw new HttpError(
        422,
        'engine_test_wrong_step_action',
        `Step ${String(stepNumber)} of "${def.id}" expects a "${step.action}" input`,
      );
    }
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(body.patientId);
    const day0 = parseDay0(body.day0);
    const outcome = await step.run(
      {
        runtime,
        clinicId: clinic.id,
        clock,
        evaluatorEmail,
        t: c.var.t,
        patientId,
        advanceTo: async (target) => {
          await setLabClinicDate(runtime, clock, clinic.id, target);
        },
      },
      day0,
      body.value,
    );
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'engine_test_step',
      entityType: 'engine_test',
      entityId: def.id,
      patientId,
      payload: {
        scenarioId: def.id,
        step: stepNumber,
        inputs: summarizeInput(body.value),
        autoCheckPassed: outcome.autoCheck.passed,
      },
    });
    c.var.log.info(
      { actor: actorId(c), scenarioId: def.id, step: stepNumber, passed: outcome.autoCheck.passed },
      'engine test step',
    );
    return c.json({ id: def.id, patientId, step: stepNumber, ...outcome });
  });

  /** "Try anything else": a free-form record or document action, outside any numbered step. */
  app.post('/api/demo/engine-tests/:id/freeform', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const def = engineTestDef(c.req.param('id'));
    if (def === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const body = await readJson(c, EngineTestFreeformRequestSchema);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(body.patientId);
    const outcome = await applyFreeform(
      {
        runtime,
        clinicId: clinic.id,
        clock,
        evaluatorEmail,
        t: c.var.t,
        patientId,
        advanceTo: async (target) => {
          await setLabClinicDate(runtime, clock, clinic.id, target);
        },
      },
      body.value,
    );
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'engine_test_step',
      entityType: 'engine_test',
      entityId: def.id,
      patientId,
      payload: {
        scenarioId: def.id,
        step: 'freeform',
        inputs: summarizeInput(body.value),
        autoCheckPassed: outcome.autoCheck.passed,
      },
    });
    return c.json({ id: def.id, patientId, step: 'freeform', ...outcome });
  });

  app.post('/api/demo/engine-tests/:id/verdict', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const def = engineTestDef(c.req.param('id'));
    if (def === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const body = await readJson(c, EngineTestVerdictSchema);
    const { clinic } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'engine_test_verdict',
      entityType: 'engine_test',
      entityId: def.id,
      ...(body.patientId === undefined ? {} : { patientId: toPatientId(body.patientId) }),
      payload: {
        scenarioId: def.id,
        verdict: body.verdict,
        autoCheckPassed: body.autoCheckPassed,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
      },
    });
    c.var.log.info(
      { actor: actorId(c), scenarioId: def.id, verdict: body.verdict },
      'engine test verdict',
    );
    return c.json({ id: def.id, verdict: body.verdict }, 201);
  });
}
