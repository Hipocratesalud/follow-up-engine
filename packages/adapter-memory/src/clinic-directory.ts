import type {
  Clinic,
  ClinicDirectory,
  ClinicId,
  ClinicSettings,
  LlmCallRecord,
  LlmUsageLog,
  LlmUsageSummary,
} from '@follow-up-engine/core';
import { DEFAULT_CLINIC_LOCALE } from '@follow-up-engine/core';
import type { MemoryDatabase } from './memory-database.ts';

/** Settings of a new clinic unless overridden (PRD defaults). */
export const DEFAULT_CLINIC_SETTINGS: ClinicSettings = {
  allowPatientContact: false,
  dailyCaseCapPerOwner: 20,
  backfillNotifyMaxAgeDays: 730,
  llmMonthlyBudgetUsd: 50,
  timezone: 'America/Caracas',
  locale: DEFAULT_CLINIC_LOCALE,
};

/** In-memory {@link ClinicDirectory}. */
export class MemoryClinicDirectory implements ClinicDirectory {
  readonly #clinics = new Map<ClinicId, Clinic>();
  readonly #apiKeyHashes = new Map<string, ClinicId>();

  constructor(clinics: readonly { readonly clinic: Clinic; readonly apiKeyHash?: string }[] = []) {
    for (const { clinic, apiKeyHash } of clinics) {
      this.add(clinic, apiKeyHash);
    }
  }

  /** Registers or replaces a clinic. `apiKeyHash` is the sha256 hex of its API key. */
  add(clinic: Clinic, apiKeyHash?: string): void {
    this.#clinics.set(clinic.id, clinic);
    if (apiKeyHash !== undefined) {
      this.#apiKeyHashes.set(apiKeyHash, clinic.id);
    }
  }

  listActive(): Promise<readonly Clinic[]> {
    return Promise.resolve([...this.#clinics.values()].filter((clinic) => clinic.active));
  }

  get(clinicId: ClinicId): Promise<Clinic | undefined> {
    return Promise.resolve(this.#clinics.get(clinicId));
  }

  findByApiKeyHash(apiKeyHash: string): Promise<Clinic | undefined> {
    const clinicId = this.#apiKeyHashes.get(apiKeyHash);
    return Promise.resolve(clinicId === undefined ? undefined : this.#clinics.get(clinicId));
  }
}

/** In-memory {@link LlmUsageLog}, stored with the rest of the memory database. */
export class MemoryLlmUsageLog implements LlmUsageLog {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  record(call: LlmCallRecord): Promise<void> {
    this.#db.pushTo(this.#db.state.llmCalls, call);
    return Promise.resolve();
  }

  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number> {
    return Promise.resolve(
      this.#db.state.llmCalls
        .filter((call) => call.clinicId === clinicId && call.at.getTime() >= since.getTime())
        .reduce((total, call) => total + call.costUsd, 0),
    );
  }

  summary(clinicId: ClinicId, since: Date): Promise<LlmUsageSummary> {
    const calls = this.#db.state.llmCalls.filter(
      (call) => call.clinicId === clinicId && call.at.getTime() >= since.getTime(),
    );
    const byModel = new Map<
      string,
      { provider: string; model: string; calls: number; costUsd: number }
    >();
    for (const call of calls) {
      const key = `${call.provider}\u0000${call.model}`;
      const usage = byModel.get(key) ?? {
        provider: call.provider,
        model: call.model,
        calls: 0,
        costUsd: 0,
      };
      byModel.set(key, { ...usage, calls: usage.calls + 1, costUsd: usage.costUsd + call.costUsd });
    }
    return Promise.resolve({
      calls: calls.length,
      successfulCalls: calls.filter((call) => call.ok).length,
      costUsd: calls.reduce((total, call) => total + call.costUsd, 0),
      byModel: [...byModel.values()].sort(
        (left, right) =>
          right.calls - left.calls ||
          left.provider.localeCompare(right.provider) ||
          left.model.localeCompare(right.model),
      ),
    });
  }

  /** Every recorded call of a clinic, for tests and stats. */
  list(clinicId?: ClinicId): readonly LlmCallRecord[] {
    return this.#db.state.llmCalls.filter(
      (call) => clinicId === undefined || call.clinicId === clinicId,
    );
  }
}
