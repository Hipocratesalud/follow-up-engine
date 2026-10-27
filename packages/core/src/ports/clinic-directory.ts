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
   * BCP-47 locale of the clinic (default `en-US`): the language of the labels
   * the API returns when the inbox user's `Accept-Language` names none the
   * engine has, and of the clinical reviewer's findings. Independent of the
   * language of its notes and of each patient's language (docs/adr/0006).
   */
  readonly locale: string;
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
