import {
  type AuthoredDefinition,
  authoredDefinitionId,
  type AuthoredRule,
  type RuleDryRunReport,
} from '../../domain/authored-rule.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { RuleOverrideChange, RuleOverrideRecord } from '../../domain/rule-override.ts';
import type { Clock } from '../../ports/clock.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import type { OverridingRuleSource } from '../rules/overrides.ts';
import { authoredIsLive } from '../rules/overrides.ts';
import { type DryRunDeps, dryRunAuthoredDefinition } from './dry-run.ts';

/** A clinic-authored rule as the clinic sees it: its record, and whether it runs. */
export interface AuthoredRuleView {
  readonly ruleId: string;
  readonly authored: AuthoredRule;
  /** Runs for the clinic now (enabled and not switched off). A draft never does. */
  readonly live: boolean;
  /** The override version (`clinic.N` in the expectations' rule version). */
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string;
}

/** What a change did, with the change kept in the override history. */
export interface AuthoredRuleChangeResult {
  readonly change: RuleOverrideChange;
  readonly rule?: AuthoredRuleView;
}

/** A draft as the authoring service saves it. */
export type AuthoredDraftInput = Omit<AuthoredRule, 'status' | 'validatedBy' | 'validatedAt'>;

/**
 * Clinic-authored rules (docs/agent/rule-authoring.md), kept in the
 * clinic's rule overrides (`RuleOverride.authored`): versioned and audited
 * like every override. A draft never runs; only {@link enable}, by a named
 * clinician, makes it live, and the clinician is recorded (`validatedBy`).
 */
export interface AuthoredRuleCommands {
  /** The clinic's authored rules, drafts and enabled ones, newest first. */
  list(clinicId: ClinicId): Promise<readonly AuthoredRuleView[]>;
  get(clinicId: ClinicId, ruleId: string): Promise<AuthoredRuleView | undefined>;
  /**
   * Stores a draft (`status: draft`), replacing an earlier draft of the same
   * id. `ValidationError` when the id is a versioned rule's or an enabled
   * clinic rule's.
   */
  saveDraft(
    clinicId: ClinicId,
    draft: AuthoredDraftInput,
    meta: { readonly actor: string; readonly reason: string },
  ): Promise<AuthoredRuleChangeResult>;
  /**
   * "Enable for this clinic": the draft runs from now on, for new events
   * (existing records are not re-annotated: a rule change is never
   * retroactive). `validatedBy` is the clinician.
   */
  enable(
    clinicId: ClinicId,
    ruleId: string,
    meta: { readonly actor: string; readonly reason?: string; readonly expectedVersion?: number },
  ): Promise<AuthoredRuleChangeResult>;
  /**
   * A draft is discarded (removed; the history keeps it). An enabled rule is
   * switched off instead: its expectations keep closing under it.
   */
  discard(
    clinicId: ClinicId,
    ruleId: string,
    meta: { readonly actor: string; readonly reason?: string },
  ): Promise<AuthoredRuleChangeResult>;
  /** The engine's dry run of a definition over the clinic's current records (nothing is written). */
  dryRun(
    clinicId: ClinicId,
    definition: AuthoredDefinition,
    options?: { readonly now?: Date; readonly maxPatients?: number },
  ): Promise<RuleDryRunReport>;
}

export interface AuthoredRuleCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly rules: OverridingRuleSource;
  readonly clock: Clock;
  readonly dryRun: DryRunDeps;
}

