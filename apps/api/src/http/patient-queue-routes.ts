import {
  ACTIVE_CASE_STATUSES,
  type CaseFilter,
  type CaseStatus,
  type ClinicId,
  type ExpectationId,
  NotFoundError,
  type PatientId,
  patientId as toPatientId,
  type PlanItemCorrection,
  PlanItemReviewConflictError,
  type PlanItemReviewResult,
  ValidationError,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { humanName } from '../inbox/fhir-display.ts';
import { patientQueueLabels } from '../inbox/patient-queue-labels.ts';
import { patientQueueItem, patientQueueItems } from '../inbox/patient-queue-presenter.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, readJson, readQuery } from './errors.ts';
import {
  type PatientQueueItem,
  PatientContactRequestSchema,
  PatientQueueQuerySchema,
  type PlanItemReviewResponse,
} from './patient-queue-schemas.ts';
import { PlanItemCorrectionRequestSchema } from './plan-item-schemas.ts';
import { followUpUser } from './security.ts';

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
  return followUpUser(c) ?? 'inbox-user';
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

/** A command on a plan item, with the engine's refusals in the clinic's words. */
async function reviewPlanItem(
  command: () => Promise<PlanItemReviewResult>,
): Promise<PlanItemReviewResult> {
  const { messages } = patientQueueLabels();
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

/**
 * The patient queue (HIP-141): the inbox's one card per patient, all their
 * reasons grouped, over the engine's per-reason cases; and the review of the
 * plan items the AI read. Every query and command is scoped to the
 * authenticated clinic.
 */
export function registerPatientQueueRoutes(app: App, runtime: EngineRuntime): void {
  const { stores } = runtime.storage;
  const { engine } = runtime;

  /** Every case of the patient released to the inbox: active ones, then the latest closed ones. */
  async function patientCard(clinicId: ClinicId, patientId: PatientId): Promise<PatientQueueItem> {
    const presenter = await InboxPresenter.create(runtime, clinicId);
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
      throw new HttpError(404, 'not_found', patientQueueLabels().messages.noActiveCases);
    }
    return patientQueueItem(await presenter.caseViews(cases));
  }

  app.get('/api/inbox/patients-queue', async (c) => {
    const query = readQuery(c, PatientQueueQuerySchema);
    const clinicId = c.var.clinicId;
    const presenter = await InboxPresenter.create(runtime, clinicId);
    const statuses =
      query.view === 'active'
        ? ACTIVE_CASE_STATUSES
        : query.view === 'closed'
          ? CLOSED_STATUSES
          : undefined;
    const filter: CaseFilter = {
      ...(statuses === undefined ? {} : { statuses }),
      ...(query.origin === undefined ? {} : { origin: query.origin }),
      ...(query.assignee === undefined || query.assignee === ''
        ? {}
        : { assignee: query.assignee }),
      ...(query.q === undefined || query.q === ''
        ? {}
        : { patientIds: await searchPatientIds(runtime, clinicId, query.q) }),
      releasedAsOf: presenter.now,
    };
    const [page, count] = await Promise.all([
      stores.cases.listPatients(clinicId, {
        ...filter,
        orderBy: query.view === 'closed' ? 'created_at' : 'priority',
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
      stores.cases.count(clinicId, filter),
    ]);
    return c.json({
      items: await patientQueueItems(presenter, page.items),
      total: count.patients,
      totalCases: count.cases,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  app.get('/api/inbox/patients-queue/:patientId', async (c) =>
    c.json(await patientCard(c.var.clinicId, toPatientId(c.req.param('patientId')))),
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
          ? new HttpError(404, 'not_found', patientQueueLabels().messages.noActiveCases)
          : error;
      });
    c.var.log.info(
      { primaryCaseId: result.primaryCaseId, cases: result.cases.length },
      'patient contact requested',
    );
    return c.json(await patientCard(c.var.clinicId, patientId));
  });

  async function reviewResponse(
    clinicId: ClinicId,
    result: PlanItemReviewResult,
  ): Promise<PlanItemReviewResponse> {
    const presenter = await InboxPresenter.create(runtime, clinicId);
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
    const result = await reviewPlanItem(() =>
      engine.planItems.confirm(c.var.clinicId, id, userId(c)),
    );
    c.var.log.info({ expectationId: id }, 'plan item confirmed');
    return c.json(await reviewResponse(c.var.clinicId, result));
  });

  app.post('/api/inbox/plan-items/:expectationId/correct', async (c) => {
    const body = await readJson(c, PlanItemCorrectionRequestSchema);
    const id = c.req.param('expectationId') as ExpectationId;
    const correction: PlanItemCorrection = {
      ...(body.dueDate === undefined ? {} : { dueAt: new Date(`${body.dueDate}T12:00:00.000Z`) }),
      ...(body.kind === undefined ? {} : { kind: body.kind }),
    };
    const result = await reviewPlanItem(() =>
      engine.planItems.correct(c.var.clinicId, id, correction, userId(c)),
    );
    c.var.log.info(
      { expectationId: id, replacementId: result.replacement?.id },
      'plan item corrected',
    );
    return c.json(await reviewResponse(c.var.clinicId, result));
  });

  app.post('/api/inbox/plan-items/:expectationId/reject', async (c) => {
    const id = c.req.param('expectationId') as ExpectationId;
    const result = await reviewPlanItem(() =>
      engine.planItems.reject(c.var.clinicId, id, userId(c)),
    );
    c.var.log.info(
      { expectationId: id, casesResolved: result.casesResolved.length },
      'plan item rejected',
    );
    return c.json(await reviewResponse(c.var.clinicId, result));
  });
}
