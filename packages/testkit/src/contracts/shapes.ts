import type { ClinicId } from '@follow-up-engine/core';

/**
 * Port shapes from the shared brief that core may not export yet. They are
 * structural copies: once core exports `ClinicDirectory` and `LlmUsageLog`,
 * core's types satisfy these and adapters can use either.
 */

export interface ClinicSettings {
  readonly allowPatientContact: boolean;
  /** Backfill release cap, default 20. */
  readonly dailyCaseCapPerOwner: number;
  /** Default 730. */
  readonly backfillNotifyMaxAgeDays: number;
  readonly llmMonthlyBudgetUsd: number;
  /** IANA time zone. */
  readonly timezone: string;
}

export interface Clinic {
  readonly id: ClinicId;
  readonly name: string;
  readonly active: boolean;
  readonly settings: ClinicSettings;
}

export interface ClinicDirectory {
  listActive(): Promise<readonly Clinic[]>;
  get(clinicId: ClinicId): Promise<Clinic | undefined>;
  /** sha256 hex of the API key. */
  findByApiKeyHash(apiKeyHash: string): Promise<Clinic | undefined>;
}

export interface LlmCallRecord {
  readonly callId: string;
  readonly clinicId: ClinicId;
  readonly task: string;
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly at: Date;
}

export interface LlmUsageLog {
  record(call: LlmCallRecord): Promise<void>;
  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number>;
}
