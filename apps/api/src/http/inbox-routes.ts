import {
  ACTIVE_CASE_STATUSES,
  type CaseEventActor,
  type CaseId,
  type CaseStatus,
  type ClinicId,
  EXPECTATION_LAYERS,
  type ExpectationLayer,
  type FollowUpCase,
  parseConditionId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { conditionView, InboxPresenter, assigneeIdFromLabel } from '../inbox/presenter.ts';
import { patientSummary } from '../inbox/fhir-display.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound, readJson, readQuery } from './errors.ts';
import {
  CaseActionRequestSchema,
  CaseListQuerySchema,
  FeedbackRequestSchema,
  type InboxStats,
  PageQuerySchema,
  PatientSearchQuerySchema,
} from './schemas.ts';

const CLOSED_STATUSES: readonly CaseStatus[] = ['resolved', 'dismissed', 'lost_to_follow_up'];
const MS_PER_DAY = 86_400_000;

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The clinic user acting, from the host (`X-FollowUp-User`), for the audit trail. */
function actor(c: Context<AppEnv>): CaseEventActor & { readonly id: string } {
  const id = c.req.header('x-followup-user')?.trim();
  return { type: 'user', id: id === undefined || id === '' ? 'inbox-user' : id.slice(0, 120) };
}

async function requireCase(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  id: string,
): Promise<FollowUpCase> {
  const found = await runtime.storage.stores.cases.get(clinicId, id as CaseId);
  if (found === undefined) {
    throw notFound('No encontramos ese caso.');
  }
  return found;
}

/** "Pedir contacto": `patient_contact.requested` to the host, then the case is marked notified. */
async function requestContact(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  caseId: CaseId,
  user: CaseEventActor,
): Promise<FollowUpCase> {
  const requested = await runtime.engine.cases.requestPatientContact(clinicId, caseId, user);
  return requested.status === 'open' || requested.status === 'snoozed'
    ? runtime.engine.cases.notify(clinicId, caseId, user)
    : requested;
}

/** Every case matching a query, across pages (stats, recovery). */
async function listAll(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  query: Omit<
    Parameters<EngineRuntime['storage']['stores']['cases']['list']>[1],
    'limit' | 'cursor'
  >,
): Promise<FollowUpCase[]> {
  const items: FollowUpCase[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.storage.stores.cases.list(clinicId, {
      ...query,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

/**
 * The clinic inbox JSON API (`/api/inbox`), per the contract the UI in
 * `apps/inbox` consumes. Labels are Spanish and built from the engine's
 * catalog; every query and command is scoped to the authenticated clinic.
 */
export function registerInboxRoutes(app: App, runtime: EngineRuntime): void {
  const { stores, readModel } = runtime.storage;
  const { engine } = runtime;

  app.get('/api/inbox/clinic', (c) => c.json({ id: c.var.clinic.id, name: c.var.clinic.name }));

  app.get('/api/inbox/cases', async (c) => {
    const query = readQuery(c, CaseListQuerySchema);
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    const statuses =
      query.view === 'active'
        ? ACTIVE_CASE_STATUSES
        : query.view === 'closed'
          ? CLOSED_STATUSES
          : undefined;
    const page = await stores.cases.list(c.var.clinicId, {
      ...(statuses === undefined ? {} : { statuses }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      ...(query.assignee === undefined || query.assignee === ''
        ? {}
        : { assignee: assigneeIdFromLabel(query.assignee) }),
      releasedAsOf: presenter.now,
      orderBy: query.view === 'closed' ? 'created_at' : 'priority',
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
    return c.json({
      items: await presenter.caseViews(page.items),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  app.get('/api/inbox/cases/:id', async (c) => {
    const followUpCase = await requireCase(runtime, c.var.clinicId, c.req.param('id'));
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    return c.json(await presenter.caseDetail(followUpCase));
  });

  app.post('/api/inbox/cases/:id/actions', async (c) => {
    const body = await readJson(c, CaseActionRequestSchema);
    const caseId = c.req.param('id') as CaseId;
    await requireCase(runtime, c.var.clinicId, caseId);
    const now = runtime.clock.now();
    const user = actor(c);
    // "Pedir contacto" asks the host to reach the patient (the engine checks
    // the clinic's settings, opt-out and contact window), then marks the case
    // as notified; the other actions are plain case transitions.
    const updated =
      body.action === 'notify'
        ? await requestContact(runtime, c.var.clinicId, caseId, user)
        : await engine.cases.apply(
            c.var.clinicId,
            caseId,
            body.action === 'snooze'
              ? {
                  type: 'snooze',
                  until: new Date(now.getTime() + (body.snoozeDays ?? 1) * MS_PER_DAY),
                }
              : { type: body.action, ...(body.note === undefined ? {} : { note: body.note }) },
            user,
          );
    c.var.log.info({ caseId, action: body.action, status: updated.status }, 'case action');
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    return c.json(await presenter.caseDetail(updated));
  });

  app.post('/api/inbox/cases/:id/feedback', async (c) => {
    const body = await readJson(c, FeedbackRequestSchema);
    const caseId = c.req.param('id') as CaseId;
    await requireCase(runtime, c.var.clinicId, caseId);
    await engine.cases.recordFeedback(c.var.clinicId, caseId, {
      useful: body.useful,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.comment === undefined || body.comment === '' ? {} : { comment: body.comment }),
      authorId: actor(c).id,
    });
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    return c.json(await presenter.caseDetail(await requireCase(runtime, c.var.clinicId, caseId)));
  });

  app.get('/api/inbox/patients', async (c) => {
    const query = readQuery(c, PatientSearchQuerySchema);
    const now = runtime.clock.now();
    const records = await readModel.searchPatients(c.var.clinicId, {
      limit: query.limit,
      ...(query.query === undefined ? {} : { query: query.query }),
    });
    return c.json({
      items: records.map((record) => {
        const summary = patientSummary(record.id, record.resource, now);
        return {
          id: summary.id,
          name: summary.name,
          ...(summary.age === undefined ? {} : { age: summary.age }),
          ...(summary.sex === undefined ? {} : { sex: summary.sex }),
        };
      }),
    });
  });

  app.get('/api/inbox/patients/:id', async (c) => {
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    const detail = await presenter.patientDetail(toPatientId(c.req.param('id')));
    if (detail === undefined) {
      throw notFound('No encontramos ese paciente.');
    }
    return c.json(detail);
  });

  for (const command of ['confirm', 'reject'] as const) {
    app.post(`/api/inbox/conditions/:id/${command}`, async (c) => {
      const parsed = parseConditionId(c.req.param('id'));
      if (parsed === undefined) {
        throw new HttpError(400, 'invalid_identifier', 'Identificador de condición no válido.');
      }
      const user = actor(c).id;
      const condition =
        command === 'confirm'
          ? await engine.conditions.confirm(c.var.clinicId, parsed.patientId, parsed.code, user)
          : (await engine.conditions.reject(c.var.clinicId, parsed.patientId, parsed.code, user))
              .condition;
      c.var.log.info({ command, code: parsed.code.code }, 'condition reviewed');
      return c.json(conditionView(condition));
    });
  }

  app.get('/api/inbox/recovery', async (c) => {
    const query = readQuery(c, PageQuerySchema);
    const now = runtime.clock.now();
    const pending = await listAll(runtime, c.var.clinicId, {
      statuses: ACTIVE_CASE_STATUSES,
      origin: 'backfill',
      unreleasedAsOf: now,
      orderBy: 'priority',
    });
    const offset = Number(query.cursor ?? '0');
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const slice = pending.slice(start, start + query.limit);
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    const next = start + query.limit;
    return c.json({
      items: await presenter.caseViews(slice),
      total: pending.length,
      ...(next < pending.length ? { nextCursor: String(next) } : {}),
    });
  });

  app.get('/api/inbox/stats', async (c) => {
    const clinicId = c.var.clinicId;
    const now = runtime.clock.now();
    const presenter = await InboxPresenter.create(runtime, clinicId);
    const [active, feedback, usage] = await Promise.all([
      listAll(runtime, clinicId, { statuses: ACTIVE_CASE_STATUSES, releasedAsOf: now }),
      stores.feedback.listSince(clinicId, new Date(0), 100_000),
      runtime.storage.llmUsage.summary(clinicId, startOfUtcMonth(now)),
    ]);
    await presenter.prefetch(active);
    const byLayer = Object.fromEntries(EXPECTATION_LAYERS.map((layer) => [layer, 0])) as Record<
      ExpectationLayer,
      number
    >;
    const byStatus: Record<string, number> = {};
    for (const item of active) {
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      for (const layer of new Set(presenter.expectationsOf(item).map((e) => e.layer))) {
        byLayer[layer] += 1;
      }
    }
    const useful = feedback.filter((item) => item.useful).length;
    const stats: InboxStats = {
      activeCases: active.length,
      byLayer,
      byStatus,
      feedback: {
        total: feedback.length,
        usefulRate: feedback.length === 0 ? 0 : useful / feedback.length,
      },
      llm: {
        monthCostUsd: Number(usage.costUsd.toFixed(6)),
        calls: usage.calls,
        avgCostPerNoteUsd:
          usage.successfulCalls === 0
            ? 0
            : Number((usage.costUsd / usage.successfulCalls).toFixed(6)),
        provider: runtime.extractor.provider,
        model: runtime.extractor.model,
      },
    };
    return c.json(stats);
  });
}
