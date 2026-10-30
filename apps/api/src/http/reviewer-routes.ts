import {
  type ClinicId,
  type FindingCategory,
  FINDING_VERDICTS,
  type FindingCounts,
  type FindingMode,
  type FindingStatus,
  IMPLEMENTED_FINDING_CATEGORIES,
  NotFoundError,
  type PatientId,
  patientId as toPatientId,
  type ResolvedFlag,
  shadowPilotFlags,
} from '@follow-up-engine/core';
import { clinicalFindingToDetectedIssue } from '@follow-up-engine/fhir';
import {
  DEMO_CLINIC,
  type EngineRuntime,
  ensureLabClinicAndClock,
  type EvaluatorAction,
  isLabClinicId,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { FindingPresenter, runView } from '../inbox/reviewer-presenter.ts';
import type { ApiMessages } from '../i18n/index.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound, readJson, readQuery } from './errors.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { requireEvaluator } from './lab-records-routes.ts';
import { queueEntries } from './patient-queue-routes.ts';
import {
  type FindingFlagView,
  FindingFlagUpdateSchema,
  FindingListQuerySchema,
  FindingReviewRequestSchema,
  type InboxFindingList,
  type InboxFindingQuery,
  InboxFindingQuerySchema,
} from './reviewer-schemas.ts';
import { actorId } from './security.ts';

const MS_PER_DAY = 86_400_000;
/** The metrics window: the last 90 days of reviews. */
const METRICS_DAYS = 90;

function userOf(c: Context<AppEnv>): string {
  return actorId(c);
}

/** Evaluator lab tracking (migration 0016): a no-op outside the hosted demo. */
function track(
  runtime: EngineRuntime,
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

async function requireFinding(
  runtime: EngineRuntime,
  t: ApiMessages,
  clinicId: ClinicId,
  id: string,
) {
  const finding = await runtime.reviewer.getFinding(clinicId, id);
  if (finding === undefined) throw notFound(t, t.reviewer.findingNotFound);
  return finding;
}

function reviewStats(counts: FindingCounts, category: string): FindingFlagView['review'] {
  const perStatus =
    counts.byCategoryStatus[category as keyof FindingCounts['byCategoryStatus']] ?? {};
  const relevant = perStatus.relevant ?? 0;
  const alreadyKnown = perStatus.already_known ?? 0;
  const notRelevant = perStatus.not_relevant ?? 0;
  const reviewed = relevant + alreadyKnown + notRelevant;
  return {
    reviewed,
    relevant,
    alreadyKnown,
    notRelevant,
    ...(reviewed === 0 ? {} : { precision: Math.round((relevant / reviewed) * 1000) / 1000 }),
  };
}

const REVIEWED: readonly FindingStatus[] = FINDING_VERDICTS;

/** What the "Before the visit" panel shows: questions to ask, and abnormal results to flag. */
const BEFORE_VISIT_CATEGORIES: readonly FindingCategory[] = [
  'pre_visit_question',
  'abnormal_result_no_followup',
];

const SEVERITY_ORDER: Readonly<Record<string, number>> = { high: 0, medium: 1, low: 2 };

/**
 * Shadow findings are shown unlabeled-as-live only in the demo clinic and in
 * a lab clinic (the evaluator's sandbox, {@link isLabClinicId}): neither
 * needs the clinical team's sign-off to see its own shadow pilot. Every
 * other clinic sees only validated (`live`) findings here.
 */
function showsShadowFindings(clinicId: ClinicId): boolean {
  return clinicId === DEMO_CLINIC.id || isLabClinicId(clinicId);
}

function flagView(
  t: ApiMessages,
  flag: ResolvedFlag,
  counts: FindingCounts,
  implemented: boolean,
): FindingFlagView {
  return {
    category: flag.category,
    label: t.reviewer.categories[flag.category].label,
    description: t.reviewer.categories[flag.category].description,
    implemented,
    ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
    enabled: flag.enabled,
    mode: flag.mode,
    ...(flag.validatedBy === undefined ? {} : { validatedBy: flag.validatedBy }),
    ...(flag.validatedAt === undefined ? {} : { validatedAt: flag.validatedAt.toISOString() }),
    ...(flag.updatedBy === undefined ? {} : { updatedBy: flag.updatedBy }),
    ...(flag.updatedAt === undefined ? {} : { updatedAt: flag.updatedAt.toISOString() }),
    review: reviewStats(counts, flag.category),
  };
}

async function listFlagViews(
  runtime: EngineRuntime,
  t: ApiMessages,
  clinicId: ClinicId,
): Promise<{ items: FindingFlagView[] }> {
  const [flags, counts] = await Promise.all([
    runtime.reviewer.listFlags(clinicId),
    runtime.reviewer.countFindings(clinicId, { mode: 'shadow' }),
  ]);
  return {
    items: flags.map((flag) =>
      flagView(
        t,
        flag,
        counts,
        (IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(flag.category),
      ),
    ),
  };
}

/**
 * Turns a category on or off, or moves it between shadow and live. Live
 * needs a sign-off: `validatedBy` in the body or one already on record.
 */
async function updateFlagView(
  runtime: EngineRuntime,
  c: Context<AppEnv>,
  clinicId: ClinicId,
  body: {
    readonly category: FindingCategory;
    readonly specialty?: string | null | undefined;
    readonly enabled: boolean;
    readonly mode: FindingMode;
    readonly validatedBy?: string | undefined;
  },
): Promise<FindingFlagView> {
  const t = c.var.t;
  if (
    !(IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(body.category) &&
    body.enabled
  ) {
    throw new HttpError(422, 'invalid_request', t.reviewer.reservedCategory, [
      { path: 'enabled', message: t.reviewer.reservedCategoryField },
    ]);
  }
  const current = (await runtime.reviewer.listFlags(clinicId)).find(
    (flag) => flag.category === body.category && flag.specialty === (body.specialty ?? undefined),
  );
  if (
    body.mode === 'live' &&
    body.validatedBy === undefined &&
    current?.validatedBy === undefined
  ) {
    throw new HttpError(422, 'invalid_request', t.reviewer.signOffRequired, [
      { path: 'validatedBy', message: t.reviewer.signOffRequiredField },
    ]);
  }
  const flag = await runtime.reviewer.updateFlag(
    clinicId,
    {
      category: body.category,
      ...(body.specialty === undefined || body.specialty === null
        ? {}
        : { specialty: body.specialty }),
      enabled: body.enabled,
      mode: body.mode,
      ...(body.validatedBy === undefined ? {} : { validatedBy: body.validatedBy }),
    },
    userOf(c),
  );
  const counts = await runtime.reviewer.countFindings(clinicId, { mode: 'shadow' });
  return flagView(t, flag, counts, true);
}

/** Records a verdict ("not relevant" needs a reason), tracked for an evaluator. */
async function reviewFindingView(
  runtime: EngineRuntime,
  c: Context<AppEnv>,
  clinicId: ClinicId,
  id: string,
  body: {
    readonly verdict: (typeof FINDING_VERDICTS)[number];
    readonly reason?: string | undefined;
  },
) {
  const t = c.var.t;
  await requireFinding(runtime, t, clinicId, id);
  if (body.verdict === 'not_relevant' && (body.reason === undefined || body.reason === '')) {
    throw new HttpError(422, 'invalid_request', t.reviewer.reasonRequired, [
      { path: 'reason', message: t.reviewer.reasonRequiredField },
    ]);
  }
  try {
    const reviewed = await runtime.reviewer.reviewFinding(clinicId, id, {
      verdict: body.verdict,
      ...(body.reason === undefined || body.reason === '' ? {} : { reason: body.reason }),
      userId: userOf(c),
    });
    await track(runtime, c, 'finding_review', {
      entityType: 'finding',
      entityId: id,
      patientId: reviewed.patientId,
      payload: {
        verdict: body.verdict,
        ...(body.reason === undefined || body.reason === '' ? {} : { reason: body.reason }),
      },
    });
    return await new FindingPresenter(runtime, clinicId, t).view(reviewed);
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound(t, t.reviewer.findingNotFound);
    throw error;
  }
}

/**
 * The doctor's inbox cards: the core read model (live, signed-off categories
 * only; today's quota per doctor released, the rest queued), presented, and
 * narrowed to the patients the list shows when its filters are set.
 */
async function inboxFindingList(
  runtime: EngineRuntime,
  t: ApiMessages,
  clinicId: ClinicId,
  query: InboxFindingQuery,
  now?: Date,
): Promise<InboxFindingList> {
  const list = await runtime.reviewer.listInboxFindings(clinicId, {
    ...(query.patientId === undefined ? {} : { patientId: toPatientId(query.patientId) }),
    ...(now === undefined ? {} : { now }),
  });
  const filtered =
    query.view !== undefined ||
    query.origin !== undefined ||
    (query.assignee !== undefined && query.assignee !== '') ||
    (query.q !== undefined && query.q !== '') ||
    query.layer !== undefined ||
    query.protocol !== undefined;
  const shown = filtered
    ? new Set(
        (await queueEntries(runtime, t, clinicId, query)).matching.map(
          (entry) => entry.item.patient.id,
        ),
      )
    : undefined;
  const keep = (patientId: string): boolean => shown === undefined || shown.has(patientId);
  const items = list.items.filter((finding) => keep(finding.patientId));
  const byPatient: Record<string, number> = {};
  for (const finding of items) {
    byPatient[finding.patientId] = (byPatient[finding.patientId] ?? 0) + 1;
  }
  const presenter = new FindingPresenter(runtime, clinicId, t);
  return {
    items: await Promise.all(items.slice(0, query.limit).map((finding) => presenter.view(finding))),
    total: items.length,
    byPatient,
    queued: list.queued.filter((item) => keep(item.patientId)).length,
    dailyCap: list.dailyCap,
  };
}

/**
 * The clinical reviewer's inbox endpoints (PRD V3): the shadow batch
 * review (list, detail with the agent's trace, verdicts), the per-category
 * flags (shadow → live needs a sign-off) and the FHIR export of a finding.
 * Shadow findings are only ever served here, to the clinical staff with an
 * inbox key; `/fhir/DetectedIssue` (the host) and webhooks only see live ones.
 */
export function registerReviewerRoutes(app: App, runtime: EngineRuntime): void {
  app.get('/api/inbox/findings', async (c) => {
    const query = readQuery(c, FindingListQuerySchema);
    const clinicId = c.var.clinicId;
    const statuses: readonly FindingStatus[] | undefined =
      query.status === undefined
        ? undefined
        : query.status === 'reviewed'
          ? REVIEWED
          : [query.status];
    const [page, counts] = await Promise.all([
      runtime.reviewer.listFindings(clinicId, {
        mode: query.mode,
        ...(statuses === undefined ? {} : { statuses }),
        ...(query.category === undefined ? {} : { categories: query.category }),
        ...(query.severity === undefined ? {} : { severities: query.severity }),
        ...(query.patientId === undefined ? {} : { patientId: toPatientId(query.patientId) }),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }),
      runtime.reviewer.countFindings(clinicId, {
        mode: query.mode,
        ...(query.patientId === undefined ? {} : { patientId: toPatientId(query.patientId) }),
      }),
    ]);
    const presenter = new FindingPresenter(runtime, clinicId, c.var.t);
    return c.json({
      items: await Promise.all(page.items.map((finding) => presenter.view(finding))),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      counts: {
        total: counts.total,
        byStatus: counts.byStatus,
        byCategory: counts.byCategory,
        bySeverity: counts.bySeverity,
      },
    });
  });

  app.get('/api/inbox/findings/metrics', async (c) => {
    const clinicId = c.var.clinicId;
    const since = new Date(runtime.clock.now().getTime() - METRICS_DAYS * MS_PER_DAY);
    const [stats, shadow, live] = await Promise.all([
      runtime.reviewer.runStats(clinicId, since),
      runtime.reviewer.countFindings(clinicId, { mode: 'shadow' }),
      runtime.reviewer.countFindings(clinicId, { mode: 'live' }),
    ]);
    const status = (key: FindingStatus): number =>
      (shadow.byStatus[key] ?? 0) + (live.byStatus[key] ?? 0);
    const reviewed = status('relevant') + status('already_known') + status('not_relevant');
    return c.json({
      since: since.toISOString(),
      runs: stats.runs,
      patientsReviewed: stats.patientsReviewed,
      findings: stats.findings,
      findingsPer100Patients:
        stats.patientsReviewed === 0
          ? 0
          : Math.round((stats.findings / stats.patientsReviewed) * 1000) / 10,
      discarded: stats.discarded,
      duplicates: stats.duplicates,
      degraded: stats.degraded,
      avgToolCalls: stats.runs === 0 ? 0 : Math.round((stats.toolCalls / stats.runs) * 10) / 10,
      avgCostUsd: stats.runs === 0 ? 0 : stats.costUsd / stats.runs,
      costUsd: stats.costUsd,
      reviewed,
      relevant: status('relevant'),
      alreadyKnown: status('already_known'),
      ...(reviewed === 0
        ? {}
        : { precision: Math.round((status('relevant') / reviewed) * 1000) / 1000 }),
    });
  });

  app.get('/api/inbox/findings/:id', async (c) => {
    const clinicId = c.var.clinicId;
    const finding = await requireFinding(runtime, c.var.t, clinicId, c.req.param('id'));
    const run = await runtime.reviewer.getRun(clinicId, finding.runId);
    const view = await new FindingPresenter(runtime, clinicId, c.var.t).view(finding);
    return c.json({ ...view, ...(run === undefined ? {} : { run: runView(run) }) });
  });

  app.get('/api/inbox/findings/:id/fhir', async (c) => {
    const finding = await requireFinding(runtime, c.var.t, c.var.clinicId, c.req.param('id'));
    c.header('content-type', 'application/fhir+json; charset=utf-8');
    return c.body(JSON.stringify(clinicalFindingToDetectedIssue(finding)));
  });

  app.post('/api/inbox/findings/:id/review', async (c) => {
    const body = await readJson(c, FindingReviewRequestSchema);
    return c.json(await reviewFindingView(runtime, c, c.var.clinicId, c.req.param('id'), body));
  });

  /**
   * The doctor's inbox cards (PRD V3): open findings of the categories live
   * with a sign-off now. Shadow categories are filtered by the core read
   * model, never only by the UI.
   */
  app.get('/api/inbox/live-findings', async (c) => {
    const query = readQuery(c, InboxFindingQuerySchema);
    return c.json(await inboxFindingList(runtime, c.var.t, c.var.clinicId, query));
  });

  /**
   * "Before the visit": the patient's next appointment and the open
   * questions or abnormal results worth raising then. Shadow findings are
   * included, clearly labeled, only in the demo and lab clinics
   * ({@link showsShadowFindings}); elsewhere only validated ones.
   */
  app.get('/api/inbox/patients/:id/before-visit', async (c) => {
    const clinicId = c.var.clinicId;
    const patientId = toPatientId(c.req.param('id'));
    const patient = await runtime.storage.stores.clinicalRecords.getResource(clinicId, {
      resourceType: 'Patient',
      id: patientId,
    });
    if (patient === undefined) throw notFound(c.var.t, c.var.t.errors.patientNotFound);
    const modes: readonly FindingMode[] = showsShadowFindings(clinicId)
      ? ['shadow', 'live']
      : ['live'];
    const pages = await Promise.all(
      modes.map((mode) =>
        runtime.reviewer.listFindings(clinicId, {
          mode,
          statuses: ['open'],
          categories: BEFORE_VISIT_CATEGORIES,
          patientId,
          limit: 20,
        }),
      ),
    );
    const findings = pages
      .flatMap((page) => page.items)
      .sort(
        (left, right) =>
          (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9) ||
          right.createdAt.getTime() - left.createdAt.getTime(),
      );
    const presenter = new FindingPresenter(runtime, clinicId, c.var.t);
    const [items, nextAppointmentAt] = await Promise.all([
      Promise.all(findings.map((finding) => presenter.view(finding))),
      presenter.nextAppointmentAt(patientId),
    ]);
    return c.json({ ...(nextAppointmentAt === undefined ? {} : { nextAppointmentAt }), items });
  });

  app.get('/api/inbox/finding-flags', async (c) =>
    c.json(await listFlagViews(runtime, c.var.t, c.var.clinicId)),
  );

  app.put('/api/inbox/finding-flags', async (c) => {
    const body = await readJson(c, FindingFlagUpdateSchema);
    return c.json(await updateFlagView(runtime, c, c.var.clinicId, body));
  });
}

/**
 * Demo: review one patient now (the fake clock does not wait for the
 * 10-minute debounce). Only on a fake clock, under the demo routes' scope
 * check (`demo:clock`).
 */
export function registerReviewerDemoRoutes(app: App, runtime: EngineRuntime): void {
  app.post('/api/demo/review/:patientId', async (c) => {
    const clinicId = c.var.clinicId;
    const patientId = toPatientId(c.req.param('patientId'));
    const patient = await runtime.storage.stores.clinicalRecords.getResource(clinicId, {
      resourceType: 'Patient',
      id: patientId,
    });
    if (patient === undefined) throw notFound(c.var.t, c.var.t.reviewer.patientNotFound);
    const report = await runtime.reviewer.reviewPatient(clinicId, patientId, 'manual');
    const presenter = new FindingPresenter(runtime, clinicId, c.var.t);
    return c.json({
      run: runView(report.run),
      findings: await Promise.all(report.findings.map((finding) => presenter.view(finding))),
    });
  });
}

/**
 * The clinical reviewer inside an evaluator's lab clinic (docs/deploy.md#hosted-demo):
 * the same categories, inbox cards and verdicts as `/api/inbox`, scoped to
 * the evaluator's own sandbox so switching a category live there never
 * changes what the shared demo (or another evaluator) sees. The lab starts
 * like a shadow pilot (every implemented category on, in shadow); going
 * live is signed off by the evaluator's own email, whatever the body says.
 */
export function registerReviewerLabRoutes(app: App, runtime: EngineRuntime): void {
  async function labClinic(c: Context<AppEnv>): Promise<{
    readonly clinicId: ClinicId;
    readonly evaluatorEmail: string;
    readonly now: Date;
  }> {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(
      runtime,
      runtime.labClocks,
      evaluatorEmail,
    );
    await runtime.storage.unitOfWork.withTransaction(clinic.id, async (stores) => {
      if ((await stores.findingFlags.list(clinic.id)).length > 0) return;
      for (const flag of shadowPilotFlags(clinic.id, evaluatorEmail, clock.now())) {
        await stores.findingFlags.upsert(clinic.id, flag);
      }
    });
    return { clinicId: clinic.id, evaluatorEmail, now: clock.now() };
  }

  app.get('/api/demo/lab/finding-flags', async (c) => {
    const { clinicId } = await labClinic(c);
    return c.json(await listFlagViews(runtime, c.var.t, clinicId));
  });

  app.put('/api/demo/lab/finding-flags', async (c) => {
    const body = await readJson(c, FindingFlagUpdateSchema);
    const { clinicId, evaluatorEmail } = await labClinic(c);
    // The sign-off in a lab is the evaluator's own email, never a name from the body.
    return c.json(
      await updateFlagView(runtime, c, clinicId, {
        category: body.category,
        ...(body.specialty === undefined ? {} : { specialty: body.specialty }),
        enabled: body.enabled,
        mode: body.mode,
        ...(body.mode === 'live' ? { validatedBy: evaluatorEmail } : {}),
      }),
    );
  });

  app.get('/api/demo/lab/live-findings', async (c) => {
    const query = readQuery(c, InboxFindingQuerySchema);
    const { clinicId, now } = await labClinic(c);
    // The lab's own calendar: its daily cap rolls over on the lab clock.
    return c.json(await inboxFindingList(runtime, c.var.t, clinicId, query, now));
  });

  app.post('/api/demo/lab/findings/:id/review', async (c) => {
    const body = await readJson(c, FindingReviewRequestSchema);
    const { clinicId } = await labClinic(c);
    return c.json(await reviewFindingView(runtime, c, clinicId, c.req.param('id'), body));
  });

  /** "Review this patient now" for a lab patient (no 10-minute debounce, no worker). */
  app.post('/api/demo/lab/patients/:id/review', async (c) => {
    const { clinicId } = await labClinic(c);
    const patientId = toPatientId(c.req.param('id'));
    const patient = await runtime.storage.stores.clinicalRecords.getResource(clinicId, {
      resourceType: 'Patient',
      id: patientId,
    });
    if (patient === undefined) throw notFound(c.var.t, c.var.t.reviewer.patientNotFound);
    const report = await runtime.reviewer.reviewPatient(clinicId, patientId, 'manual');
    const presenter = new FindingPresenter(runtime, clinicId, c.var.t);
    return c.json({
      run: runView(report.run),
      findings: await Promise.all(report.findings.map((finding) => presenter.view(finding))),
    });
  });
}
