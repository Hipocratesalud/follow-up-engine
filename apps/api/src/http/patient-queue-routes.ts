import {
  ACTIVE_CASE_STATUSES,
  type CaseFilter,
  type CaseStatus,
  type ClinicId,
  EXPECTATION_LAYERS,
  type ExpectationId,
  InvalidCursorError,
  NotFoundError,
  type PatientCases,
  type PatientId,
  patientId as toPatientId,
  type PlanItemCorrection,
  PlanItemReviewConflictError,
  type PlanItemReviewResult,
  ValidationError,
} from '@follow-up-engine/core';
import type { EngineRuntime, EvaluatorAction } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { humanName } from '../inbox/fhir-display.ts';
import { patientQueueItem, patientQueueItems } from '../inbox/patient-queue-presenter.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import type { ApiMessages } from '../i18n/index.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, readJson, readQuery } from './errors.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import {
  type PatientQueueItem,
  type PatientQueueQuery,
  PatientContactRequestSchema,
  PatientQueueQuerySchema,
  type PlanItemReviewResponse,
} from './patient-queue-schemas.ts';
import { PlanItemCorrectionRequestSchema } from './plan-item-schemas.ts';
import { actorId } from './security.ts';

const CLOSED_STATUSES: readonly CaseStatus[] = ['resolved', 'dismissed', 'lost_to_follow_up'];
/** Closed cases a patient card keeps for context, newest first. */
const CLOSED_CASES_SHOWN = 20;
/** Upper bound of patients a name search scans when the store's own match finds nothing. */
const SEARCH_SCAN_LIMIT = 2_000;

function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function userId(c: Context<AppEnv>): string {
  return actorId(c);
}

/**
 * The patients a name search finds: every word must appear in the name or
 * the id, ignoring case and accents ("maria lopez" finds "María de los
 * Ángeles López"). The store narrows by the longest word; when its own
 * match (accent sensitive in Postgres) finds nothing, a bounded scan decides.
 */
async function searchPatientIds(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  search: string,
): Promise<PatientId[]> {
  const { readModel } = runtime.storage;
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
  return patients.map((record) => toPatientId(record.id));
}

/** Patients fetched per store round trip while scanning every match of the base filter. */
const SCAN_PAGE_SIZE = 200;

/**
 * Every patient and their cases matching the base filter (view, origin,
 * assignee, search), across every store page: the universe the `layer` and
 * `protocol` filters and the facet counts are computed over, in memory.
 */
