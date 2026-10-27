import {
  ACTIVE_CASE_STATUSES,
  type CaseEventActor,
  type CaseFeedback,
  type CaseId,
  type CaseStatus,
  type ClinicId,
  EXPECTATION_LAYERS,
  type ExpectationLayer,
  type FollowUpCase,
  isActiveCaseStatus,
  parseConditionId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { conditionView, InboxPresenter } from '../inbox/presenter.ts';
import { humanName, patientSummary } from '../inbox/fhir-display.ts';
import { invalidTransitionMessage } from '../inbox/labels.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound, readJson, readQuery } from './errors.ts';
import {
  CaseActionRequestSchema,
  CaseListQuerySchema,
  FeedbackRequestSchema,
  type InboxStats,
  type OwnerView,
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

/**
 * "Pedir contacto": `patient_contact.requested` to the host, then the case is
 * marked notified. The team's note goes with the contact request.
 */
async function requestContact(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  current: FollowUpCase,
  user: CaseEventActor,
  note: string | undefined,
): Promise<FollowUpCase> {
  if (!isActiveCaseStatus(current.status)) {
    throw new HttpError(
      409,
      'invalid_transition',
      invalidTransitionMessage(current.status, 'notified', 'pedir contacto para'),
    );
  }
  const caseId = current.id;
  const requested = await runtime.engine.cases.requestPatientContact(clinicId, caseId, user, note);
  return requested.status === 'open' || requested.status === 'snoozed'
    ? runtime.engine.cases.notify(clinicId, caseId, user)
    : requested;
}

type ListQuery = Omit<
  Parameters<EngineRuntime['storage']['stores']['cases']['list']>[1],
  'limit' | 'cursor'
>;

/** The latest verdict of each case: changing one's mind replaces the verdict, it does not add one. */
export function latestVerdicts(feedback: readonly CaseFeedback[]): CaseFeedback[] {
  const byCase = new Map<string, CaseFeedback>();
  for (const item of feedback) {
    const previous = byCase.get(item.caseId);
    if (previous === undefined || item.createdAt.getTime() >= previous.createdAt.getTime()) {
      byCase.set(item.caseId, item);
    }
  }
  return [...byCase.values()];
}

function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Upper bound of patients a name search scans when the store's own match finds nothing. */
const SEARCH_SCAN_LIMIT = 2_000;

/** Case order of the inbox: priority (highest first), then oldest first. */
function byPriority(left: FollowUpCase, right: FollowUpCase): number {
  return (
    right.priority - left.priority ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function byCreatedAt(left: FollowUpCase, right: FollowUpCase): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

/** Every case matching a query, across pages (stats, recovery). */
async function listAll(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  query: ListQuery,
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

  /**
   * Cases of a patient search (`q`): the cases of every patient whose name
   * or id matches, merged in inbox order and paged by offset.
   */
  async function searchCases(
    clinicId: ClinicId,
    base: ListQuery,
    search: string,
    page: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<{ items: FollowUpCase[]; total: number; nextCursor?: string }> {
    // Every word must appear in the name or id, ignoring case and accents
    // ("maria lopez" finds "María de los Ángeles López"). The store narrows
    // by the longest word; when its own match (accent sensitive in
    // Postgres) finds nothing, a bounded scan decides.
    const words = normalized(search).split(/\s+/).filter(Boolean);
    const longest = [...search.split(/\s+/)].sort((a, b) => b.length - a.length)[0] ?? search;
    const matches = (record: { id: string; resource: Parameters<typeof humanName>[0] }) => {
      const haystack = normalized(`${record.id} ${humanName(record.resource) ?? ''}`);
      return words.every((word) => haystack.includes(word));
    };
    let patients = (
      await readModel.searchPatients(clinicId, { query: longest, limit: SEARCH_SCAN_LIMIT })
    ).filter(matches);
    if (patients.length === 0) {
      patients = (await readModel.searchPatients(clinicId, { limit: SEARCH_SCAN_LIMIT })).filter(
        matches,
      );
    }
    const ids = patients
      .map((record) => toPatientId(record.id))
      .filter((id) => base.patientId === undefined || id === base.patientId);
    const found: FollowUpCase[] = [];
    for (const patientId of ids) {
      found.push(...(await listAll(runtime, clinicId, { ...base, patientId })));
    }
    found.sort(base.orderBy === 'created_at' ? byCreatedAt : byPriority);
    const offset = Number(page.cursor ?? '0');
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const next = start + page.limit;
    return {
      items: found.slice(start, next),
      total: found.length,
      ...(next < found.length ? { nextCursor: String(next) } : {}),
    };
  }

  app.get('/api/inbox/cases', async (c) => {
    const query = readQuery(c, CaseListQuerySchema);
    const clinicId = c.var.clinicId;
    const presenter = await InboxPresenter.create(runtime, clinicId);
    const statuses =
      query.view === 'active'
        ? ACTIVE_CASE_STATUSES
        : query.view === 'closed'
          ? CLOSED_STATUSES
          : undefined;
    const base: ListQuery = {
      ...(statuses === undefined ? {} : { statuses }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      ...(query.assignee === undefined || query.assignee === ''
        ? {}
        : { assignee: query.assignee }),
      ...(query.patient === undefined || query.patient === ''
        ? {}
        : { patientId: toPatientId(query.patient) }),
      releasedAsOf: presenter.now,
      orderBy: query.view === 'closed' ? 'created_at' : 'priority',
    };
    if (query.q !== undefined && query.q !== '') {
      const found = await searchCases(clinicId, base, query.q, query);
      return c.json({ ...found, items: await presenter.caseViews(found.items) });
    }
    // The total counts the whole view (the list header and the sidebar agree);
    // pages follow the store's keyset cursor.
    const [page, total] = await Promise.all([
      stores.cases.list(clinicId, {
        ...base,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
      listAll(runtime, clinicId, base).then((all) => all.length),
    ]);
    return c.json({
      items: await presenter.caseViews(page.items),
      total,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  /** Who owns the cases of the inbox, by id, for the "Responsable" filter. */
  app.get('/api/inbox/owners', async (c) => {
    const clinicId = c.var.clinicId;
    const presenter = await InboxPresenter.create(runtime, clinicId);
    const released = await listAll(runtime, clinicId, { releasedAsOf: presenter.now });
    const active = new Map<string, number>();
    for (const item of released) {
      if (item.assignee !== undefined) {
        const count = isActiveCaseStatus(item.status) ? 1 : 0;
        active.set(item.assignee, (active.get(item.assignee) ?? 0) + count);
      }
    }
    const items: OwnerView[] = await Promise.all(
      [...active.entries()].map(async ([id, activeCases]) => ({
        id,
        name: await presenter.personName(id),
        activeCases,
      })),
    );
    items.sort((left, right) => left.name.localeCompare(right.name, 'es'));
    return c.json({ items });
  });

  app.get('/api/inbox/cases/:id', async (c) => {
    const followUpCase = await requireCase(runtime, c.var.clinicId, c.req.param('id'));
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    return c.json(await presenter.caseDetail(followUpCase));
  });

  app.post('/api/inbox/cases/:id/actions', async (c) => {
    const body = await readJson(c, CaseActionRequestSchema);
    const caseId = c.req.param('id') as CaseId;
    const current = await requireCase(runtime, c.var.clinicId, caseId);
    const now = runtime.clock.now();
    const user = actor(c);
    const note = body.note?.trim() === '' ? undefined : body.note?.trim();
    const withNote = note === undefined ? {} : { note };
    // "Pedir contacto" asks the host to reach the patient (the engine checks
    // the clinic's settings, opt-out and contact window), then marks the case
    // as notified; the other actions are plain case transitions. Every action
    // keeps the team's internal note on its case event.
    const updated =
      body.action === 'notify'
        ? await requestContact(runtime, c.var.clinicId, current, user, note)
        : await engine.cases.apply(
            c.var.clinicId,
            caseId,
            body.action === 'snooze'
              ? {
                  type: 'snooze',
                  until: new Date(now.getTime() + (body.snoozeDays ?? 1) * MS_PER_DAY),
                  ...withNote,
                }
              : { type: body.action, ...withNote },
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
    if (!body.useful && body.reason === undefined) {
      throw new HttpError(
        422,
        'validation_error',
        'Elige un motivo cuando el caso no fue útil: así podemos mejorar la regla.',
      );
    }
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
    // One verdict per case, the latest: changing one's mind does not count twice.
    const verdicts = latestVerdicts(feedback);
    const useful = verdicts.filter((item) => item.useful).length;
    const stats: InboxStats = {
      activeCases: active.length,
      byLayer,
      byStatus,
      feedback: {
        total: verdicts.length,
        usefulRate: verdicts.length === 0 ? 0 : useful / verdicts.length,
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
