import type { z } from 'zod';
import { ConfigIdSchema, type EscalationPolicy, EscalationPolicySchema } from './common.ts';
import { type Protocol, ProtocolSchema } from './protocol.ts';
import { type Rule, RuleSchema } from './rule.ts';
import { overriddenRuleVersion, type RuleOverride } from '../domain/rule-override.ts';

/** A versioned config document failed validation. `issues` are human-readable, one per problem. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.issues = issues;
  }
}

/** An escalation policy stored in its own file and referenced by id. */
export const NamedEscalationPolicySchema = EscalationPolicySchema.extend({ id: ConfigIdSchema });
export type NamedEscalationPolicy = z.infer<typeof NamedEscalationPolicySchema>;

/** Options shared by the loaders. */
export interface LoadOptions {
  /** Names of the documents (file paths), used in error messages. Defaults to `document[<index>]`. */
  readonly documentNames?: readonly string[];
}

export interface LoadWithPoliciesOptions extends LoadOptions {
  /**
   * Named escalation policies. A rule or protocol may reference one by id
   * (`"escalationPolicy": "default_v1"`) instead of inlining its steps.
   */
  readonly escalationPolicies?: readonly EscalationPolicy[];
}

function documentName(options: LoadOptions | undefined, index: number): string {
  return options?.documentNames?.[index] ?? `document[${String(index)}]`;
}

/** A document may hold one definition or an array of them. */
function flatten(
  documents: readonly unknown[],
  options: LoadOptions | undefined,
): { readonly value: unknown; readonly where: string }[] {
  return documents.flatMap((document, index) => {
    const name = documentName(options, index);
    return Array.isArray(document)
      ? document.map((value: unknown, position) => ({
          value,
          where: `${name}[${String(position)}]`,
        }))
      : [{ value: document, where: name }];
  });
}

function formatIssues(where: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) =>
      `${where}${issue.path.length > 0 ? `.${issue.path.join('.')}` : ''}: ${issue.message}`,
  );
}

function resolvePolicyReference(
  value: unknown,
  policies: ReadonlyMap<string, EscalationPolicy>,
  where: string,
  issues: string[],
): unknown {
  if (typeof value !== 'object' || value === null || !('escalationPolicy' in value)) {
    return value;
  }
  const reference = value.escalationPolicy;
  if (typeof reference !== 'string') {
    return value;
  }
  const policy = policies.get(reference);
  if (policy === undefined) {
    issues.push(`${where}.escalationPolicy: unknown escalation policy "${reference}"`);
    return value;
  }
  return { ...value, escalationPolicy: policy };
}

function loadAll<TOutput extends { readonly id: string }>(
  schema: z.ZodType<TOutput>,
  documents: readonly unknown[],
  options: LoadWithPoliciesOptions | undefined,
  kind: string,
): TOutput[] {
  const policies = new Map(
    (options?.escalationPolicies ?? []).flatMap((policy) =>
      policy.id === undefined ? [] : [[policy.id, policy] as const],
    ),
  );
  const issues: string[] = [];
  const loaded: TOutput[] = [];
  const seen = new Set<string>();
  for (const { value, where } of flatten(documents, options)) {
    const parsed = schema.safeParse(resolvePolicyReference(value, policies, where, issues));
    if (!parsed.success) {
      issues.push(...formatIssues(where, parsed.error));
      continue;
    }
    if (seen.has(parsed.data.id)) {
      issues.push(`${where}: duplicate ${kind} id "${parsed.data.id}"`);
      continue;
    }
    seen.add(parsed.data.id);
    loaded.push(parsed.data);
  }
  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
  return loaded;
}

/**
 * Validates named escalation policies (config/rules/escalation/*.json).
 * Every policy must carry an `id`.
 *
 * @throws {ConfigValidationError}
 */
export function loadEscalationPoliciesFromJson(
  documents: readonly unknown[],
  options?: LoadOptions,
): NamedEscalationPolicy[] {
  return loadAll(NamedEscalationPolicySchema, documents, options, 'escalation policy');
}

/**
 * Validates rule documents (config/rules/*.json; each one a rule or an array
 * of rules) against {@link RuleSchema}, resolving escalation policy
 * references. Pure: the caller reads the files.
 *
 * @throws {ConfigValidationError} listing every problem found, not only the first.
 */
export function loadRulesFromJson(
  documents: readonly unknown[],
  options?: LoadWithPoliciesOptions,
): Rule[] {
  return loadAll(RuleSchema, documents, options, 'rule');
}

/**
 * Validates protocol documents (config/protocols/*.json) against
 * {@link ProtocolSchema}, resolving escalation policy references.
 *
 * @throws {ConfigValidationError}
 */
export function loadProtocolsFromJson(
  documents: readonly unknown[],
  options?: LoadWithPoliciesOptions,
): Protocol[] {
  return loadAll(ProtocolSchema, documents, options, 'protocol');
}

/**
 * Applies a clinic's overrides (for example a 10-day lab deadline instead of
 * 15) and drops the rules it disabled. An override carrying its `version`
 * (a stored override) stamps the rule's version with it (`1.0.0+clinic.3`),
 * so expectations created under it say which configuration made them.
 */
export function applyRuleOverrides(
  rules: readonly Rule[],
  overrides: Readonly<Record<string, RuleOverride & { readonly version?: number }>>,
): Rule[] {
  return rules.flatMap((rule) => {
    const override = overrides[rule.id];
    if (override === undefined) {
      return [rule];
    }
    if (override.enabled === false) {
      return [];
    }
    return [
      {
        ...rule,
        dueInDays: override.dueInDays ?? rule.dueInDays,
        version: overriddenRuleVersion(rule.version, override.version),
      },
    ];
  });
}
