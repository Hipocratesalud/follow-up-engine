import {
  type ClinicalFinding,
  type ClinicalFindingRepository,
  type ClinicalReviewRun,
  type ClinicalReviewRunRepository,
  type ClinicId,
  type FindingFlag,
  type FindingFlagRepository,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

const PATIENT = patientId('pat-cf');

export function aClinicalFinding(
  clinicId: ClinicId,
  overrides: Partial<ClinicalFinding> = {},
): ClinicalFinding {
  return {
    id: uniqueId('cf'),
    clinicId,
    patientId: PATIENT,
    category: 'lab_trend',
    severity: 'medium',
    summary: 'Creatinina en ascenso en los últimos 3 resultados',
    rationale: 'Tres resultados seguidos empeoran.',
    suggestion: 'Considera evaluar la función renal.',
    citations: [
      {
        source: { resourceType: 'Observation', id: 'obs-1' },
        kind: 'result',
        quote: 'Creatinina: 1.75 mg/dL',
        occurredAt: at(-40),
      },
    ],
    alreadyCovered: false,
    coveredBy: [],
    specialty: 'diabetology',
    mode: 'shadow',
    status: 'open',
    origin: 'confirmed',
    dedupKey: 'lab_trend|Observation/obs-1',
    runId: 'run-1',
    modelId: 'fake:fake-reviewer',
    promptVersion: 'clinical-review@1',
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

export function aReviewRun(
  clinicId: ClinicId,
  overrides: Partial<ClinicalReviewRun> = {},
): ClinicalReviewRun {
  return {
    id: uniqueId('run'),
    clinicId,
    patientId: PATIENT,
    trigger: 'result.received',
    status: 'completed',
    signalsCount: 2,
    findingsCount: 1,
    discardedCount: 1,
    duplicateCount: 0,
    discarded: [{ reason: 'quote_not_found', count: 1 }],
    steps: 3,
    toolCalls: 2,
    trace: [
      {
        index: 1,
        tool: 'get_lab_trend',
        arguments: { test: 'creatinine' },
        outcome: 'ok',
        summary: '4 points',
      },
    ],
    inputTokens: 4200,
    outputTokens: 310,
    costUsd: 0.006567,
    modelId: 'meta:muse-spark-1.3',
    promptVersion: 'clinical-review@1',
    stopReason: 'submitted',
    startedAt: at(0),
    finishedAt: at(0.001),
    ...overrides,
  };
}

/** Contract every {@link ClinicalFindingRepository} adapter must pass. */
export function describeClinicalFindingRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ClinicalFindingRepository>,
): void {
  describe(`ClinicalFindingRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('creates and reads a finding back exactly, scoped to its clinic', async () => {
      const { a, b } = freshClinics();
      const finding = aClinicalFinding(a, {
        coveredBy: [{ kind: 'case', id: 'case-1', code: 'x' }],
        alreadyCovered: true,
      });
      await repo().create(a, finding);
      expect(await repo().get(a, finding.id)).toEqual(finding);
      expect(await repo().get(b, finding.id)).toBeUndefined();
      await expectRejectsWithName(repo().create(a, finding), 'ConflictError');
      await expectRejectsWithName(repo().create(b, finding), 'TenantMismatchError');
    });

    it('records a verdict: the status becomes the verdict', async () => {
      const { a } = freshClinics();
      const finding = aClinicalFinding(a);
      await repo().create(a, finding);
      const reviewed = await repo().review(a, finding.id, {
        verdict: 'not_relevant',
        reason: 'El paciente ya está en diálisis',
        reviewedBy: 'dra-castellanos',
        reviewedAt: at(1),
      });
      expect(reviewed).toMatchObject({
        status: 'not_relevant',
        review: {
          verdict: 'not_relevant',
          reason: 'El paciente ya está en diálisis',
          reviewedBy: 'dra-castellanos',
          reviewedAt: at(1),
        },
        updatedAt: at(1),
      });
      expect(await repo().get(a, finding.id)).toEqual(reviewed);
      await expectRejectsWithName(
        repo().review(a, 'missing', { verdict: 'relevant', reviewedBy: 'x', reviewedAt: at(1) }),
        'NotFoundError',
      );
    });

    it('finds duplicates: open, or created or reviewed since the window start', async () => {
      const { a } = freshClinics();
      const key = 'lab_trend|Observation/obs-9';
      const oldOpen = aClinicalFinding(a, { dedupKey: key, createdAt: at(-200) });
      const oldReviewed = aClinicalFinding(a, { dedupKey: key, createdAt: at(-200) });
      const recentReview = aClinicalFinding(a, { dedupKey: key, createdAt: at(-200) });
      const other = aClinicalFinding(a, { dedupKey: 'vital_trend|x', createdAt: at(-1) });
      for (const finding of [oldOpen, oldReviewed, recentReview, other])
        await repo().create(a, finding);
      await repo().review(a, oldReviewed.id, {
        verdict: 'relevant',
        reviewedBy: 'u',
        reviewedAt: at(-150),
      });
      await repo().review(a, recentReview.id, {
        verdict: 'already_known',
        reviewedBy: 'u',
        reviewedAt: at(-10),
      });
      const found = await repo().findDuplicates(a, PATIENT, key, at(-90));
      expect(found.map((finding) => finding.id).sort()).toEqual(
        [oldOpen.id, recentReview.id].sort(),
      );
      expect(await repo().findDuplicates(a, patientId('pat-other'), key, at(-90))).toEqual([]);
    });

    it('lists newest first with filters and pages, and counts per status and category', async () => {
      const { a, b } = freshClinics();
      const findings = [
        aClinicalFinding(a, { createdAt: at(1), category: 'lab_trend', severity: 'high' }),
        aClinicalFinding(a, { createdAt: at(2), category: 'drug_interaction', severity: 'high' }),
        aClinicalFinding(a, { createdAt: at(3), category: 'record_quality', severity: 'low' }),
        aClinicalFinding(a, { createdAt: at(4), category: 'lab_trend', mode: 'live' }),
      ];
      for (const finding of findings) await repo().create(a, finding);
      await repo().create(b, aClinicalFinding(b));
      await repo().review(a, findings[0]?.id ?? '', {
        verdict: 'relevant',
        reviewedBy: 'u',
        reviewedAt: at(5),
      });

      const shadow = await repo().list(a, { mode: 'shadow', limit: 2 });
      expect(shadow.items.map((finding) => finding.id)).toEqual([findings[2]?.id, findings[1]?.id]);
      expect(shadow.nextCursor).toBeDefined();
      const rest = await repo().list(a, {
        mode: 'shadow',
        limit: 2,
        ...(shadow.nextCursor === undefined ? {} : { cursor: shadow.nextCursor }),
      });
      expect(rest.items.map((finding) => finding.id)).toEqual([findings[0]?.id]);
      expect(rest.nextCursor).toBeUndefined();

      const filtered = await repo().list(a, {
        statuses: ['open'],
        categories: ['lab_trend', 'drug_interaction'],
        severities: ['high', 'medium'],
        limit: 10,
      });
      expect(filtered.items.map((finding) => finding.id)).toEqual([
        findings[3]?.id,
        findings[1]?.id,
      ]);
      await expectRejectsWithName(
        repo().list(a, { limit: 1, cursor: 'garbage' }),
        'InvalidCursorError',
      );

      const counts = await repo().counts(a, { mode: 'shadow' });
      expect(counts).toEqual({
        total: 3,
        byStatus: { open: 2, relevant: 1 },
        byCategory: { lab_trend: 1, drug_interaction: 1, record_quality: 1 },
        bySeverity: { high: 2, low: 1 },
        byCategoryStatus: {
          lab_trend: { relevant: 1 },
          drug_interaction: { open: 1 },
          record_quality: { open: 1 },
        },
      });
      expect((await repo().counts(b, {})).total).toBe(1);
    });
  });
}

/** Contract every {@link ClinicalReviewRunRepository} adapter must pass. */
export function describeClinicalReviewRunRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ClinicalReviewRunRepository>,
): void {
  describe(`ClinicalReviewRunRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('records a run and reads it back exactly (cost without float drift)', async () => {
      const { a, b } = freshClinics();
      const run = aReviewRun(a);
      await repo().record(a, run);
      expect(await repo().get(a, run.id)).toEqual(run);
      expect(await repo().get(b, run.id)).toBeUndefined();
      await expectRejectsWithName(repo().record(a, run), 'ConflictError');
    });

    it('knows when a patient was last reviewed, ignoring failed runs', async () => {
      const { a } = freshClinics();
      expect(await repo().lastReviewedAt(a, PATIENT)).toBeUndefined();
      await repo().record(a, aReviewRun(a, { startedAt: at(-40) }));
      await repo().record(a, aReviewRun(a, { startedAt: at(-10), status: 'skipped' }));
      await repo().record(a, aReviewRun(a, { startedAt: at(-1), status: 'failed' }));
      expect(await repo().lastReviewedAt(a, PATIENT)).toEqual(at(-10));
    });

    it('sums runs since an instant', async () => {
      const { a } = freshClinics();
      await repo().record(a, aReviewRun(a, { startedAt: at(-100) }));
      await repo().record(
        a,
        aReviewRun(a, { startedAt: at(-5), costUsd: 0.25, status: 'degraded', duplicateCount: 2 }),
      );
      await repo().record(
        a,
        aReviewRun(a, { startedAt: at(-1), patientId: patientId('pat-2'), costUsd: 0.5 }),
      );
      expect(await repo().stats(a, at(-30))).toEqual({
        runs: 2,
        patientsReviewed: 2,
        findings: 2,
        discarded: 2,
        duplicates: 2,
        degraded: 1,
        steps: 6,
        toolCalls: 4,
        costUsd: 0.75,
      });
    });
  });
}

/** Contract every {@link FindingFlagRepository} adapter must pass. */
export function describeFindingFlagRepositoryContract(
  name: string,
  makeSubject: MakeSubject<FindingFlagRepository>,
): void {
  describe(`FindingFlagRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('stores one flag per category and specialty, clinic-wide ones without specialty', async () => {
      const { a, b } = freshClinics();
      const clinicWide: FindingFlag = {
        clinicId: a,
        category: 'lab_trend',
        enabled: true,
        mode: 'shadow',
        updatedBy: 'u',
        updatedAt: at(0),
      };
      const psychology: FindingFlag = { ...clinicWide, specialty: 'psychology', enabled: false };
      await repo().upsert(a, clinicWide);
      await repo().upsert(a, psychology);
      expect(await repo().list(a)).toEqual([clinicWide, psychology]);
      expect(await repo().list(b)).toEqual([]);
      await expectRejectsWithName(repo().upsert(b, clinicWide), 'TenantMismatchError');
    });

    it('replaces a flag: going live keeps who validated it', async () => {
      const { a } = freshClinics();
      await repo().upsert(a, {
        clinicId: a,
        category: 'drug_interaction',
        enabled: true,
        mode: 'shadow',
        updatedAt: at(0),
      });
      const live: FindingFlag = {
        clinicId: a,
        category: 'drug_interaction',
        enabled: true,
        mode: 'live',
        validatedBy: 'dra-castellanos',
        validatedAt: at(1),
        updatedBy: 'admin',
        updatedAt: at(1),
      };
      await repo().upsert(a, live);
      expect(await repo().list(a)).toEqual([live]);
    });
  });
}
