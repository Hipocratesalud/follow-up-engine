import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../../gateway/gateway.ts';
import { DEFAULT_PRICING } from '../../pricing.ts';
import { createFakeProvider } from '../../providers/fake.ts';
import { createReviewAgent } from '../../reviewer/agent.ts';
import { CLINICAL_REVIEW_PROMPT_VERSION, CLINICAL_REVIEW_TASK } from '../../reviewer/prompt.ts';
import { FAKE_REVIEWER_MODEL, scriptedReviewerResponder } from '../../reviewer/scripted.ts';
import { InMemoryLlmUsageLog } from '../../usage-log.ts';
import { loadCohort, recordOf } from './cohort.ts';
import { renderReviewerReport } from './report.ts';
import { runReviewerEval } from './run.ts';

const COHORT_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'),
  'packages/testkit/fixtures/reviewer-cohort',
);

describe('reviewer eval on the planted cohort (fake provider, the real loop)', () => {
  it('finds every planted finding, nothing on the controls, with 0 hallucinated citations', async () => {
    const gateway = createLlmGateway({
      providers: { fake: createFakeProvider({ respond: scriptedReviewerResponder }) },
      tasks: {
        [CLINICAL_REVIEW_TASK]: { route: [{ provider: 'fake', model: FAKE_REVIEWER_MODEL }] },
      },
      usageLog: new InMemoryLlmUsageLog(),
      pricing: DEFAULT_PRICING,
    });
    const records = (await loadCohort(COHORT_DIR)).map(recordOf);
    expect(records).toHaveLength(20);
    const run = await runReviewerEval({
      records,
      agent: createReviewAgent({ gateway }),
      provider: 'fake',
      model: FAKE_REVIEWER_MODEL,
      promptVersion: CLINICAL_REVIEW_PROMPT_VERSION,
    });
    expect(run.totals).toMatchObject({
      hallucinatedCitations: 0,
      controlsWithFindings: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      degraded: 0,
    });
    expect(run.totals.citations).toBeGreaterThan(20);
    // Each review went through the tool protocol, within the budget.
    expect(run.patients.every((patient) => patient.toolCalls >= 1 && patient.toolCalls <= 6)).toBe(
      true,
    );
    expect(
      run.patients
        .find((patient) => patient.patientId === 'rev-0001')
        ?.found.map((item) => item.rule),
    ).toEqual(['lab_trend:creatinine', 'drug_condition:metformin_egfr_45']);
    // The control whose note carries a prompt injection produced nothing.
    expect(run.patients.find((patient) => patient.patientId === 'rev-0016')?.found).toEqual([]);
    const report = renderReviewerReport(run);
    expect(report).toContain('| Hallucinated citations (stored findings) | **0** of');
    expect(report).not.toMatch(/Rodolfo|Arismendi/);
  }, 30_000);
});
