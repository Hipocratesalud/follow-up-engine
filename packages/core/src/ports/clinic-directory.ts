import type { ClinicId } from '../domain/ids.ts';

/** Per-clinic settings that change engine behavior. */
/**
 * Parts of the record a host sends in full. Only then does their absence for
 * a patient mean something (a record-quality finding); a host that never
 * sends allergies leaves every patient without one.
 */
export const RECORD_CAPABILITIES = ['allergies'] as const;
export type RecordCapability = (typeof RECORD_CAPABILITIES)[number];

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
   * language of its notes and of each patient's language (docs/adr/0007).
   */
  readonly locale: string;
  /**
   * The clinic's escalation policy (a named, versioned policy such as
   * `default_v2`): replaces the named policy every rule and protocol
   * references. Absent: each rule's own (`default_v1`). Cases keep the
   * policy they opened with.
   */
  readonly escalationPolicyId?: string;
  /**
   * Ids of the care protocols the clinic runs (config/protocols). Absent:
   * `DEFAULT_ENABLED_PROTOCOLS` (diabetes and hypertension). Draft protocols
   * stay off until the clinic lists them, once its clinical team validated
   * them (docs/protocols.md).
   */
  readonly enabledProtocols?: readonly string[];
  /**
   * What the host's record includes (`allergies`: every patient's
   * AllergyIntolerance list, "no known allergy" included). Absent: nothing
   * is assumed, and the reviewer never flags a missing allergy status.
   */
  readonly recordCapabilities?: readonly RecordCapability[];
  /** When the nightly reconciliation runs (defaults: `DEFAULT_RECONCILIATION_SCHEDULE`). */
  readonly reconciliation?: ReconciliationSchedule;
}

/**
 * When a clinic's nightly reconciliation runs, in the clinic's time zone.
 * Every field is optional; absent ones take `DEFAULT_RECONCILIATION_SCHEDULE`.
 */
export interface ReconciliationSchedule {
  /** `false` switches the nightly sweep off (a run can still be started by hand). */
  readonly enabled?: boolean;
  /** Local hour, 0 to 23. */
  readonly hour?: number;
  /**
   * Local weekday (0 = Sunday ... 6) whose run sweeps every patient; other
   * nights look at patients with new events only. `null`: never a full sweep
   * by schedule (the demo clinic, whose fake clock crosses weeks in seconds).
   */
  readonly fullSweepWeekday?: number | null;
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
