import {
  FakeNoteExtractor,
  loadConfigDirectory,
  SequentialIdGenerator,
} from '@follow-up-engine/adapter-memory';
import {
  CLINICAL_REVIEW_JOB,
  type ClinicalReviewer,
  clinicId,
  createClinicalReviewer,
  type FindingFlag,
  locateVerbatim,
  patientId,
  shadowPilotFlags,
} from '@follow-up-engine/core';
import {
  createFakeProvider,
  createLlmGateway,
  createReviewAgent,
  CLINICAL_REVIEW_TASK,
  DEFAULT_PRICING,
  FAKE_REVIEWER_MODEL,
  InMemoryLlmUsageLog,
  scriptedReviewerResponder,
} from '@follow-up-engine/llm';
import { BASE_DATE, contractBuilders, loadReviewerCohort } from '@follow-up-engine/testkit';
import { describe, expect, it } from 'vitest';
import { conditionResource, transactionOf } from '../src/bundles.ts';
import { labResultBundle } from '../src/calibration-bundles.ts';
import {
  type EngineHarness,
  type HarnessOptions,
  ingestBundle,
  memoryHarness,
  postgresHarness,
} from '../src/harness.ts';
import { POSTGRES_ENABLED, postgresTitle, useIsolatedDatabase } from '../src/postgres.ts';

/**
 * HIP-112, the clinical reviewer in shadow mode, end to end on each
 * adapter: new results, notes and prescriptions queue one debounced review
 * per patient; the review (detectors + the agent loop through the gateway,
 * the fake provider's scripted agent) stores shadow findings whose every
 * citation is verbatim; shadow findings never reach the outbox (webhooks)
 * nor the patient; a category goes live only with a sign-off, and only then
 * does a finding emit `clinical_finding.created`; identical findings are not
 * stored twice within 90 days; the daily sweep reviews high-priority
 * patients nobody reviewed in 30 days.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const cohort = loadReviewerCohort();

function cohortPatient(id: string) {
  const patient = cohort.patients.find((item) => item.patientId === id);
  if (patient === undefined) throw new Error(`cohort patient ${id}`);
  return patient;
}

function reviewerFor(harness: EngineHarness): ClinicalReviewer {
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond: scriptedReviewerResponder }) },
    tasks: {
      [CLINICAL_REVIEW_TASK]: { route: [{ provider: 'fake', model: FAKE_REVIEWER_MODEL }] },
    },
    usageLog: new InMemoryLlmUsageLog(),
    pricing: DEFAULT_PRICING,
    clock: harness.clock,
  });
  return createClinicalReviewer({
    unitOfWork: harness.unitOfWork,
    clock: harness.clock,
    ids: new SequentialIdGenerator(),
    agent: createReviewAgent({ gateway }),
    // As the runtime wires it: what each open expectation asks for comes from the catalog.
    loadCatalog: (id) => harness.engine.catalog(id),
  });
}

async function setFlags(harness: EngineHarness, flags: readonly FindingFlag[]): Promise<void> {
  await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
    for (const flag of flags) await stores.findingFlags.upsert(harness.clinicId, flag);
  });
}

/** The cohort patient's whole history, sent live (as the host would), all at `at`. */
async function sendHistory(harness: EngineHarness, id: string, at: Date): Promise<void> {
  harness.clock.set(at);
  const patient = cohortPatient(id);
  for (const entry of patient.entries) {
    const bundle = JSON.parse(
      JSON.stringify(entry.bundle).replaceAll('clinic-demo', harness.clinicId),
    ) as unknown;
    await ingestBundle(harness, bundle, at);
  }
}

async function claimReviews(harness: EngineHarness, now: Date) {
  return harness.read((stores) =>
    stores.jobs.claim({
      workerId: 'test',
      types: [CLINICAL_REVIEW_JOB],
      limit: 10,
      leaseFor: { minutes: 5 },
      now,
    }),
  );
}

/** Runs every review that is due at `now`, like the worker. */
async function runDueReviews(
  harness: EngineHarness,
  reviewer: ClinicalReviewer,
  now: Date,
): Promise<number> {
  const jobs = await claimReviews(harness, now);
  for (const job of jobs) {
    await reviewer.runReviewJob(harness.clinicId, job.payload);
    await harness.read((stores) => stores.jobs.complete(harness.clinicId, job));
  }
  return jobs.length;
}

