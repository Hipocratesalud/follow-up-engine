import { parseArgs } from 'node:util';
import {
  ConflictError,
  type RuleChangeResult,
  type RuleConfigView,
  type RuleOverride,
  clinicId as toClinicId,
  ValidationError,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import { messagesFor } from './i18n/index.ts';

/** The command line speaks the default API language. */
const LABELS = messagesFor('en').admin;

export const CLINIC_RULES_CLI_USAGE = `Usage: pnpm --filter @follow-up-engine/api clinic:rules --clinic <id> [action]

Per-clinic rule overrides: a different deadline, or a rule switched off. Every
change is versioned and audited (who, when, old -> new, why) and applies to
expectations created afterwards; existing ones keep theirs.

  --clinic <id>                  The clinic (required)
  --list                         Every rule: defaults, override, version (the default action)
  --history [ruleId]             Changes, newest first (one rule's when given)
  --set <ruleId>.dueInDays=<n>   Set a deadline in days (1 to 3650); repeatable
  --set <ruleId>.enabled=<bool>  Switch a rule on or off
  --disable <ruleId>             Switch a rule off (it creates nothing new)
  --reset <ruleId>               Back to the versioned rule
  --reason <text>                Why (required to change anything; kept in the history)
  --actor <name>                 Who (default: the operating system user)
  --help                         This help

Needs DATABASE_URL (the same database the API and the worker use).`;

export interface ClinicRulesCliResult {
  readonly code: number;
  readonly output: string;
}

const SET = /^([a-z0-9_]+)\.(dueInDays|enabled)=(.+)$/;

function fail(message: string): ClinicRulesCliResult {
  return { code: 1, output: `${message}\n\n${CLINIC_RULES_CLI_USAGE}\n` };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function table(rules: readonly RuleConfigView[]): string {
  const header = ['rule', 'layer', 'due in days', 'enabled', 'version', 'changed'];
  const rows = rules.map((rule) => [
    rule.ruleId,
    rule.layer,
    rule.effective.dueInDays === rule.defaults.dueInDays
      ? String(rule.effective.dueInDays)
      : `${String(rule.effective.dueInDays)} (default ${String(rule.defaults.dueInDays)})`,
    rule.effective.enabled ? 'yes' : 'no',
    rule.version,
    rule.override === undefined
      ? '-'
      : `${rule.override.updatedAt.toISOString()} by ${rule.override.updatedBy}`,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => pad(cell, widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function describeOverride(override: RuleOverride | undefined): string {
  if (override === undefined) {
    return '(versioned rule)';
  }
  const parts = [
    ...(override.dueInDays === undefined ? [] : [`dueInDays=${String(override.dueInDays)}`]),
    ...(override.enabled === undefined ? [] : [`enabled=${String(override.enabled)}`]),
  ];
  return parts.join(' ');
}

function describeResult(result: RuleChangeResult): string {
  const { change, rule } = result;
  if (change === undefined) {
    return `${rule.ruleId}: ${LABELS.unchanged}`;
  }
  return (
    `${rule.ruleId} v${String(change.version)} (${change.action}): ` +
    `${describeOverride(change.previous)} -> ${describeOverride(change.next)}; ` +
    `due in ${String(rule.effective.dueInDays)} days, ${rule.effective.enabled ? 'enabled' : 'disabled'}, ` +
    `new expectations carry ${rule.version}`
  );
}

/** Parses the `--set` values into one patch per rule (`lab.dueInDays=10`, `lab.enabled=false`). */
function patches(values: readonly string[]): Map<string, Record<string, unknown>> | string {
  const byRule = new Map<string, Record<string, unknown>>();
  for (const value of values) {
    const match = SET.exec(value.trim());
    if (match === null) {
      return `Invalid --set ${value}: expected <ruleId>.dueInDays=<days> or <ruleId>.enabled=<true|false>.`;
    }
    const [, ruleId = '', field = '', raw = ''] = match;
    let parsed: unknown = raw;
    if (field === 'dueInDays') {
      parsed = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else if (raw === 'true' || raw === 'false') {
      parsed = raw === 'true';
    }
    byRule.set(ruleId, { ...byRule.get(ruleId), [field]: parsed });
  }
  return byRule;
}

/**
 * `clinic:rules`: lists, changes, disables and resets a clinic's rule
 * overrides through the engine (validated, versioned and audited like the
 * admin API).
 */
export async function runClinicRulesCommand(
  runtime: EngineRuntime,
  argv: readonly string[],
  defaults: { readonly actor: string } = { actor: 'cli' },
): Promise<ClinicRulesCliResult> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        clinic: { type: 'string' },
        list: { type: 'boolean' },
        history: { type: 'boolean' },
        set: { type: 'string', multiple: true },
        disable: { type: 'string', multiple: true },
        reset: { type: 'string', multiple: true },
        reason: { type: 'string' },
        actor: { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    return { code: 0, output: `${CLINIC_RULES_CLI_USAGE}\n` };
  }
  if (values.clinic === undefined) {
    return fail('Give --clinic.');
  }
  const clinic = await runtime.storage.clinics.get(toClinicId(values.clinic));
  if (clinic === undefined) {
    return fail(`Clinic ${values.clinic} does not exist.`);
  }
  const rules = runtime.engine.ruleOverrides;
  if (values.history === true) {
    const ruleId = positionals[0];
    const changes = await rules.history(clinic.id, {
      limit: 200,
      ...(ruleId === undefined ? {} : { ruleId }),
    });
    const lines = changes.map(
      (change) =>
        `${change.at.toISOString()}  ${change.ruleId} v${String(change.version)} ${change.action}  ` +
        `${describeOverride(change.previous)} -> ${describeOverride(change.next)}  ` +
        `by ${change.actor}: ${change.reason}`,
    );
    return { code: 0, output: `${lines.length === 0 ? '(no changes)' : lines.join('\n')}\n` };
  }
  const sets = patches(values.set ?? []);
  if (typeof sets === 'string') {
    return fail(sets);
  }
  const disables = values.disable ?? [];
  const resets = values.reset ?? [];
  if (sets.size + disables.length + resets.length === 0) {
    return { code: 0, output: `${table(await rules.list(clinic.id))}\n` };
  }
  const meta = { actor: values.actor ?? defaults.actor, reason: values.reason ?? '' };
  const labels = LABELS;
  const lines: string[] = [];
  try {
    for (const [ruleId, patch] of sets) {
      lines.push(describeResult(await rules.set(clinic.id, ruleId, patch, meta)));
    }
    for (const ruleId of disables) {
      lines.push(describeResult(await rules.disable(clinic.id, ruleId, meta)));
    }
    for (const ruleId of resets) {
      lines.push(describeResult(await rules.reset(clinic.id, ruleId, meta)));
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      const message =
        (labels.fields[error.field as keyof typeof labels.fields] as string | undefined) ??
        labels.fields.unknownField;
      return fail([...lines, `${error.field}: ${message}`].join('\n'));
    }
    if (error instanceof ConflictError) {
      return fail([...lines, labels.staleVersion].join('\n'));
    }
    throw error;
  }
  return { code: 0, output: `${lines.join('\n')}\n` };
}
