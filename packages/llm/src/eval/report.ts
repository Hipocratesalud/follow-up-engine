import type { Counts, Scores } from './metrics.ts';
import type { Aggregate, EvalRun } from './run.ts';

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const usd = (value: number): string => `$${value.toFixed(6)}`;
const fmt = (s: Scores): string => `${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)}`;
const tally = (c: Counts): string => `${String(c.tp)} / ${String(c.fp)} / ${String(c.fn)}`;

/** File name for a report: `<date>-<provider>-<model>.md`, model made path-safe. */
export function reportFileName(run: Pick<EvalRun, 'provider' | 'model' | 'startedAt'>): string {
  const date = run.startedAt.toISOString().slice(0, 10);
  const model = run.model.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${date}-${run.provider}-${model}.md`;
}

function fieldTable(aggregate: Aggregate): string[] {
  return [
    '| Field | Precision | Recall | F1 | TP / FP / FN |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| Conditions (ICD-10 category) | ${fmt(aggregate.scores.conditions)} | ${tally(aggregate.counts.conditions)} |`,
    `| Medications (fuzzy drug name) | ${fmt(aggregate.scores.medications)} | ${tally(aggregate.counts.medications)} |`,
    `| Plan items (kind + due ±20%) | ${fmt(aggregate.scores.planItems)} | ${tally(aggregate.counts.planItems)} |`,
  ];
}

/** Renders an eval run as a Markdown report. */
export function renderReport(run: EvalRun, notes?: string): string {
  const { summary } = run;
  const { overall } = summary;
  const lines: string[] = [
    `# Note extraction eval: ${run.provider} / ${run.model}`,
    '',
    `- Date: ${run.startedAt.toISOString()}`,
    `- Provider: \`${run.provider}\``,
    `- Model: \`${run.model}\``,
    `- Prompt: \`${run.promptVersion}\``,
    `- Notes: ${String(overall.notes)} (errors: ${String(overall.errors)})`,
    `- Wall time: ${(run.durationMs / 1000).toFixed(1)} s`,
    ...(notes ? ['', notes] : []),
    '',
    '## Overall',
    '',
    ...fieldTable(overall),
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| hasPlan accuracy | ${pct(overall.hasPlanAccuracy)} |`,
    `| Hallucinated-quote rate (items dropped by the verbatim check) | ${pct(overall.hallucinatedQuoteRate)} (${String(overall.quoteRejected)} / ${String(overall.modelItems)}) |`,
    `| Input tokens per note | ${summary.tokens.inputPerNote.toFixed(0)} |`,
    `| Output tokens per note | ${summary.tokens.outputPerNote.toFixed(0)} |`,
    `| Cost per note | ${usd(summary.cost.perNoteUsd)} |`,
    `| Total cost | ${usd(summary.cost.totalUsd)} |`,
    `| Latency p50 | ${String(summary.latencyMs.p50)} ms |`,
    `| Latency p95 | ${String(summary.latencyMs.p95)} ms |`,
    '',
    '## By specialty',
    '',
    '| Specialty | Notes | Conditions F1 | Medications F1 | Plan items F1 | hasPlan acc. | Errors |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summary.bySpecialty.map(
      (s) =>
        `| ${s.specialty} | ${String(s.notes)} | ${pct(s.scores.conditions.f1)} | ${pct(s.scores.medications.f1)} | ${pct(s.scores.planItems.f1)} | ${pct(s.hasPlanAccuracy)} | ${String(s.errors)} |`,
    ),
    '',
    '## Per note',
    '',
    '| Note | Specialty | Conditions TP/FP/FN | Medications TP/FP/FN | Plan TP/FP/FN | hasPlan | Quotes dropped | Tokens in/out | Cost | Latency | Error |',
    '| --- | --- | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: | --- |',
    ...run.results.map(
      (r) =>
        `| ${r.id} | ${r.specialty} | ${tally(r.counts.conditions)} | ${tally(r.counts.medications)} | ${tally(r.counts.planItems)} | ${r.hasPlanCorrect ? 'ok' : 'wrong'} | ${String(r.quoteRejected)} | ${String(r.inputTokens)}/${String(r.outputTokens)} | ${usd(r.costUsd)} | ${String(r.latencyMs)} ms | ${r.error ?? ''} |`,
    ),
    '',
    '## How to read this',
    '',
    '- Conditions match on the ICD-10 category (first 3 characters). Plan items match on kind and a due date within ±20% of the expected days (at least ±1 day). Medications match on the drug name, allowing two typos.',
    '- Scores are micro-averaged over all items; an empty set (nothing expected, nothing predicted) scores 100%.',
    '- The hallucinated-quote rate counts model items whose evidence quote is not a substring of the note. They never reach the engine: the post-check drops them.',
    '- Cost uses the pricing table in `packages/llm/src/pricing.ts`; check it against the vendor before quoting.',
    '',
  ];
  return lines.join('\n');
}
