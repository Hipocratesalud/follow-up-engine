import type {
  AuthoringAgentRequest,
  AuthoringAgentResult,
  AuthoringStep,
  AuthoringStopReason,
  ClinicId,
  LlmMessage,
  RuleAuthoringAgent,
} from '@follow-up-engine/core';
import { AUTHORING_TOOLS } from '@follow-up-engine/core';
import type { z } from 'zod';
import type { FollowUpLlmGateway } from '../gateway/gateway.ts';
import { issueSummary } from '../providers/structured-output.ts';
import { ReviewerActionSchema } from '../reviewer/prompt.ts';
import {
  authoringToolResult,
  RULE_AUTHORING_ACTION_NAME,
  RULE_AUTHORING_PROMPT_VERSION,
  RULE_AUTHORING_TASK,
  ruleAuthoringMessages,
} from './prompt.ts';

export interface RuleAuthoringAgentOptions {
  readonly gateway: FollowUpLlmGateway;
  /** Gateway task to route (default {@link RULE_AUTHORING_TASK}). */
  readonly task?: string;
  /** Per step. Default 6,000 (Muse Spark bills reasoning as output; a draft is long JSON). */
  readonly maxOutputTokens?: number;
}

/** Argument values safe in the audit trail: ids, codes, short strings; a draft only as its id. */
function auditArguments(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null) return {};
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).flatMap(([key, value]): [string, unknown][] => {
      if (key === 'definition' && typeof value === 'object' && value !== null) {
        const id = (value as { id?: unknown }).id;
        return [[key, typeof id === 'string' ? id.slice(0, 60) : '(draft)']];
      }
      if (typeof value === 'string') return [[key, value.slice(0, 80)]];
      if (typeof value === 'number' || typeof value === 'boolean' || value === null)
        return [[key, value]];
      return [];
    }),
  );
}

/** Every string `"null"` (at any depth) read as `null`: models often write a nullable field so. */
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
 * Tool arguments with every `"null"` string read as `null` first (Muse
 * Spark, 2026-10-30, wrote `{"id": "null"}` for an unused nullable id, which
 * a nullable string schema accepts as the id "null"); the arguments as
 * written when only those validate.
 */
function parseArguments<T>(schema: z.ZodType<T>, args: unknown): z.ZodSafeParseResult<T> {
  const lenient = schema.safeParse(nullStrings(args));
  if (lenient.success) return lenient;
  const checked = schema.safeParse(args);
  return checked.success ? checked : lenient;
}

/**
 * The rule-authoring agent on the `llm_gateway` (modeled on the clinical
 * reviewer's loop): each step is one gateway call returning one tool call;
 * arguments are validated with the tool's zod schema; a malformed or
 * unknown call gets an error back and costs a step; past `maxToolCalls` the
 * model is told to submit; past `maxSteps` or `maxTokens` the loop stops
 * without a draft. The submission is returned untrusted: the engine
 * validates it again and runs its own dry run before storing anything.
 */
