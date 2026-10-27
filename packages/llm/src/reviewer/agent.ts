import {
  type ClinicalReviewAgent,
  type ClinicId,
  type LlmMessage,
  type ProposedFinding,
  type ReviewAgentRequest,
  type ReviewAgentResult,
  type ReviewStep,
  type ReviewStopReason,
  SubmitFindingsArgs,
} from '@follow-up-engine/core';
import type { z } from 'zod';
import { prepareNote } from '../extraction/prepare.ts';
import { createQuoteIndex } from '../extraction/quote.ts';
import type { FollowUpLlmGateway } from '../gateway/gateway.ts';
import { issueSummary } from '../providers/structured-output.ts';
import {
  CLINICAL_REVIEW_PROMPT_VERSION,
  CLINICAL_REVIEW_TASK,
  initialMessages,
  REVIEWER_ACTION_NAME,
  ReviewerActionSchema,
  toolResultMessage,
} from './prompt.ts';

export interface ReviewAgentOptions {
  readonly gateway: FollowUpLlmGateway;
  /** Gateway task to route (default {@link CLINICAL_REVIEW_TASK}). */
  readonly task?: string;
  /** Per step. Default 4,000 (Muse Spark bills reasoning as output). */
  readonly maxOutputTokens?: number;
}

/** Keeps only argument values that are safe in the audit trail: short strings, numbers, ids. */
function auditArguments(tool: string, args: unknown): Record<string, unknown> {
  if (tool === 'submit_findings') {
    const findings = (args as { findings?: unknown[] } | undefined)?.findings;
    return { findings: Array.isArray(findings) ? findings.length : 0 };
  }
  if (typeof args !== 'object' || args === null) return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).flatMap(([key, value]): [string, unknown][] => {
      if (typeof value === 'string') return [[key, value.slice(0, 60)]];
      if (Array.isArray(value))
        return [[key, value.filter((item) => typeof item === 'string').slice(0, 8)]];
      if (typeof value === 'number' || typeof value === 'boolean' || value === null)
        return [[key, value]];
      return [];
    }),
  );
}

/**
 * The quote as the original document has it. The model read masked text
 * ("[REDACTADO]" for names), so its quote is located in the masked document
 * and mapped back; a quote found in neither is returned unchanged and the
 * engine's verbatim check drops the finding.
 */
export function quoteFromOriginal(
  original: string | undefined,
  quote: string,
  redactTerms: readonly string[],
): string {
  if (original === undefined) return quote;
  const direct = createQuoteIndex(original).locate(quote);
  if (direct !== undefined) return direct.text;
  const prepared = prepareNote(original, { redactTerms, maxChars: Number.MAX_SAFE_INTEGER });
  const span = createQuoteIndex(prepared.text).locate(quote);
  if (span === undefined) return quote;
  const mapped = prepared.toOriginal(span.start, span.end);
  return original.slice(mapped.start, mapped.end);
}

/**
 * The clinical reviewer agent on the `llm_gateway`. A bounded loop: each
 * step is one gateway call returning one tool call (native tool calling on
 * providers that support it, the same action object as structured output
 * elsewhere); arguments are validated with the tool's zod schema; a
 * malformed or unknown call gets an error back and costs a step; read-only
 * tools run over the patient's dossier only; past `maxToolCalls` the model
 * is told to submit; past `maxSteps` or `maxTokens` the loop stops without
 * findings (the engine then falls back to its detectors). Every call is
 * budgeted and accounted by the gateway.
 */
