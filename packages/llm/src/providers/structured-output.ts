import { z } from 'zod';
import { LlmSchemaError } from '../errors.ts';
import type { DetailedUsage } from '../usage.ts';

/**
 * Pulls the JSON value out of a model reply. Tolerates the usual wrappers
 * (Markdown code fences, a sentence before or after the object) because not
 * every endpoint enforces a response format.
 */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Parses and validates a raw model reply against the requested schema.
 * Throws {@link LlmSchemaError} (repairable) with the zod issues, so the
 * gateway can show the model exactly what to fix.
 */
export function parseStructuredOutput<TOutput>(
  provider: string,
  model: string,
  raw: string,
  schema: z.ZodType<TOutput>,
  usage: DetailedUsage,
): TOutput {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonText(raw));
  } catch (cause) {
    throw new LlmSchemaError(provider, {
      model,
      rawOutput: raw,
      issues: `reply is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      usage,
      repairable: true,
      cause,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new LlmSchemaError(provider, {
      model,
      rawOutput: raw,
      issues: z.prettifyError(parsed.error),
      usage,
      repairable: true,
      cause: parsed.error,
    });
  }
  return parsed.data;
}
