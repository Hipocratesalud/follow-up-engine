import { applyRuleOverrides } from '../../config/loader.ts';
import type { Protocol } from '../../config/protocol.ts';
import type { Rule } from '../../config/rule.ts';
import type { AuthoredDefinition } from '../../domain/authored-rule.ts';
import { parsedRuleOverride, RuleOverrideSchema } from '../../config/rule-override.ts';
import { ValidationError } from '../../domain/errors.ts';
import type { ClinicId } from '../../domain/ids.ts';
import {
  MAX_OVERRIDE_DUE_IN_DAYS,
  overriddenRuleVersion,
  RULE_OVERRIDE_FIELDS,
  type RuleOverride,
  type RuleOverrideChange,
  type RuleOverrideRecord,
} from '../../domain/rule-override.ts';
import type { Clock } from '../../ports/clock.ts';
import type { RuleSource } from '../../ports/config-sources.ts';
import type { RuleOverrideStore } from '../../ports/rule-override-store.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';

/** The reads the rule source needs from the overrides store. */
export type OverrideReader = Pick<RuleOverrideStore, 'revision' | 'list'>;

interface CachedRules {
  readonly revision: number;
  readonly base: readonly Rule[];
  readonly rules: readonly Rule[];
  readonly retired: readonly Rule[];
  /** Clinic-authored protocols a clinician enabled (versioned like the rules). */
  readonly protocols: readonly Protocol[];
}

/**
 * Whether a clinic-authored definition runs: a clinician enabled it and
 * nobody switched it off since. A draft never runs.
 */
export function authoredIsLive(override: RuleOverride): boolean {
  return override.authored?.status === 'enabled' && override.enabled !== false;
}

/** A clinic-authored definition, stamped with its override version (`1.0.0+clinic.2`). */
function authoredVersioned(record: RuleOverrideRecord): AuthoredDefinition | undefined {
  const definition = record.override.authored?.definition;
  if (definition === undefined) {
    return undefined;
  }
  return definition.kind === 'rule'
    ? {
        kind: 'rule',
        rule: {
          ...definition.rule,
          version: overriddenRuleVersion(definition.rule.version, record.version),
        },
      }
    : {
        kind: 'protocol',
        protocol: {
          ...definition.protocol,
          version: overriddenRuleVersion(definition.protocol.version, record.version),
        },
      };
}

/**
 * The engine's {@link RuleSource}: the clinic's validated rules (`base`)
 * with the clinic's stored overrides applied (a different deadline, a rule
 * switched off). Overrides change the rule's version (`1.0.0+clinic.3`), so
 * an expectation created after a change carries the new version while
 * existing ones keep theirs.
 *
 * Cached per clinic and validated against the store's `revision` on every
 * read (one indexed query): a change made by another process (the API
 * changed a deadline, the worker builds the next catalog) is seen at once.
 * {@link invalidate} drops the entry in this process right after a change.
 */
export class OverridingRuleSource implements RuleSource {
  readonly #base: RuleSource;
  readonly #overrides: OverrideReader;
  readonly #cache = new Map<ClinicId, CachedRules>();

  /**
   * @param overrides where the clinic's overrides are read: a store outside
   *   any transaction (catalogs are also loaded inside one, and the memory
   *   unit of work does not nest), or a unit of work as a fallback.
   */
  constructor(base: RuleSource, overrides: OverrideReader | UnitOfWork) {
    this.#base = base;
    this.#overrides =
      'withTransaction' in overrides
        ? {
            revision: (clinicId) =>
              overrides.withTransaction(clinicId, (stores) =>
                stores.ruleOverrides.revision(clinicId),
              ),
            list: (clinicId) =>
              overrides.withTransaction(clinicId, (stores) => stores.ruleOverrides.list(clinicId)),
          }
        : overrides;
  }

  /** The validated rules, before any clinic override. */
  get base(): RuleSource {
    return this.#base;
  }

