import type { ReviewInput, SignalView } from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import type { ProviderRequest } from '../usage.ts';
import { REVIEWER_ACTION_NAME, type ReviewerAction } from './prompt.ts';

/** Model id of the scripted reviewer on the fake provider. */
export const FAKE_REVIEWER_MODEL = 'fake-reviewer';

interface PlannedCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** The signals this call checks. */
  readonly signals: readonly string[];
}

function parseInput(content: string): ReviewInput | undefined {
  const match = /<review_input>([\s\S]*)<\/review_input>/.exec(content);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]) as ReviewInput;
  } catch {
    return undefined;
  }
}

interface Observation {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

function parseObservation(content: string): Observation | undefined {
  const match = /<tool_result step="\d+" tool="([a-z_]+)">([\s\S]*)<\/tool_result>/.exec(content);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  try {
    return { tool: match[1], body: JSON.parse(match[2]) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** The calls that can confirm or refute the signals, most informative first, one per topic. */
function planCalls(signals: readonly SignalView[]): PlannedCall[] {
  const calls: PlannedCall[] = [{ tool: 'get_open_follow_ups', args: {}, signals: [] }];
  const seen = new Set<string>();
  const add = (key: string, call: PlannedCall): void => {
    const existing = calls.find((item) => `${item.tool}:${JSON.stringify(item.args)}` === key);
    if (existing !== undefined) {
      calls[calls.indexOf(existing)] = {
        ...existing,
        signals: [...existing.signals, ...call.signals],
      };
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(call);
  };
  for (const signal of signals) {
    const topic = signal.topic;
    if (
      topic?.drugs !== undefined &&
      topic.drugs.length >= 2 &&
      signal.category === 'drug_interaction'
    ) {
      const args = { drugA: topic.drugs[0], drugB: topic.drugs[1] };
      add(`check_interaction:${JSON.stringify(args)}`, {
        tool: 'check_interaction',
        args,
        signals: [signal.id],
      });
    } else if (topic?.test !== undefined) {
      const args = { test: topic.test };
      add(`get_lab_trend:${JSON.stringify(args)}`, {
        tool: 'get_lab_trend',
        args,
        signals: [signal.id],
      });
    } else if (topic?.symptom !== undefined) {
      const args = { query: topic.symptom, docIds: null };
      add(`get_notes:${JSON.stringify(args)}`, { tool: 'get_notes', args, signals: [signal.id] });
    }
  }
  return calls;
}

/** Whether what a tool returned contradicts the signal (the agent then drops it). */
function refuted(signal: SignalView, observations: readonly Observation[]): boolean {
  const topic = signal.topic;
  if (signal.category === 'drug_interaction' && topic?.drugs !== undefined) {
    const check = observations.find(
      (item) =>
        item.tool === 'check_interaction' &&
        (item.body['drugA'] as { name?: string } | undefined)?.name === topic.drugs?.[0] &&
        (item.body['drugB'] as { name?: string } | undefined)?.name === topic.drugs?.[1],
    );
    return check?.body['found'] === false && check.body['partOf'] === undefined;
  }
  if (
    topic?.test !== undefined &&
    (signal.category === 'lab_trend' || signal.category === 'vital_trend')
  ) {
    const trend = observations.find(
      (item) => item.tool === 'get_lab_trend' && item.body['test'] === topic.test,
    );
    return trend?.body['found'] === true && trend.body['consecutiveWorsening'] === 0;
  }
  if (topic?.symptom !== undefined) {
    const notes = observations.find(
      (item) => item.tool === 'get_notes' && item.body['query'] === topic.symptom,
    );
    const matches = notes?.body['matches'];
    return Array.isArray(matches) && matches.length === 0;
  }
  return false;
}

function action(thought: string, tool: string, args: unknown): ReviewerAction {
  return { thought, tool, arguments: JSON.stringify(args) };
}

/**
 * A deterministic stand-in for the reviewing model, for CI, demos and the
 * eval baseline. It speaks the real protocol through the real gateway and
 * loop: reads the review input, calls the read-only tools that can check
 * each signal (follow-ups, trends, interactions, notes), drops a signal a
 * tool contradicts, and submits the rest as findings with the detectors'
 * verbatim evidence. It never invents a finding: what it shows is the
 * agent loop, the tool protocol and the checks, not clinical judgment.
 */
export const scriptedReviewerResponder: FakeResponder = (request: ProviderRequest<unknown>) => {
  if (request.output.name !== REVIEWER_ACTION_NAME) return undefined;
  const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
  const maxToolCalls = Number(/at most (\d+) tool calls/.exec(system)?.[1] ?? '6');
  const input = request.messages
    .map((message) => (message.role === 'user' ? parseInput(message.content) : undefined))
    .find((parsed) => parsed !== undefined);
  if (input === undefined) {
    return action('No review input found.', 'submit_findings', { findings: [] });
  }
  const observations = request.messages.flatMap((message) => {
    if (message.role !== 'user') return [];
    const observation = parseObservation(message.content);
    return observation === undefined ? [] : [observation];
  });
  const done = request.messages.filter((message) => message.role === 'assistant').length;
  const budgetSpent = observations.some((item) => item.body['error'] === 'tool_budget_exhausted');
  const plan = planCalls(input.signals).slice(0, maxToolCalls);
  const next = plan[done];
  if (next !== undefined && !budgetSpent) {
    return action(
      next.signals.length > 0
        ? `Checking ${next.signals.join(', ')} with ${next.tool}.`
        : 'Checking what the engine already follows up.',
      next.tool,
      next.args,
    );
  }
  const findings = input.signals
    .filter((signal) => !refuted(signal, observations))
    .map((signal) => ({
      category: signal.category,
      severity: signal.severity,
      summary: signal.summary,
      rationale: signal.rationale,
      suggestion: signal.suggestion,
      citations: signal.evidence.map((item) => ({ docId: item.docId, quote: item.quote })),
      signalIds: [signal.id],
      // Both languages, as the prompt asks: the detectors' own renderings.
      ...(signal.texts?.en !== undefined && signal.texts.es !== undefined
        ? { texts: { en: signal.texts.en, es: signal.texts.es } }
        : {}),
    }));
  return action(`Submitting ${String(findings.length)} findings.`, 'submit_findings', { findings });
};
