import type { ClinicId } from '../domain/ids.ts';
import type {
  RuleOverride,
  RuleOverrideChange,
  RuleOverrideRecord,
} from '../domain/rule-override.ts';

/** A change to one rule's override. */
export interface RuleOverrideWrite {
  readonly ruleId: string;
  /** The override from now on; absent resets the rule to its versioned config. */
  readonly override?: RuleOverride;
  readonly actor: string;
  readonly reason: string;
  readonly at: Date;
  /**
   * Optimistic concurrency: the version the caller based the change on (`0`
   * when the rule had never been changed). `ConflictError` when another
   * change landed since; nothing is written.
   */
  readonly expectedVersion?: number;
}

/**
 * Per-clinic rule overrides, versioned and audited: the override in force
 * per rule, and an append-only history of every change (who, when, old →
 * new, why). Part of `TransactionalStores`.
 */
export interface RuleOverrideStore {
  /** The clinic's overrides in force, by rule id. */
  list(clinicId: ClinicId): Promise<readonly RuleOverrideRecord[]>;

  get(clinicId: ClinicId, ruleId: string): Promise<RuleOverrideRecord | undefined>;

  /**
   * Writes (or, with no `override`, removes) the rule's override and appends
   * the change to the history, atomically. The change takes the rule's next
   * version (1 for its first change; a reset takes one too, and versions
   * keep counting after it).
   */
  write(clinicId: ClinicId, change: RuleOverrideWrite): Promise<RuleOverrideChange>;

  /** Changes, newest first (only `ruleId`'s when given). */
  history(
    clinicId: ClinicId,
    query?: { readonly ruleId?: string; readonly limit?: number },
  ): Promise<readonly RuleOverrideChange[]>;

  /**
   * A number that changes whenever any override of the clinic changes (the
   * count of changes): how a cached rule set knows it is stale, also across
   * processes.
   */
  revision(clinicId: ClinicId): Promise<number>;
}
