import {
  type ClinicId,
  FINDING_VERDICTS,
  type FindingCounts,
  type FindingStatus,
  IMPLEMENTED_FINDING_CATEGORIES,
  NotFoundError,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import { clinicalFindingToDetectedIssue } from '@follow-up-engine/fhir';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { reviewerLabels } from '../inbox/reviewer-labels.ts';
import { FindingPresenter, runView } from '../inbox/reviewer-presenter.ts';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound, readJson, readQuery } from './errors.ts';
import {
  type FindingFlagView,
  FindingFlagUpdateSchema,
  FindingListQuerySchema,
  FindingReviewRequestSchema,
} from './reviewer-schemas.ts';
import { followUpUser } from './security.ts';

const MS_PER_DAY = 86_400_000;
/** The metrics window: the last 90 days of reviews. */
const METRICS_DAYS = 90;

function userOf(c: Context<AppEnv>): string {
  return followUpUser(c) ?? 'inbox-user';
}

async function requireFinding(runtime: EngineRuntime, clinicId: ClinicId, id: string) {
  const finding = await runtime.reviewer.getFinding(clinicId, id);
  if (finding === undefined) throw notFound(reviewerLabels.findingNotFound);
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
    const presenter = new FindingPresenter(runtime, clinicId);
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
    const finding = await requireFinding(runtime, clinicId, c.req.param('id'));
    const run = await runtime.reviewer.getRun(clinicId, finding.runId);
    const view = await new FindingPresenter(runtime, clinicId).view(finding);
    return c.json({ ...view, ...(run === undefined ? {} : { run: runView(run) }) });
  });

  app.get('/api/inbox/findings/:id/fhir', async (c) => {
    const finding = await requireFinding(runtime, c.var.clinicId, c.req.param('id'));
    c.header('content-type', 'application/fhir+json; charset=utf-8');
    return c.body(JSON.stringify(clinicalFindingToDetectedIssue(finding)));
  });

  app.post('/api/inbox/findings/:id/review', async (c) => {
    const clinicId = c.var.clinicId;
    const body = await readJson(c, FindingReviewRequestSchema);
    const id = c.req.param('id');
    await requireFinding(runtime, clinicId, id);
    if (body.verdict === 'not_relevant' && (body.reason === undefined || body.reason === '')) {
      throw new HttpError(422, 'invalid_request', reviewerLabels.reasonRequired, [
        { path: 'reason', message: reviewerLabels.reasonRequiredField },
      ]);
    }
    try {
      const reviewed = await runtime.reviewer.reviewFinding(clinicId, id, {
        verdict: body.verdict,
        ...(body.reason === undefined || body.reason === '' ? {} : { reason: body.reason }),
        userId: userOf(c),
      });
      return c.json(await new FindingPresenter(runtime, clinicId).view(reviewed));
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound(reviewerLabels.findingNotFound);
      throw error;
    }
  });

  app.get('/api/inbox/finding-flags', async (c) => {
    const clinicId = c.var.clinicId;
    const [flags, counts] = await Promise.all([
      runtime.reviewer.listFlags(clinicId),
      runtime.reviewer.countFindings(clinicId, { mode: 'shadow' }),
    ]);
    const items: FindingFlagView[] = flags.map((flag) => ({
      category: flag.category,
      label: reviewerLabels.categories[flag.category].label,
      description: reviewerLabels.categories[flag.category].description,
      implemented: (IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(flag.category),
      ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
      enabled: flag.enabled,
      mode: flag.mode,
      ...(flag.validatedBy === undefined ? {} : { validatedBy: flag.validatedBy }),
      ...(flag.validatedAt === undefined ? {} : { validatedAt: flag.validatedAt.toISOString() }),
      ...(flag.updatedBy === undefined ? {} : { updatedBy: flag.updatedBy }),
      ...(flag.updatedAt === undefined ? {} : { updatedAt: flag.updatedAt.toISOString() }),
      review: reviewStats(counts, flag.category),
    }));
    return c.json({ items });
  });

  app.put('/api/inbox/finding-flags', async (c) => {
    const clinicId = c.var.clinicId;
    const body = await readJson(c, FindingFlagUpdateSchema);
    if (
      !(IMPLEMENTED_FINDING_CATEGORIES as readonly string[]).includes(body.category) &&
      body.enabled
    ) {
      throw new HttpError(422, 'invalid_request', reviewerLabels.reservedCategory, [
        { path: 'enabled', message: reviewerLabels.reservedCategoryField },
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
      throw new HttpError(422, 'invalid_request', reviewerLabels.signOffRequired, [
        { path: 'validatedBy', message: reviewerLabels.signOffRequiredField },
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
    return c.json({
      category: flag.category,
      label: reviewerLabels.categories[flag.category].label,
      description: reviewerLabels.categories[flag.category].description,
      implemented: true,
      ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
      enabled: flag.enabled,
      mode: flag.mode,
      ...(flag.validatedBy === undefined ? {} : { validatedBy: flag.validatedBy }),
      ...(flag.validatedAt === undefined ? {} : { validatedAt: flag.validatedAt.toISOString() }),
      ...(flag.updatedBy === undefined ? {} : { updatedBy: flag.updatedBy }),
      ...(flag.updatedAt === undefined ? {} : { updatedAt: flag.updatedAt.toISOString() }),
      review: reviewStats(counts, flag.category),
    } satisfies FindingFlagView);
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
    if (patient === undefined) throw notFound(reviewerLabels.patientNotFound);
    const report = await runtime.reviewer.reviewPatient(clinicId, patientId, 'manual');
    const presenter = new FindingPresenter(runtime, clinicId);
    return c.json({
      run: runView(report.run),
      findings: await Promise.all(report.findings.map((finding) => presenter.view(finding))),
    });
  });
}
