import {
  type ClinicId,
  ConflictError,
  type RuleOverrideChange,
  type RuleOverrideRecord,
  type RuleOverrideStore,
  type RuleOverrideWrite,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

/** In-memory {@link RuleOverrideStore}, rolled back with the rest of the database. */
export class MemoryRuleOverrideStore implements RuleOverrideStore {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  list(clinicId: ClinicId): Promise<readonly RuleOverrideRecord[]> {
    return Promise.resolve(
      [...this.#db.state.ruleOverrides.values()]
        .filter((record) => record.clinicId === clinicId)
        .sort((left, right) => (left.ruleId < right.ruleId ? -1 : 1)),
    );
  }

  get(clinicId: ClinicId, ruleId: string): Promise<RuleOverrideRecord | undefined> {
    return Promise.resolve(this.#db.state.ruleOverrides.get(tenantKey(clinicId, ruleId)));
  }

  write(clinicId: ClinicId, change: RuleOverrideWrite): Promise<RuleOverrideChange> {
    const key = tenantKey(clinicId, change.ruleId);
    const current = this.#db.state.ruleOverrides.get(key);
    const latest = this.#latestVersion(clinicId, change.ruleId);
    if (change.expectedVersion !== undefined && change.expectedVersion !== latest) {
      return Promise.reject(
        new ConflictError('RuleOverride', `${change.ruleId}@${String(change.expectedVersion)}`),
      );
    }
    const version = latest + 1;
    const written: RuleOverrideChange = {
      clinicId,
      ruleId: change.ruleId,
      version,
      action: change.override === undefined ? 'reset' : 'set',
      ...(current === undefined ? {} : { previous: { ...current.override } }),
      ...(change.override === undefined ? {} : { next: { ...change.override } }),
      actor: change.actor,
      reason: change.reason,
      at: change.at,
    };
    if (change.override === undefined) {
      this.#db.deleteIn(this.#db.state.ruleOverrides, key);
    } else {
      this.#db.setIn(this.#db.state.ruleOverrides, key, {
        clinicId,
        ruleId: change.ruleId,
        override: { ...change.override },
        version,
        updatedAt: change.at,
        updatedBy: change.actor,
        reason: change.reason,
      });
    }
    this.#db.pushTo(this.#db.state.ruleOverrideHistory, written);
    return Promise.resolve(written);
  }

  history(
    clinicId: ClinicId,
    query: { readonly ruleId?: string; readonly limit?: number } = {},
  ): Promise<readonly RuleOverrideChange[]> {
    const changes = this.#db.state.ruleOverrideHistory
      .filter(
        (change) =>
          change.clinicId === clinicId &&
          (query.ruleId === undefined || change.ruleId === query.ruleId),
      )
      .reverse();
    return Promise.resolve(query.limit === undefined ? changes : changes.slice(0, query.limit));
  }

  revision(clinicId: ClinicId): Promise<number> {
    return Promise.resolve(
      this.#db.state.ruleOverrideHistory.filter((change) => change.clinicId === clinicId).length,
    );
  }

  #latestVersion(clinicId: ClinicId, ruleId: string): number {
    return this.#db.state.ruleOverrideHistory
      .filter((change) => change.clinicId === clinicId && change.ruleId === ruleId)
      .reduce((latest, change) => Math.max(latest, change.version), 0);
  }
}
