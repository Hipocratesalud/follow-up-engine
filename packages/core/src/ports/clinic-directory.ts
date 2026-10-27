import type { ClinicId } from '../domain/ids.ts';

/** Per-clinic settings that change engine behavior. */
export interface ClinicSettings {
  readonly allowPatientContact: boolean;
  /** Backfill release cap, default 20. */
  readonly dailyCaseCapPerOwner: number;
  /** Default 730. */
  readonly backfillNotifyMaxAgeDays: number;
  readonly llmMonthlyBudgetUsd: number;
  /** IANA time zone. */
  readonly timezone: string;
  /**
   * Ids of the care protocols the clinic runs (config/protocols). Absent:
   * `DEFAULT_ENABLED_PROTOCOLS` (diabetes and hypertension). Draft protocols
   * stay off until the clinic lists them, once its clinical team validated
   * them (docs/protocols.md).
   */
  readonly enabledProtocols?: readonly string[];
}

/** A tenant of the engine. */
export interface Clinic {
  readonly id: ClinicId;
  readonly name: string;
  readonly active: boolean;
  readonly settings: ClinicSettings;
}

/** Registry of clinics and their settings. */
export interface ClinicDirectory {
  listActive(): Promise<readonly Clinic[]>;
  get(clinicId: ClinicId): Promise<Clinic | undefined>;
  /** `apiKeyHash` is the sha256 hex of the API key. */
  findByApiKeyHash(apiKeyHash: string): Promise<Clinic | undefined>;
}