export function createRuleAuthoringAgent(options: RuleAuthoringAgentOptions): RuleAuthoringAgent {
  const task = options.task ?? RULE_AUTHORING_TASK;
  const maxOutputTokens = options.maxOutputTokens ?? 6_000;

  async function author(
    clinicId: ClinicId,
    request: AuthoringAgentRequest,
  ): Promise<AuthoringAgentResult> {
    const { limits, toolbox } = request;
    const definitions = new Map(toolbox.definitions.map((tool) => [tool.name, tool]));
    const tools = toolbox.definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const messages: LlmMessage[] = ruleAuthoringMessages(
      request.request,
      toolbox.definitions,
      limits.maxToolCalls,
    );
    const trace: AuthoringStep[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let toolCalls = 0;
    let modelId = '';
    let stopReason: AuthoringStopReason = 'step_limit';
    let submission: unknown;
    let abstention: string | undefined;

    const finish = (): AuthoringAgentResult => ({
      ...(submission === undefined ? {} : { submission }),
      ...(abstention === undefined ? {} : { abstention }),
      stopReason,
      steps: trace.length,
      toolCalls,
      trace,
      inputTokens,
      outputTokens,
      costUsd,
      modelId,
      promptVersion: RULE_AUTHORING_PROMPT_VERSION,
    });

    for (let step = 1; step <= limits.maxSteps; step += 1) {
      if (inputTokens + outputTokens >= limits.maxTokens) {
        stopReason = 'token_budget';
        return finish();
      }
      const result = await options.gateway.complete(clinicId, {
        task,
        promptVersion: RULE_AUTHORING_PROMPT_VERSION,
        messages: [...messages],
        output: { name: RULE_AUTHORING_ACTION_NAME, schema: ReviewerActionSchema },
        tools,
        maxOutputTokens,
      });
      inputTokens += result.totalUsage.inputTokens;
      outputTokens += result.totalUsage.outputTokens;
      costUsd += result.totalCostUsd;
      modelId = `${result.provider}:${result.model}`;
      const stepCost = result.totalCostUsd;
      const action = result.output;
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ tool: action.tool, arguments: action.arguments }),
      });
      const record = (
        tool: string,
        args: Record<string, unknown>,
        outcome: string,
        summary: string,
      ): void => {
        trace.push({
          index: step,
          tool: tool.slice(0, 40),
          arguments: args,
          outcome,
          summary,
          model: modelId,
          costUsd: stepCost,
        });
      };
      const reject = (outcome: string, detail: string): void => {
        record(action.tool, {}, outcome, detail);
        messages.push(authoringToolResult(step, action.tool, { error: outcome, detail }));
      };

      const definition = definitions.get(action.tool);
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(action.arguments);
      } catch {
        parsedArgs = undefined;
      }
      if (definition === undefined) {
        reject('unknown_tool', `known tools: ${[...definitions.keys()].join(', ')}`);
        continue;
      }
      if (parsedArgs === undefined) {
        reject('invalid_arguments', 'arguments is not a JSON object string');
        continue;
      }
      const checked = parseArguments(definition.parameters, parsedArgs);
      if (!checked.success) {
        reject('invalid_arguments', issueSummary(checked.error));
        continue;
      }
      if (definition.terminal) {
        if (definition.name === AUTHORING_TOOLS.abstain) {
          const reason = (checked.data as { reason?: unknown }).reason;
          abstention = typeof reason === 'string' ? reason.slice(0, 300) : '';
          record(definition.name, {}, 'ok', 'abstained');
          stopReason = 'abstained';
          return finish();
        }
        const refusal = toolbox.checkSubmission?.(checked.data);
        if (refusal !== undefined && !refusal.ok) {
          // The engine refused the draft: hand its issues back (one step), not end the run.
          record(definition.name, auditArguments(checked.data), 'invalid_submission', 'refused');
          messages.push(
            authoringToolResult(step, definition.name, {
              error: 'invalid_submission',
              detail: refusal.error,
            }),
          );
          continue;
        }
        submission = checked.data;
        record(definition.name, auditArguments(checked.data), 'ok', 'draft submitted');
        stopReason = 'submitted';
        return finish();
      }
      if (toolCalls >= limits.maxToolCalls) {
        reject('tool_budget_exhausted', 'no tool calls left: call submit_draft now');
        continue;
      }
      toolCalls += 1;
      const execution = await toolbox.execute(definition.name, checked.data);
      record(
        definition.name,
        auditArguments(checked.data),
        execution.ok ? 'ok' : execution.error,
        execution.ok ? execution.summary : execution.error,
      );
      messages.push(
        authoringToolResult(
          step,
          definition.name,
          execution.ok ? execution.result : { error: execution.error },
        ),
      );
    }
    return finish();
  }

  return { author };
}
