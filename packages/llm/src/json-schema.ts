import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

/**
 * Converts a zod schema to the JSON Schema sent to the model, with zod's
 * built-in converter. The `$schema` marker is dropped: vendors only need the
 * schema body, and some reject unknown top-level keywords.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const body: JsonSchema = { ...z.toJSONSchema(schema, { target: 'draft-2020-12' }) };
  delete body['$schema'];
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a JSON Schema satisfies the "strict" structured-output rules of
 * the Meta Model API (https://dev.meta.ai/docs/structured-output), which are
 * the same as OpenAI's: plain object root, no `allOf`/`oneOf` anywhere,
 * every object closed (`additionalProperties: false`) and every property
 * required (model optional fields as `nullable` instead).
 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  if (schema['type'] !== 'object') return false;
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'enum', 'not']) {
    if (keyword in schema) return false;
  }
  return everyNodeStrict(schema);
}

function everyNodeStrict(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(everyNodeStrict);
  if (!isRecord(node)) return true;
  if ('allOf' in node || 'oneOf' in node) return false;
  const properties = node['properties'];
  if (node['type'] === 'object' || isRecord(properties)) {
    if (node['additionalProperties'] !== false) return false;
    const keys = isRecord(properties) ? Object.keys(properties) : [];
    const required = Array.isArray(node['required']) ? (node['required'] as unknown[]) : [];
    if (!keys.every((key) => required.includes(key))) return false;
  }
  return Object.values(node).every(everyNodeStrict);
}
