import type { AuthoredRule } from './authored-rule.ts';
import type { ClinicId } from './ids.ts';

/**
 * A clinic's override of one versioned rule (config/rules): a different
 * deadline (`dueInDays`: a 10-day lab deadline instead of 15), or the rule
 * switched off (`enabled: false`). Absent fields keep the rule's own value.
 */
export interface RuleOverride {
  readonly dueInDays?: number;
  readonly enabled?: boolean;
  /**
   * A rule the clinic wrote for itself (the rule-authoring agent's draft,
   * see {@link AuthoredRule}): the override then holds the whole
   * definition, under an id no versioned rule has. Never set through
   * `RuleOverrideCommands.set` (only `dueInDays` and `enabled` are).
   */
  readonly authored?: AuthoredRule;
}

/** The fields a clinic may override, and nothing else. */
export const RULE_OVERRIDE_FIELDS = ['dueInDays', 'enabled'] as const;
export type RuleOverrideField = (typeof RULE_OVERRIDE_FIELDS)[number];

/** Longest deadline an override may set (ten years): anything longer is a typo. */
export const MAX_OVERRIDE_DUE_IN_DAYS = 3650;

/** The override in force for a clinic and rule. */
export interface RuleOverrideRecord {
  readonly clinicId: ClinicId;
  readonly ruleId: string;
  readonly override: RuleOverride;
  /**
   * 1-based, per clinic and rule. Every change, a reset included, takes the
   * next number, so an expectation's rule version (`1.0.0+clinic.3`) names
   * exactly the configuration it was created under.
   */
  readonly version: number;
  readonly updatedAt: Date;
  /** Who changed it (a host user id, an operator name). */
  readonly updatedBy: string;
  readonly reason: string;
}

/** `set` writes an override; `reset` removes it (the rule is back to its versioned config). */
export type RuleOverrideAction = 'set' | 'reset';

/** One entry of the append-only history of a clinic's overrides: who, when, old → new, why. */
export interface RuleOverrideChange {
  readonly clinicId: ClinicId;
  readonly ruleId: string;
  readonly version: number;
  readonly action: RuleOverrideAction;
  /** The override before the change; absent when the rule had none. */
  readonly previous?: RuleOverride;
  /** The override after the change; absent after a reset. */
  readonly next?: RuleOverride;
  readonly actor: string;
  readonly reason: string;
  readonly at: Date;
}

/**
 * The version of a rule as a clinic runs it: the versioned config's own
 * (`1.0.0`) or, under an override, semver build metadata naming it
 * (`1.0.0+clinic.3`). Stored on each expectation (`ruleVersion`).
 */
export function overriddenRuleVersion(baseVersion: string, overrideVersion?: number): string {
  return overrideVersion === undefined
    ? baseVersion
    : `${baseVersion}+clinic.${String(overrideVersion)}`;
}