function viewOf(record: RuleOverrideRecord): AuthoredRuleView | undefined {
  const authored = record.override.authored;
  if (authored === undefined) return undefined;
  return {
    ruleId: record.ruleId,
    authored,
    live: authoredIsLive(record.override),
    version: record.version,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

function actorOf(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed === '' || trimmed.length > 200) {
    throw new ValidationError('actor', 'Say who makes the change');
  }
  return trimmed;
}

export function createAuthoredRuleCommands(deps: AuthoredRuleCommandDeps): AuthoredRuleCommands {
  async function read(clinicId: ClinicId, ruleId: string): Promise<RuleOverrideRecord | undefined> {
    return deps.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.ruleOverrides.get(clinicId, ruleId),
    );
  }

  async function write(
    clinicId: ClinicId,
    ruleId: string,
    next: RuleOverrideRecord['override'] | undefined,
    meta: { readonly actor: string; readonly reason: string; readonly expectedVersion?: number },
  ): Promise<AuthoredRuleChangeResult> {
    const result = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const change = await stores.ruleOverrides.write(clinicId, {
        ruleId,
        ...(next === undefined ? {} : { override: next }),
        actor: meta.actor,
        reason: meta.reason.slice(0, 500),
        at: deps.clock.now(),
        ...(meta.expectedVersion === undefined ? {} : { expectedVersion: meta.expectedVersion }),
      });
      return { change, record: await stores.ruleOverrides.get(clinicId, ruleId) };
    });
    deps.rules.invalidate(clinicId);
    const rule = result.record === undefined ? undefined : viewOf(result.record);
    return { change: result.change, ...(rule === undefined ? {} : { rule }) };
  }

  return {
    async list(clinicId) {
      const records = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.ruleOverrides.list(clinicId),
      );
      return records
        .flatMap((record) => {
          const view = viewOf(record);
          return view === undefined ? [] : [view];
        })
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    },

    async get(clinicId, ruleId) {
      const record = await read(clinicId, ruleId);
      return record === undefined ? undefined : viewOf(record);
    },

    async saveDraft(clinicId, draft, meta) {
      const actor = actorOf(meta.actor);
      const ruleId = authoredDefinitionId(draft.definition);
      if ((await deps.rules.base.getRule(clinicId, ruleId)) !== undefined) {
        throw new ValidationError('ruleId', `${ruleId} is a versioned rule`);
      }
      const current = await read(clinicId, ruleId);
      if (current !== undefined && current.override.authored?.status !== 'draft') {
        throw new ValidationError('ruleId', `${ruleId} is already in use for this clinic`);
      }
      return write(
        clinicId,
        ruleId,
        { authored: { ...draft, status: 'draft' } },
        {
          actor,
          reason: meta.reason,
        },
      );
    },

    async enable(clinicId, ruleId, meta) {
      const actor = actorOf(meta.actor);
      const current = await read(clinicId, ruleId);
      const authored = current?.override.authored;
      if (current === undefined || authored === undefined) {
        throw new NotFoundError('AuthoredRule', ruleId);
      }
      if (authored.status !== 'draft') {
        throw new ConflictError('AuthoredRule', `${ruleId} is already enabled`);
      }
      return write(
        clinicId,
        ruleId,
        {
          authored: {
            ...authored,
            status: 'enabled',
            validatedBy: actor,
            validatedAt: deps.clock.now().toISOString(),
          },
        },
        {
          actor,
          reason: meta.reason ?? 'Enabled for this clinic after clinical review',
          ...(meta.expectedVersion === undefined ? {} : { expectedVersion: meta.expectedVersion }),
        },
      );
    },

    async discard(clinicId, ruleId, meta) {
      const actor = actorOf(meta.actor);
      const current = await read(clinicId, ruleId);
      const authored = current?.override.authored;
      if (current === undefined || authored === undefined) {
        throw new NotFoundError('AuthoredRule', ruleId);
      }
      if (authored.status === 'draft') {
        return write(clinicId, ruleId, undefined, {
          actor,
          reason: meta.reason ?? 'Draft discarded',
        });
      }
      if (current.override.enabled === false) {
        throw new ConflictError('AuthoredRule', `${ruleId} is already switched off`);
      }
      return write(
        clinicId,
        ruleId,
        { ...current.override, enabled: false },
        { actor, reason: meta.reason ?? 'Switched off for this clinic' },
      );
    },

    dryRun(clinicId, definition, options = {}) {
      return dryRunAuthoredDefinition(deps.dryRun, clinicId, definition, {
        now: options.now ?? deps.clock.now(),
        ...(options.maxPatients === undefined ? {} : { maxPatients: options.maxPatients }),
      });
    },
  };
}