  async listRules(clinicId: ClinicId): Promise<readonly Rule[]> {
    return (await this.#load(clinicId)).rules;
  }

  async getRule(clinicId: ClinicId, ruleId: string): Promise<Rule | undefined> {
    return (await this.listRules(clinicId)).find((rule) => rule.id === ruleId);
  }

  /**
   * Rules the clinic switched off: they draft nothing new, but the engine
   * still knows them, so expectations created before keep being fulfilled,
   * escalated and closed under the rule they were created with.
   */
  async listRetiredRules(clinicId: ClinicId): Promise<readonly Rule[]> {
    return (await this.#load(clinicId)).retired;
  }

  /**
   * Protocols the clinic wrote for itself and a clinician enabled
   * (`RuleOverride.authored`). Drafts are never listed.
   */
  async listAuthoredProtocols(clinicId: ClinicId): Promise<readonly Protocol[]> {
    return (await this.#load(clinicId)).protocols;
  }

  /** Drops the clinic's cached rules (called after a change in this process). */
  invalidate(clinicId: ClinicId): void {
    this.#cache.delete(clinicId);
  }

  async #load(clinicId: ClinicId): Promise<CachedRules> {
    const base = await this.#base.listRules(clinicId);
    const cached = this.#cache.get(clinicId);
    const revision = await this.#overrides.revision(clinicId);
    if (cached?.revision === revision && cached.base === base) {
      return cached;
    }
    const records = await this.#overrides.list(clinicId);
    const overrides = records.filter((record) => record.override.authored === undefined);
    const byRule = Object.fromEntries(
      overrides.map((record) => [record.ruleId, { ...record.override, version: record.version }]),
    );
    const rules = applyRuleOverrides(base, byRule);
    const enabled = new Set(rules.map((rule) => rule.id));
    const baseIds = new Set(base.map((rule) => rule.id));
    // Clinic-authored rules: live once a clinician enabled them; a disabled
    // one stays known (its expectations still close); a draft is invisible.
    const authored = records.flatMap((record) => {
      const definition = authoredVersioned(record);
      return definition === undefined || baseIds.has(record.ruleId)
        ? []
        : [
            {
              definition,
              live: authoredIsLive(record.override),
              // Enabled once, then switched off: still known, drafts nothing.
              retired:
                record.override.authored?.status === 'enabled' && !authoredIsLive(record.override),
            },
          ];
    });
    const authoredRules = authored.flatMap((item) =>
      item.definition.kind === 'rule' ? [{ ...item, rule: item.definition.rule }] : [],
    );
    const entry: CachedRules = {
      revision,
      base,
      rules: [...rules, ...authoredRules.filter((item) => item.live).map((item) => item.rule)],
      retired: [
        ...base
          .filter((rule) => !enabled.has(rule.id))
          .map((rule) => ({
            ...rule,
            version: overriddenRuleVersion(rule.version, byRule[rule.id]?.version),
          })),
        ...authoredRules.filter((item) => item.retired).map((item) => item.rule),
      ],
      protocols: authored.flatMap((item) =>
        item.live && item.definition.kind === 'protocol' ? [item.definition.protocol] : [],
      ),
    };
    this.#cache.set(clinicId, entry);
    return entry;
  }
}

/** One rule as a clinic runs it: its defaults, the override in force and the result. */
export interface RuleConfigView {
  readonly ruleId: string;
  readonly layer: Rule['layer'];
  /** English, for maintainers. */
  readonly description: string;
  readonly defaults: { readonly dueInDays: number; readonly enabled: true };
  readonly effective: { readonly dueInDays: number; readonly enabled: boolean };
  /** The version new expectations of the rule carry (`1.0.0`, `1.0.0+clinic.2`). */
  readonly version: string;
  /** Absent when the rule runs as versioned. */
  readonly override?: RuleOverrideRecord;
}

/** Who changes a rule, and why: both are kept in the history. */
export interface RuleChangeMeta {
  readonly actor: string;
  readonly reason: string;
  /** The rule's override version the change was based on (optimistic concurrency). */
  readonly expectedVersion?: number;
}

export interface RuleChangeResult {
  /** The change written; absent when the request changed nothing. */
  readonly change?: RuleOverrideChange;
  readonly rule: RuleConfigView;
}

/**
 * Per-clinic rule configuration: deadlines and switches, versioned and
 * audited. A change applies to expectations created after it; existing ones
 * keep the deadline and the rule version they were created with.
 */
export interface RuleOverrideCommands {
  /** Every rule of the clinic's validated config, with its override. */
  list(clinicId: ClinicId): Promise<readonly RuleConfigView[]>;
  /**
   * Overrides fields of a rule (`{ dueInDays: 10 }`, `{ enabled: false }`),
   * keeping the other fields of its current override. A field set back to
   * the rule's own value is dropped; an override left empty is a reset.
   * `ValidationError` for an unknown rule or field, a deadline under one
   * day, a missing actor or reason; `ConflictError` when `expectedVersion`
   * is stale.
   */
  set(
    clinicId: ClinicId,
    ruleId: string,
    patch: unknown,
    meta: RuleChangeMeta,
  ): Promise<RuleChangeResult>;
  /** `set(..., { enabled: false })`: the rule creates nothing new for the clinic. */
  disable(clinicId: ClinicId, ruleId: string, meta: RuleChangeMeta): Promise<RuleChangeResult>;
  /** Removes the override: the rule runs as versioned again. */
  reset(clinicId: ClinicId, ruleId: string, meta: RuleChangeMeta): Promise<RuleChangeResult>;
  /** Changes, newest first. */
  history(
    clinicId: ClinicId,
    query?: { readonly ruleId?: string; readonly limit?: number },
  ): Promise<readonly RuleOverrideChange[]>;
}

/** Longest reason kept with a change. */
export const MAX_RULE_CHANGE_REASON_LENGTH = 500;

function sameOverride(left: RuleOverride | undefined, right: RuleOverride | undefined): boolean {
  return (
    left?.dueInDays === right?.dueInDays && (left?.enabled ?? true) === (right?.enabled ?? true)
  );
}

/** The override without fields equal to the rule's own values; `undefined` when nothing is left. */
function normalized(rule: Rule, override: RuleOverride): RuleOverride | undefined {
  const next: { -readonly [K in keyof RuleOverride]: RuleOverride[K] } = {};
  if (override.dueInDays !== undefined && override.dueInDays !== rule.dueInDays) {
    next.dueInDays = override.dueInDays;
  }
  if (override.enabled === false) {
    next.enabled = false;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

function parsePatch(patch: unknown): RuleOverride {
  const parsed = RuleOverrideSchema.safeParse(patch);
  if (parsed.success) {
    const override = parsedRuleOverride(parsed.data);
    if (Object.keys(override).length === 0) {
      throw new ValidationError(
        'override',
        `Give at least one of ${RULE_OVERRIDE_FIELDS.join(', ')}`,
      );
    }
    return override;
  }
  const [issue] = parsed.error.issues;
  if (issue?.code === 'unrecognized_keys') {
    throw new ValidationError(
      issue.keys[0] ?? 'override',
      `Unknown field(s) ${issue.keys.join(', ')}: only ${RULE_OVERRIDE_FIELDS.join(', ')} can be overridden`,
    );
  }
  const field = typeof issue?.path[0] === 'string' ? issue.path[0] : 'override';
  throw new ValidationError(
    field,
    field === 'dueInDays'
      ? `dueInDays must be a whole number of days between 1 and ${String(MAX_OVERRIDE_DUE_IN_DAYS)}`
      : (issue?.message ?? 'Invalid override'),
  );
}

function checkMeta(meta: RuleChangeMeta): RuleChangeMeta {
  const actor = meta.actor.trim();
  const reason = meta.reason.trim();
  if (actor === '') {
    throw new ValidationError('actor', 'Say who makes the change');
  }
  if (reason === '' || reason.length > MAX_RULE_CHANGE_REASON_LENGTH) {
    throw new ValidationError(
      'reason',
      `Give the reason for the change (1 to ${String(MAX_RULE_CHANGE_REASON_LENGTH)} characters)`,
    );
  }
  return { ...meta, actor, reason };
}

export interface RuleOverrideCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly rules: OverridingRuleSource;
  readonly clock: Clock;
}

export function createRuleOverrideCommands(deps: RuleOverrideCommandDeps): RuleOverrideCommands {
  function view(rule: Rule, record: RuleOverrideRecord | undefined): RuleConfigView {
    return {
      ruleId: rule.id,
      layer: rule.layer,
      description: rule.description,
      defaults: { dueInDays: rule.dueInDays, enabled: true },
      effective: {
        dueInDays: record?.override.dueInDays ?? rule.dueInDays,
        enabled: record?.override.enabled ?? true,
      },
      version: overriddenRuleVersion(rule.version, record?.version),
      ...(record === undefined ? {} : { override: record }),
    };
  }

  async function knownRule(clinicId: ClinicId, ruleId: string): Promise<Rule> {
    const rule = await deps.rules.base.getRule(clinicId, ruleId);
    if (rule === undefined) {
      throw new ValidationError('ruleId', `Unknown rule ${ruleId} for this clinic`);
    }
    return rule;
  }

  async function change(
    clinicId: ClinicId,
    ruleId: string,
    next: (rule: Rule, current: RuleOverride | undefined) => RuleOverride | undefined,
    rawMeta: RuleChangeMeta,
  ): Promise<RuleChangeResult> {
    const meta = checkMeta(rawMeta);
    const rule = await knownRule(clinicId, ruleId);
    const result = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const current = await stores.ruleOverrides.get(clinicId, ruleId);
      const wanted = next(rule, current?.override);
      if (sameOverride(current?.override, wanted)) {
        return { record: current };
      }
      const written = await stores.ruleOverrides.write(clinicId, {
        ruleId,
        ...(wanted === undefined ? {} : { override: wanted }),
        actor: meta.actor,
        reason: meta.reason,
        at: deps.clock.now(),
        ...(meta.expectedVersion === undefined ? {} : { expectedVersion: meta.expectedVersion }),
      });
      return { change: written, record: await stores.ruleOverrides.get(clinicId, ruleId) };
    });
    if (result.change !== undefined) {
      deps.rules.invalidate(clinicId);
    }
    return {
      ...(result.change === undefined ? {} : { change: result.change }),
      rule: view(rule, result.record),
    };
  }

  return {
    async list(clinicId) {
      const base = await deps.rules.base.listRules(clinicId);
      const records = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.ruleOverrides.list(clinicId),
      );
      const byRule = new Map(records.map((record) => [record.ruleId, record]));
      return [...base]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((rule) => view(rule, byRule.get(rule.id)));
    },
    async set(clinicId, ruleId, patch, meta) {
      const parsed = parsePatch(patch);
      return await change(
        clinicId,
        ruleId,
        (rule, current) => normalized(rule, { ...current, ...parsed }),
        meta,
      );
    },
    disable(clinicId, ruleId, meta) {
      return change(
        clinicId,
        ruleId,
        (rule, current) => normalized(rule, { ...current, enabled: false }),
        meta,
      );
    },
    reset(clinicId, ruleId, meta) {
      return change(clinicId, ruleId, () => undefined, meta);
    },
    history(clinicId, query) {
      return deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.ruleOverrides.history(clinicId, query),
      );
    },
  };
}
