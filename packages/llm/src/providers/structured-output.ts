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
 * A log-safe summary of zod issues: codes and schema paths only (the paths
 * of a closed schema are its own keys and array indices), never the values
 * or unknown keys the model sent.
 */
export function issueSummary(error: z.ZodError): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path
      .map((segment) => (typeof segment === 'number' ? `[${String(segment)}]` : String(segment)))
      .join('.')
      .replace(/\.\[/g, '[');
    return `${path === '' ? '(root)' : path}: ${issue.code}`;
  });
  const more =
    error.issues.length > shown.length
      ? ` (+${String(error.issues.length - shown.length)} more)`
      : '';
  return `${String(error.issues.length)} schema issue(s): ${shown.join('; ')}${more}`;
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
  } catch {
    // The parser's message quotes the reply; neither it nor the cause is kept.
    throw new LlmSchemaError(provider, {
      model,
      rawOutput: raw,
      issues: 'reply is not valid JSON',
      summary: 'reply is not valid JSON',
      usage,
      repairable: true,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new LlmSchemaError(provider, {
      model,
      rawOutput: raw,
      issues: z.prettifyError(parsed.error),
      summary: issueSummary(parsed.error),
      usage,
      repairable: true,
    });
  }
  return parsed.data;
}
