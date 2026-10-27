/**
 * How the reviewer UI reads the agent's machine output (tool names, outcome
 * and stop codes, tool summaries) in the active locale. Every word comes
 * from the catalogs (`src/i18n`). Finding texts (summary, rationale,
 * suggestion) and `categoryLabel` come from the API and are shown as sent.
 */
import type { FindingSeverity, ReviewStepView } from '../../api/reviewer-contract.ts';
import type { Tone } from '../../components/ui.tsx';
import type { Messages } from '../../i18n/index.ts';

export const SEVERITY_TONES: Record<FindingSeverity, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

/** Highest first. */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** One step of the agent, in plain words ("Looked up the creatinine trend"). */
export function describeStep(t: Messages, step: ReviewStepView): string {
  const args = step.arguments;
  const steps = t.review.steps;
  switch (step.tool) {
    case 'get_lab_trend': {
      const test = text(args['test']);
      return steps.labTrend(test === undefined ? undefined : (t.review.testNames[test] ?? test));
    }
    case 'get_notes': {
      const query = text(args['query']);
      if (query !== undefined) return steps.searchNotes(query);
      return steps.readNotes(Array.isArray(args['docIds']) ? args['docIds'].length : 0);
    }
    case 'get_medications':
      return steps.medications;
    case 'get_open_follow_ups':
      return steps.openFollowUps;
    case 'check_interaction':
      return steps.interaction(text(args['drugA']), text(args['drugB']));
    case 'submit_findings':
      return steps.submitted(typeof args['findings'] === 'number' ? args['findings'] : undefined);
    default:
      return steps.unknownTool(step.tool);
  }
}

export function outcomeLabel(t: Messages, outcome: string): string {
  return t.review.outcomes[outcome] ?? outcome;
}

/** The tool's machine summary ("4 points", "found: high") in words. */
export function summaryLabel(t: Messages, summary: string): string {
  const words = t.review.summaries;
  const patterns: [RegExp, (match: RegExpExecArray) => string][] = [
    [/^(\d+) points?$/, (m) => words.points(m[1] ?? '')],
    [/^not found$/, () => words.notFound],
    [/^(\d+) expectations?, (\d+) cases?$/, (m) => words.expectations(m[1] ?? '', m[2] ?? '')],
    [/^(\d+) notes? match$/, (m) => words.notesMatch(m[1] ?? '')],
    [/^(\d+) notes?$/, (m) => words.notes(m[1] ?? '')],
    [/^(\d+) medications?$/, (m) => words.medications(m[1] ?? '')],
    [/^(\d+) findings?$/, (m) => words.findings(m[1] ?? '')],
    [/^found: none$/, () => words.noInteraction],
    [/^found: (\w+)$/, (m) => words.interaction(words.severityWords[m[1] ?? ''] ?? m[1] ?? '')],
  ];
  for (const [pattern, render] of patterns) {
    const match = pattern.exec(summary);
    if (match) return render(match);
  }
  return summary;
}

export function stopReasonLabel(t: Messages, reason: string): string {
  return t.review.stopReasons[reason] ?? reason;
}

export function discardLabel(t: Messages, reason: string): string {
  return t.review.discards[reason] ?? reason;
}
