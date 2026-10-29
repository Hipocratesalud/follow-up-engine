import { patientId as toPatientId } from '@follow-up-engine/core';
import {
  ensureLabClinicAndClock,
  type EngineRuntime,
  type LabClockRegistry,
  setLabClinicDate,
} from '@follow-up-engine/runtime';
import { ENGINE_TESTS, engineTestDef } from './engine-tests-catalog.ts';
import { EngineTestVerdictSchema } from './engine-tests-schemas.ts';
import { runScenario } from './engine-tests-scenarios.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { HttpError, readJson } from './errors.ts';
import { requireEvaluator } from './lab-records-routes.ts';
import { actorId } from './security.ts';
import type { App } from './context.ts';

const VERDICT_EVENTS_LIMIT = 2_000;

/**
 * The guided "Engine tests" page (docs/deploy.md#engine-tests): a
 * non-technical physician verifies, one card at a time, each behavior of
 * the MVP, against the real engine in their own lab clinic (never faked).
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
        reviewed: reviewed.has(test.id),
      })),
      progress: { reviewed: reviewed.size, total: ENGINE_TESTS.length },
    });
  });

  app.post('/api/demo/engine-tests/:id/run', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const def = engineTestDef(c.req.param('id'));
    if (def === undefined) {
      throw new HttpError(404, 'not_found', c.var.t.errors.notFound);
    }
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const result = await runScenario(def, {
      runtime,
      clinicId: clinic.id,
      clock,
      evaluatorEmail,
      t: c.var.t,
      advanceTo: async (target) => {
        await setLabClinicDate(runtime, clock, clinic.id, target);
      },
    });
    c.var.log.info(
      { actor: actorId(c), scenarioId: def.id, passed: result.autoCheck.passed },
      'engine test run',
    );
    return c.json({ id: def.id, ...result });
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