export function createReviewAgent(options: ReviewAgentOptions): ClinicalReviewAgent {
  const task = options.task ?? CLINICAL_REVIEW_TASK;
  const maxOutputTokens = options.maxOutputTokens ?? 4_000;

  async function review(
    clinicId: ClinicId,
    request: ReviewAgentRequest,
  ): Promise<ReviewAgentResult> {
    const { limits, toolbox, redactTerms } = request;
    const definitions = new Map(
      toolbox.definitions.map((definition) => [definition.name, definition]),
    );
    const tools = toolbox.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }));
    const messages: LlmMessage[] = initialMessages(
      request.input,
      toolbox.definitions,
      limits.maxToolCalls,
      redactTerms,
      request.locale,
    );
    const trace: ReviewStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let toolCalls = 0;
    let modelId = '';
    let stopReason: ReviewStopReason = 'step_limit';
    let proposals: ProposedFinding[] = [];

    const finish = (): ReviewAgentResult => ({
      proposals,
      stopReason,
      steps: trace.length,
      toolCalls,
      trace,
      inputTokens,
      outputTokens,
      costUsd,
      modelId,
      promptVersion: CLINICAL_REVIEW_PROMPT_VERSION,
    });

    for (let step = 1; step <= limits.maxSteps; step += 1) {
      if (inputTokens + outputTokens >= limits.maxTokens) {
        stopReason = 'token_budget';
        return finish();
      }
      const result = await options.gateway.complete(clinicId, {
        task,
        promptVersion: CLINICAL_REVIEW_PROMPT_VERSION,
        // A copy: the conversation keeps growing after this call.
        messages: [...messages],
        output: { name: REVIEWER_ACTION_NAME, schema: ReviewerActionSchema },
        tools,
        maxOutputTokens,
      });
      inputTokens += result.totalUsage.inputTokens;
      outputTokens += result.totalUsage.outputTokens;
      costUsd += result.totalCostUsd;
      modelId = `${result.provider}:${result.model}`;
      const action = result.output;
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ tool: action.tool, arguments: action.arguments }),
      });

      const definition = definitions.get(action.tool);
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(action.arguments);
      } catch {
        parsedArgs = undefined;
      }
      const reject = (outcome: string, detail: string): void => {
        trace.push({
          index: step,
          tool: action.tool.slice(0, 40),
          arguments: {},
          outcome,
          summary: detail,
        });
        messages.push(toolResultMessage(step, action.tool, { error: outcome, detail }, []));
      };
      if (definition === undefined) {
        reject('unknown_tool', `known tools: ${[...definitions.keys()].join(', ')}`);
        continue;
      }
      if (parsedArgs === undefined) {
        reject('invalid_arguments', 'arguments is not a JSON object string');
        continue;
      }
      const checked = parseToolArguments(definition.parameters, parsedArgs);
      if (!checked.success) {
        reject('invalid_arguments', issueSummary(checked.error));
        continue;
      }
      if (definition.terminal) {
        const submission = SubmitFindingsArgs.parse(checked.data);
        proposals = submission.findings.map((finding) => ({
          ...finding,
          citations: finding.citations.map((citation) => ({
            docId: citation.docId,
            quote: quoteFromOriginal(
              request.documents.get(citation.docId),
              citation.quote,
              redactTerms,
            ),
          })),
        }));
        trace.push({
          index: step,
          tool: definition.name,
          arguments: auditArguments(definition.name, checked.data),
          outcome: 'ok',
          summary: `${String(proposals.length)} findings`,
        });
        stopReason = 'submitted';
        return finish();
      }
      if (toolCalls >= limits.maxToolCalls) {
        reject('tool_budget_exhausted', 'no tool calls left: call submit_findings now');
        continue;
      }
      toolCalls += 1;
      const execution = toolbox.execute(definition.name, checked.data);
      trace.push({
        index: step,
        tool: definition.name,
        arguments: auditArguments(definition.name, checked.data),
        outcome: execution.ok ? 'ok' : execution.error,
        summary: execution.ok ? execution.summary : execution.error,
      });
      messages.push(
        toolResultMessage(
          step,
          definition.name,
          execution.ok ? execution.result : { error: execution.error },
          redactTerms,
        ),
      );
    }
    return finish();
  }

  return { review };
}

/** Every string value `"null"` (at any depth) replaced by `null`. */
function nullStrings(value: unknown): unknown {
  if (value === 'null') return null;
  if (Array.isArray(value)) return value.map(nullStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, nullStrings(inner)]),
    );
  }
  return value;
}

/**
 * Validates tool arguments with the tool's schema. When they fail, they are
 * validated once more with every `"null"` string read as `null`: models
 * (Muse Spark among them, 2026-10-27) often write a nullable field as the
 * string `"null"`. The retry is accepted only when it validates, so a
 * required string is never silently nulled.
 */
function parseToolArguments<T>(schema: z.ZodType<T>, args: unknown): z.ZodSafeParseResult<T> {
  const checked = schema.safeParse(args);
  if (checked.success) return checked;
  const lenient = schema.safeParse(nullStrings(args));
  return lenient.success ? lenient : checked;
}