async function listAllPatients(
  runtime: EngineRuntime,
  clinicId: ClinicId,
  filter: CaseFilter,
  orderBy: 'priority' | 'created_at',
): Promise<PatientCases[]> {
  const { stores } = runtime.storage;
  const items: PatientCases[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.cases.listPatients(clinicId, {
      ...filter,
      orderBy,
      limit: SCAN_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

/** `selected` is absent (no filter), or `present` has one of its values (OR within one filter). */
function matchesAny(selected: readonly string[] | undefined, present: readonly string[]): boolean {
  return selected === undefined || present.some((value) => selected.includes(value));
}

/** The offset a patient queue page cursor carries, once the in-memory filters narrow the match set. */
function offsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d{1,9}$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  return Number(cursor);
}

/** A command on a plan item, with the engine's refusals in the clinic's words. */
async function reviewPlanItem(
  t: ApiMessages,
  command: () => Promise<PlanItemReviewResult>,
): Promise<PlanItemReviewResult> {
  const messages = t.patientQueue;
  try {
    return await command();
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new HttpError(404, 'not_found', messages.planItemNotFound);
    }
    if (error instanceof PlanItemReviewConflictError) {
      throw new HttpError(
        409,
        'conflict',
        error.reason === 'already_reviewed' ? messages.alreadyReviewed : messages.planItemClosed,
      );
    }
    if (error instanceof ValidationError && error.field !== 'userId') {
      const message =
        error.field === 'layer'
          ? messages.notAPlanItem
          : error.field === 'kind'
            ? messages.invalidKind
            : error.field === 'dueAt'
              ? messages.invalidDueDate
              : messages.nothingToCorrect;
      throw new HttpError(422, 'invalid_request', message, [
        { path: error.field === 'layer' ? 'expectationId' : error.field, message },
      ]);
    }
    throw error;
  }
}

/** The filters of the patient queue that narrow who is listed (no view paging). */
export type PatientQueueFilters = {
  readonly [Key in 'view' | 'origin' | 'assignee' | 'q' | 'layer' | 'protocol']?:
    PatientQueueQuery[Key] | undefined;
};

/**
 * Every patient of the queue matching its filters (view, origin, owner,
 * search, then reason type and condition), with their cards: what the list
 * pages over, and what the inbox's finding cards follow when filtered.
 */
export async function queueEntries(
  runtime: EngineRuntime,
  t: ApiMessages,
  clinicId: ClinicId,
  query: PatientQueueFilters,
): Promise<{
  readonly presenter: InboxPresenter;
  readonly entries: readonly { readonly item: PatientQueueItem; readonly cases: number }[];
  readonly matching: readonly { readonly item: PatientQueueItem; readonly cases: number }[];
}> {
  const presenter = await InboxPresenter.create(runtime, clinicId, t);
  const view = query.view ?? 'active';
  const statuses =
    view === 'active' ? ACTIVE_CASE_STATUSES : view === 'closed' ? CLOSED_STATUSES : undefined;
  const filter: CaseFilter = {
    ...(statuses === undefined ? {} : { statuses }),
    ...(query.origin === undefined ? {} : { origin: query.origin }),
    ...(query.assignee === undefined || query.assignee === '' ? {} : { assignee: query.assignee }),
    ...(query.q === undefined || query.q === ''
      ? {}
      : { patientIds: await searchPatientIds(runtime, clinicId, query.q) }),
    releasedAsOf: presenter.now,
  };
  const orderBy = view === 'closed' ? 'created_at' : 'priority';
  const allPatients = await listAllPatients(runtime, clinicId, filter, orderBy);
  const allItems = await patientQueueItems(presenter, allPatients);
  const entries = allItems.map((item, index) => ({
    item,
    cases: allPatients[index]?.cases.length ?? 0,
  }));
  const matching = entries.filter(
    (entry) =>
      matchesAny(query.layer, entry.item.layers) &&
      matchesAny(
        query.protocol,
        entry.item.protocols.map((protocol) => protocol.id),
      ),
  );
  return { presenter, entries, matching };
}

/**
 * The patient queue (HIP-141): the inbox's one card per patient, all their
 * reasons grouped, over the engine's per-reason cases; and the review of the
 * plan items the AI read. Every query and command is scoped to the
 * authenticated clinic.
 */
export function registerPatientQueueRoutes(app: App, runtime: EngineRuntime): void {
  const { stores } = runtime.storage;
  const { engine } = runtime;

  /** Evaluator lab tracking (migration 0016): a no-op outside the hosted demo. */
  function track(
    c: Context<AppEnv>,
    action: EvaluatorAction,
    extra: {
      readonly entityType?: string;
      readonly entityId?: string;
      readonly patientId?: PatientId;
      readonly payload?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const evaluatorEmail = c.var.evaluatorEmail;
    if (evaluatorEmail === undefined) {
      return Promise.resolve();
    }
    return trackEvaluatorEvent(runtime, {
      clinicId: c.var.clinicId,
      evaluatorEmail,
      action,
      ...extra,
    });
  }

  /** Every case of the patient released to the inbox: active ones, then the latest closed ones. */
  async function patientCard(
    t: ApiMessages,
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<PatientQueueItem> {
    const presenter = await InboxPresenter.create(runtime, clinicId, t);
    const base: CaseFilter = { patientIds: [patientId], releasedAsOf: presenter.now };
    const [active, closed] = await Promise.all([
      stores.cases.listPatients(clinicId, { ...base, statuses: ACTIVE_CASE_STATUSES, limit: 1 }),
      stores.cases.list(clinicId, {
        patientId,
        releasedAsOf: presenter.now,
        statuses: CLOSED_STATUSES,
        orderBy: 'created_at',
        limit: 500,
      }),
    ]);
    const cases = [
      ...(active.items[0]?.cases ?? []),
      ...[...closed.items].reverse().slice(0, CLOSED_CASES_SHOWN),
    ];
    if (cases.length === 0) {
      throw new HttpError(404, 'not_found', t.patientQueue.noActiveCases);
    }
    return patientQueueItem(await presenter.caseViews(cases));
  }

  app.get('/api/inbox/patients-queue', async (c) => {
    const query = readQuery(c, PatientQueueQuerySchema);
    const clinicId = c.var.clinicId;
    const [{ entries, matching, presenter }, liveFindings] = await Promise.all([
      queueEntries(runtime, c.var.t, clinicId, query),
      runtime.reviewer.listInboxFindings(clinicId, { limit: 0 }),
    ]);
    const matchesLayer = (item: PatientQueueItem): boolean => matchesAny(query.layer, item.layers);
    const matchesProtocol = (item: PatientQueueItem): boolean =>
      matchesAny(
        query.protocol,
        item.protocols.map((protocol) => protocol.id),
      );
    const layers = EXPECTATION_LAYERS.map((layer) => ({
      layer,
      label: c.var.t.layerLabels[layer],
      count: entries.filter(
        (entry) => matchesProtocol(entry.item) && entry.item.layers.includes(layer),
      ).length,
    }));
    const protocols = presenter.protocols.map((protocol) => ({
      id: protocol.id,
      label: presenter.ruleText(protocol.reason.code, protocol.reason.label),
      count: entries.filter(
        (entry) =>
          matchesLayer(entry.item) && entry.item.protocols.some((ref) => ref.id === protocol.id),
      ).length,
    }));
    // A patient's live finding cards are their own cards (/api/inbox/live-findings):
    // the follow-up card only carries how many, so both views stay one per patient.
    const withFindings = (item: PatientQueueItem): PatientQueueItem => {
      const count = liveFindings.byPatient[item.patient.id] ?? 0;
      return count === 0 ? item : { ...item, liveFindings: count };
    };
    const offset = offsetCursor(query.cursor);
    const page = matching.slice(offset, offset + query.limit);
    const next = offset + page.length;
    return c.json({
      items: page.map((entry) => withFindings(entry.item)),
      total: matching.length,
      totalCases: matching.reduce((sum, entry) => sum + entry.cases, 0),
      ...(next < matching.length ? { nextCursor: String(next) } : {}),
      facets: { layers, protocols },
    });
  });

  app.get('/api/inbox/patients-queue/:patientId', async (c) =>
    c.json(await patientCard(c.var.t, c.var.clinicId, toPatientId(c.req.param('patientId')))),
  );

  /**
   * "Request contact" on the patient card: one attempt for the patient
   * whatever the number of their cases (one message per contact window).
   */
  app.post('/api/inbox/patients-queue/:patientId/request-contact', async (c) => {
    const body = await readJson(c, PatientContactRequestSchema);
    const patientId = toPatientId(c.req.param('patientId'));
    const note = body.note?.trim() === '' ? undefined : body.note?.trim();
    const result = await engine.cases
      .requestPatientContactForPatient(
        c.var.clinicId,
        patientId,
        { type: 'user', id: userId(c) },
        note,
      )
      .catch((error: unknown) => {
        throw error instanceof NotFoundError
          ? new HttpError(404, 'not_found', c.var.t.patientQueue.noActiveCases)
          : error;
      });
    c.var.log.info(
      { primaryCaseId: result.primaryCaseId, cases: result.cases.length },
      'patient contact requested',
    );
    await track(c, 'case_request_contact', {
      entityType: 'patient',
      entityId: result.primaryCaseId,
      patientId,
    });
    return c.json(await patientCard(c.var.t, c.var.clinicId, patientId));
  });

  async function reviewResponse(
    t: ApiMessages,
    clinicId: ClinicId,
    result: PlanItemReviewResult,
  ): Promise<PlanItemReviewResponse> {
    const presenter = await InboxPresenter.create(runtime, clinicId, t);
    return {
      expectation: await presenter.reviewedExpectationView(result.expectation),
      ...(result.replacement === undefined
        ? {}
        : { replacement: await presenter.reviewedExpectationView(result.replacement) }),
      casesResolved: [...result.casesResolved],
    };
  }

  app.post('/api/inbox/plan-items/:expectationId/confirm', async (c) => {
    const id = c.req.param('expectationId') as ExpectationId;
    const result = await reviewPlanItem(c.var.t, () =>
      engine.planItems.confirm(c.var.clinicId, id, userId(c)),
    );
    c.var.log.info({ expectationId: id }, 'plan item confirmed');
    await track(c, 'plan_item_confirm', {
      entityType: 'plan_item',
      entityId: id,
      patientId: result.expectation.patientId,
    });
    return c.json(await reviewResponse(c.var.t, c.var.clinicId, result));
  });

  app.post('/api/inbox/plan-items/:expectationId/correct', async (c) => {
    const body = await readJson(c, PlanItemCorrectionRequestSchema);
    const id = c.req.param('expectationId') as ExpectationId;
    const correction: PlanItemCorrection = {
      ...(body.dueDate === undefined ? {} : { dueAt: new Date(`${body.dueDate}T12:00:00.000Z`) }),
      ...(body.kind === undefined ? {} : { kind: body.kind }),
    };
    const result = await reviewPlanItem(c.var.t, () =>
      engine.planItems.correct(c.var.clinicId, id, correction, userId(c)),
    );
    c.var.log.info(
      { expectationId: id, replacementId: result.replacement?.id },
      'plan item corrected',
    );
    await track(c, 'plan_item_correct', {
      entityType: 'plan_item',
      entityId: id,
      patientId: result.expectation.patientId,
      payload: {
        ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
        ...(body.kind === undefined ? {} : { kind: body.kind }),
      },
    });
    return c.json(await reviewResponse(c.var.t, c.var.clinicId, result));
  });

  app.post('/api/inbox/plan-items/:expectationId/reject', async (c) => {
    const id = c.req.param('expectationId') as ExpectationId;
    const result = await reviewPlanItem(c.var.t, () =>
      engine.planItems.reject(c.var.clinicId, id, userId(c)),
    );
    c.var.log.info(
      { expectationId: id, casesResolved: result.casesResolved.length },
      'plan item rejected',
    );
    await track(c, 'plan_item_reject', {
      entityType: 'plan_item',
      entityId: id,
      patientId: result.expectation.patientId,
    });
    return c.json(await reviewResponse(c.var.t, c.var.clinicId, result));
  });
}
