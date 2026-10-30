import {
  type ClinicId,
  type LlmMessage,
  LlmOutputError,
  type OrderAgentModel,
  type OrderAgentTurnRequest,
  type OrderAgentTurnResult,
} from '@follow-up-engine/core';
import type { z } from 'zod';
import type { FollowUpLlmGateway } from '../gateway/gateway.ts';
import { issueSummary } from '../providers/structured-output.ts';
import {
  ORDER_AGENT_ACTION_NAME,
  ORDER_AGENT_PROMPT_VERSION,
  ORDER_AGENT_SCRIPTED_TASK,
  ORDER_AGENT_TASK,
  OrderAgentActionSchema,
  orderAgentInitialMessages,
  orderAgentToolResult,
} from './prompt.ts';

export interface OrderAgentModelOptions {
  readonly gateway: FollowUpLlmGateway;
  /** Gateway task of live turns (default {@link ORDER_AGENT_TASK}). */
  readonly liveTask?: string;
  /** Gateway task of scripted turns (default {@link ORDER_AGENT_SCRIPTED_TASK}). */
  readonly scriptedTask?: string;
  /** Per step. Default 3,000 (Muse Spark bills reasoning as output). */
  readonly maxOutputTokens?: number;
}

/** Every string value `"null"` (at any depth) replaced by `null` (models write nullable fields so). */
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

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): z.ZodSafeParseResult<T> {
  const checked = schema.safeParse(args);
  if (checked.success) return checked;
  const lenient = schema.safeParse(nullStrings(args));
  return lenient.success ? lenient : checked;
}

/**
 * The order-to-completion agent on the `llm_gateway`, modeled on the
 * clinical reviewer's loop: each step is one gateway call that returns one
 * tool call (native tool calling on Muse Spark, the same object as
 * structured output on the scripted fake), validated with the tool's zod
 * schema and run by the toolbox (which traces it and enforces every
 * guardrail in code). Past `maxSteps` the turn stops. Budgeted and
 * accounted per clinic by the gateway.
 */
export function createOrderAgentModel(options: OrderAgentModelOptions): OrderAgentModel {
  const maxOutputTokens = options.maxOutputTokens ?? 3_000;

  async function runTurn(
    clinicId: ClinicId,
    request: OrderAgentTurnRequest,
  ): Promise<OrderAgentTurnResult> {
    const task =
      request.mode === 'live'
        ? (options.liveTask ?? ORDER_AGENT_TASK)
        : (options.scriptedTask ?? ORDER_AGENT_SCRIPTED_TASK);
    const { toolbox, redactTerms } = request;
    const definitions = new Map(toolbox.definitions.map((tool) => [tool.name, tool]));
    const tools = toolbox.definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const messages: LlmMessage[] = orderAgentInitialMessages(
      toolbox.definitions,
      request.context,
      redactTerms,
    );
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let modelCalls = 0;
    let toolCalls = 0;
    let model = '';
    const finish = (stopReason: OrderAgentTurnResult['stopReason']): OrderAgentTurnResult => ({
      stopReason,
      modelCalls,
      toolCalls,
      inputTokens,
      outputTokens,
      costUsd,
      model,
    });

    for (let step = 1; step <= request.maxSteps; step += 1) {
      let result;
      try {
        result = await options.gateway.complete(clinicId, {
          task,
          promptVersion: ORDER_AGENT_PROMPT_VERSION,
          messages: [...messages],
          output: { name: ORDER_AGENT_ACTION_NAME, schema: OrderAgentActionSchema },
          tools,
          maxOutputTokens,
        });
      } catch (error) {
        // A model that answers in prose instead of calling end_turn, once it
        // already acted, has finished its turn: nothing it wrote is sent.
        if (error instanceof LlmOutputError && toolCalls > 0) {
          await toolbox.execute(
            'end_turn',
            { summary: 'the model replied in prose: turn ended' },
            '',
          );
          return finish('end_turn');
        }
        throw error;
      }
      modelCalls += 1;
      inputTokens += result.totalUsage.inputTokens;
      outputTokens += result.totalUsage.outputTokens;
      costUsd += result.totalCostUsd;
      model = `${result.provider}:${result.model}`;
      const action = result.output;
      await request.onModelCall({
        index: step,
        model,
        thought: action.thought,
        tool: action.tool,
        inputTokens: result.totalUsage.inputTokens,
        outputTokens: result.totalUsage.outputTokens,
        costUsd: result.totalCostUsd,
        latencyMs: result.latencyMs,
        repaired: result.repaired,
      });
      messages.push({
        role: 'assistant',
        content: JSON.stringify({ tool: action.tool, arguments: action.arguments }),
      });
      const definition = definitions.get(action.tool);
      let parsed: unknown;
      try {
        parsed = JSON.parse(action.arguments);
      } catch {
        parsed = undefined;
      }
      const reject = async (error: string, detail: string): Promise<void> => {
        await toolbox.reject(action.tool, error, detail, action.thought);
        messages.push(orderAgentToolResult(step, action.tool, { error, detail }, redactTerms));
      };
      if (definition === undefined) {
        await reject('unknown_tool', `known tools: ${[...definitions.keys()].join(', ')}`);
        continue;
      }
      if (parsed === undefined || typeof parsed !== 'object') {
        await reject('invalid_arguments', 'arguments is not a JSON object string');
        continue;
      }
      const checked = parseArgs(definition.parameters, parsed);
      if (!checked.success) {
        await reject('invalid_arguments', issueSummary(checked.error));
        continue;
      }
      toolCalls += 1;
      const outcome = await toolbox.execute(definition.name, checked.data, action.thought);
      if (definition.terminal) return finish('end_turn');
      messages.push(
        orderAgentToolResult(
          step,
          definition.name,
          outcome.ok ? outcome.result : { error: outcome.error, detail: outcome.detail ?? null },
          redactTerms,
        ),
      );
    }
    return finish('step_limit');
  }

  return { runTurn };
}