function describeReviewer(
  adapter: string,
  makeHarness: (options: HarnessOptions) => Promise<EngineHarness>,
): void {
  const start = new Date(BASE_DATE.getTime() - 60 * MINUTE);
  const options = (name: string): HarnessOptions => ({
    clinicId: clinicId(`clinic-reviewer-${adapter}-${name}`),
    start,
    extractor: new FakeNoteExtractor(),
  });

  it('queues nothing while every category is off (nothing is enabled without validation)', async () => {
    const harness = await makeHarness(options('off'));
    await sendHistory(harness, 'rev-0001', start);
    expect(await claimReviews(harness, new Date(start.getTime() + 24 * 60 * MINUTE))).toEqual([]);
  });

  it("debounces: a patient's new results, notes and prescriptions share one review 10 minutes later", async () => {
    const harness = await makeHarness(options('shadow'));
    await setFlags(harness, shadowPilotFlags(harness.clinicId, 'pilot-lead', start));
    const reviewer = reviewerFor(harness);
    await sendHistory(harness, 'rev-0001', start);

    expect(await runDueReviews(harness, reviewer, new Date(start.getTime() + 9 * MINUTE))).toBe(0);
    harness.clock.set(new Date(start.getTime() + 10 * MINUTE));
    const due = await claimReviews(harness, harness.clock.now());
    expect(due).toHaveLength(1);
    expect(due[0]?.payload).toMatchObject({ patientId: 'rev-0001' });
    const report = await reviewer.runReviewJob(harness.clinicId, due[0]?.payload ?? {});
    await harness.read((stores) =>
      stores.jobs.complete(harness.clinicId, due[0] ?? { id: '' as never, leaseToken: '' }),
    );

    expect(report?.run).toMatchObject({
      status: 'completed',
      stopReason: 'submitted',
      modelId: 'fake:fake-reviewer',
    });
    expect(report?.run.toolCalls).toBeGreaterThan(0);
    expect(report?.run.trace.at(-1)?.tool).toBe('submit_findings');
    const findings = await reviewer.listFindings(harness.clinicId, { mode: 'shadow', limit: 20 });
    expect(findings.items.map((finding) => finding.category).sort()).toEqual([
      'drug_condition_conflict',
      'lab_trend',
    ]);
    expect(
      findings.items.every((finding) => finding.mode === 'shadow' && finding.status === 'open'),
    ).toBe(true);

    // Every stored citation is verbatim in the stored record (0 hallucinated citations).
    for (const finding of findings.items) {
      for (const citation of finding.citations) {
        const events = await harness.read((stores) =>
          stores.clinicalRecords.listEventsForPatient(harness.clinicId, patientId('rev-0001')),
        );
        const source = events.find(
          (event) =>
            event.source.resourceType === citation.source.resourceType &&
            event.source.id === citation.source.id,
        );
        expect(source, `${citation.source.resourceType}/${citation.source.id}`).toBeDefined();
        if (source?.type === 'note.received') {
          expect(locateVerbatim(source.text, citation.quote)).toBe(citation.quote);
        }
      }
    }

    // Shadow: nothing reaches the outbox (no webhook), nothing asks to contact the patient.
    const events = await harness.pendingEvents();
    expect(events.filter((event) => event.type === 'clinical_finding.created')).toEqual([]);
    expect(events.filter((event) => event.type === 'patient_contact.requested')).toEqual([]);

    // The same review again stores nothing new: identical findings are deduplicated.
    const again = await reviewer.reviewPatient(harness.clinicId, patientId('rev-0001'), 'manual');
    expect(again.findings).toEqual([]);
    expect(again.run.duplicateCount).toBe(2);
    expect((await reviewer.listFindings(harness.clinicId, { limit: 20 })).items).toHaveLength(2);
  });

  it('goes live only with a sign-off; then a finding emits clinical_finding.created (ids only)', async () => {
    const harness = await makeHarness(options('live'));
    await setFlags(harness, shadowPilotFlags(harness.clinicId, 'pilot-lead', start));
    const reviewer = reviewerFor(harness);
    await expect(
      reviewer.updateFlag(
        harness.clinicId,
        { category: 'drug_interaction', enabled: true, mode: 'live' },
        'u1',
      ),
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'validatedBy' });
    const live = await reviewer.updateFlag(
      harness.clinicId,
      { category: 'drug_interaction', enabled: true, mode: 'live', validatedBy: 'dra-castellanos' },
      'u1',
    );
    expect(live).toMatchObject({ mode: 'live', validatedBy: 'dra-castellanos' });

    await sendHistory(harness, 'rev-0004', start);
    expect(await runDueReviews(harness, reviewer, new Date(start.getTime() + 10 * MINUTE))).toBe(1);
    const [finding] = (await reviewer.listFindings(harness.clinicId, { mode: 'live', limit: 5 }))
      .items;
    expect(finding).toMatchObject({ category: 'drug_interaction', mode: 'live', severity: 'high' });
    const created = (await harness.pendingEvents()).filter(
      (event) => event.type === 'clinical_finding.created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toEqual({
      findingId: finding?.id,
      patientId: 'rev-0004',
      severity: 'high',
    });

    // The clinician's verdict: a reason is required when it is not relevant.
    await expect(
      reviewer.reviewFinding(harness.clinicId, finding?.id ?? '', {
        verdict: 'not_relevant',
        userId: 'u2',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    const reviewed = await reviewer.reviewFinding(harness.clinicId, finding?.id ?? '', {
      verdict: 'relevant',
      userId: 'u2',
    });
    expect(reviewed).toMatchObject({
      status: 'relevant',
      review: { verdict: 'relevant', reviewedBy: 'u2' },
    });
  });

  it('a control patient gets a review and no finding; one carrying an injected instruction too', async () => {
    const harness = await makeHarness(options('controls'));
    await setFlags(harness, shadowPilotFlags(harness.clinicId, 'pilot-lead', start));
    const reviewer = reviewerFor(harness);
    for (const id of ['rev-0011', 'rev-0016']) {
      await sendHistory(harness, id, start);
    }
    expect(await runDueReviews(harness, reviewer, new Date(start.getTime() + 10 * MINUTE))).toBe(2);
    expect((await reviewer.listFindings(harness.clinicId, { limit: 20 })).items).toEqual([]);
    expect(
      (await harness.pendingEvents()).filter((event) => event.type === 'clinical_finding.created'),
    ).toEqual([]);
  });

  it('a lab trend a protocol item already expects is covered, through any code of the item', async () => {
    // rev-0001: creatinine rising, silent. Same record twice; the second
    // clinic runs every protocol, has the CKD coded and an eGFR after the
    // last creatinine, so the CKD renal function item is open, counted from
    // that eGFR (not a cited result): only its equivalence group (an eGFR or
    // a creatinine) ties it to the creatinine trend.
    const trendOf = async (name: string, ckd: boolean) => {
      const harness = await makeHarness({
        ...options(name),
        settings: { enabledProtocols: loadConfigDirectory().protocols.map((p) => p.id) },
      });
      await setFlags(harness, shadowPilotFlags(harness.clinicId, 'pilot-lead', start));
      await sendHistory(harness, 'rev-0001', start);
      if (ckd) {
        const condition = conditionResource({
          id: 'rev-0001-ckd',
          patientId: 'rev-0001',
          icd10: 'N18.3',
          verification: 'confirmed',
          at: start,
        });
        await ingestBundle(harness, transactionOf(condition), start);
        const egfr = labResultBundle({
          id: 'rev-0001-egfr',
          patientId: 'rev-0001',
          loinc: '33914-3',
          display: 'eGFR',
          at: start,
          value: 41,
          unit: 'mL/min/1.73m2',
          flag: 'L',
        });
        await ingestBundle(harness, egfr, start);
      }
      const report = await reviewerFor(harness).reviewPatient(
        harness.clinicId,
        patientId('rev-0001'),
        'initial',
      );
      return report.findings.find((finding) => finding.category === 'lab_trend');
    };
    const silent = await trendOf('trend-uncovered', false);
    expect(silent).toMatchObject({ alreadyCovered: false, coveredBy: [] });
    const covered = await trendOf('trend-covered', true);
    expect(covered?.alreadyCovered).toBe(true);
    expect(covered?.coveredBy.map((item) => item.code)).toContain(
      'protocol_chronic_kidney_disease_renal_function',
    );
  });

  it('the daily sweep reviews high-priority patients not reviewed in 30 days', async () => {
    const harness = await makeHarness(options('stale'));
    await setFlags(harness, shadowPilotFlags(harness.clinicId, 'pilot-lead', start));
    const reviewer = reviewerFor(harness);
    harness.clock.set(start);
    await harness.unitOfWork.withTransaction(harness.clinicId, async (stores) => {
      // High priority (an abnormal result's follow-up) and low priority (a protocol reminder).
      await stores.cases.create(
        harness.clinicId,
        contractBuilders.aCase(harness.clinicId, {
          patientId: patientId('pat-high'),
          priority: 80,
          createdAt: start,
        }),
      );
      await stores.cases.create(
        harness.clinicId,
        contractBuilders.aCase(harness.clinicId, {
          patientId: patientId('pat-low'),
          priority: 40,
          createdAt: start,
        }),
      );
    });
    expect(await reviewer.scheduleStaleReviews(harness.clinicId, start)).toBe(1);
    // Queued once: the pending job is not queued again by the next sweep.
    expect(await reviewer.scheduleStaleReviews(harness.clinicId, start)).toBe(1);
    const jobs = await claimReviews(harness, start);
    expect(jobs.map((job) => job.payload)).toEqual([
      { patientId: 'pat-high', trigger: 'stale_high_priority' },
    ]);
    const report = await reviewer.runReviewJob(harness.clinicId, jobs[0]?.payload ?? {});
    await harness.read((stores) =>
      stores.jobs.complete(harness.clinicId, jobs[0] ?? { id: '' as never, leaseToken: '' }),
    );
    expect(report?.run.trigger).toBe('stale_high_priority');
    // Reviewed: not again within 30 days; due again after.
    expect(
      await reviewer.scheduleStaleReviews(harness.clinicId, new Date(start.getTime() + 29 * DAY)),
    ).toBe(0);
    expect(
      await reviewer.scheduleStaleReviews(harness.clinicId, new Date(start.getTime() + 31 * DAY)),
    ).toBe(1);
  });
}

describe('clinical reviewer, end to end (memory)', () => {
  describeReviewer('memory', (options) => Promise.resolve(memoryHarness(options)));
});

describe.skipIf(!POSTGRES_ENABLED)(postgresTitle('clinical reviewer, end to end'), () => {
  const database = useIsolatedDatabase();
  describeReviewer('postgres', (options) => postgresHarness(database(), options));
});
