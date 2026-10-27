import type { ReviewerEvalRun } from './run.ts';

function pct(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(6)}`;
}

/** `reviewer/<date>-<provider>-<model>.md`, the model id made file-safe. */
export function reviewerReportFileName(run: ReviewerEvalRun): string {
  const model = run.model.replace(/[^a-zA-Z0-9.-]+/g, '-');
  return `${run.startedAt.slice(0, 10)}-${run.provider}-${model}.md`;
}

/** Markdown report of a reviewer eval run (no note text: categories, rules and counts only). */
export function renderReviewerReport(run: ReviewerEvalRun, header = ''): string {
  const { totals } = run;
  const lines = [
    `# Clinical reviewer eval: ${run.provider} / ${run.model}`,
    '',
    `- Prompt: \`${run.promptVersion}\``,
    `- Date: ${run.startedAt.slice(0, 10)}`,
    `- Cohort: ${String(run.patients.length)} synthetic patients (${String(run.patients.filter((p) => p.kind === 'planted').length)} planted, ${String(run.patients.filter((p) => p.kind === 'control').length)} controls), every implemented category enabled`,
    ...(header === '' ? [] : ['', header]),
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Precision | ${pct(totals.precision)} (${String(totals.truePositives)} of ${String(totals.truePositives + totals.falsePositives)} findings) |`,
    `| Recall | ${pct(totals.recall)} (${String(totals.truePositives)} of ${String(totals.truePositives + totals.falseNegatives)} planted) |`,
    `| Hallucinated citations (stored findings) | **${String(totals.hallucinatedCitations)}** of ${String(totals.citations)} |`,
    `| Controls with any finding | ${String(totals.controlsWithFindings)} of ${String(run.patients.filter((p) => p.kind === 'control').length)} |`,
    `| Reviews degraded to detectors only | ${String(totals.degraded)} of ${String(totals.reviews)} |`,
    `| Steps (model calls) per review | ${totals.avgSteps.toFixed(1)} |`,
    `| Tool calls per review | ${totals.avgToolCalls.toFixed(1)} |`,
    `| Tokens per review (in / out) | ${Math.round(totals.avgInputTokens).toLocaleString('en-US')} / ${Math.round(totals.avgOutputTokens).toLocaleString('en-US')} |`,
    `| Cost per review | ${usd(totals.costPerReviewUsd)} |`,
    `| Projected cost per review at Muse Spark list price | ${usd(totals.projectedMuseSparkCostPerReviewUsd)} |`,
    `| Proposals dropped by the engine's checks | ${
      Object.keys(totals.discarded).length === 0
        ? 'none'
        : Object.entries(totals.discarded)
            .map(([reason, count]) => `${reason} ${String(count)}`)
            .join(', ')
    } |`,
    '',
    '## By category',
    '',
    '| Category | TP | FP | FN | Precision | Recall |',
    '| --- | --: | --: | --: | --: | --: |',
    ...run.byCategory.map(
      (score) =>
        `| ${score.category} | ${String(score.truePositives)} | ${String(score.falsePositives)} | ${String(score.falseNegatives)} | ${pct(score.precision)} | ${pct(score.recall)} |`,
    ),
    '',
    '## By patient',
    '',
    '| Patient | Kind | Planted | Found | Tool calls | Status |',
    '| --- | --- | --- | --- | --: | --- |',
    ...run.patients.map(
      (patient) =>
        `| ${patient.patientId} | ${patient.kind} | ${patient.expected.map((item) => item.rule).join(', ') || '—'} | ${patient.found.map((item) => item.rule ?? `${item.category} (added)`).join(', ') || '—'} | ${String(patient.toolCalls)} | ${patient.status}${patient.error === undefined ? '' : ` (${patient.stopReason})`} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** JSON sidecar: the run without note text (categories, rules, counts). */
export function reviewerSidecar(run: ReviewerEvalRun): Record<string, unknown> {
  return {
    kind: 'clinical_reviewer',
    provider: run.provider,
    model: run.model,
    promptVersion: run.promptVersion,
    startedAt: run.startedAt,
    totals: run.totals,
    byCategory: run.byCategory,
    patients: run.patients.map((patient) => ({
      patientId: patient.patientId,
      kind: patient.kind,
      expected: patient.expected,
      found: patient.found.map((item) => ({ category: item.category, rule: item.rule ?? null })),
      truePositives: patient.truePositives,
      falsePositives: patient.falsePositives,
      falseNegatives: patient.falseNegatives,
      hallucinatedCitations: patient.hallucinatedCitations,
      steps: patient.steps,
      toolCalls: patient.toolCalls,
      status: patient.status,
    })),
  };
}
