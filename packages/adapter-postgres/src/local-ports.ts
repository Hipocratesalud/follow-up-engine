import type { ClinicId, PatientId } from '@follow-up-engine/core';

/*
 * Structural copies of ports that the core package adds in HIP-103
 * (`ports/clinic-directory.ts`, `ports/llm-usage-log.ts`). The adapters
 * implement these shapes exactly, so once core exports them this file
 * becomes re-exports of `@follow-up-engine/core` with no other change.
 */

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

/** One LLM call, as accounted per clinic. */
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

/** Per-clinic record of LLM usage, used for budgets and cost reporting. */
export interface LlmUsageLog {
  record(call: LlmCallRecord): Promise<void>;
  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number>;
}

/*
 * Not in core yet: progress of the initial backfill, so a crashed or
 * redeployed worker resumes from the last processed patient instead of
 * starting over. Proposed for core as `ports/backfill-progress.ts`.
 */

export type BackfillStatus = 'running' | 'completed' | 'failed';

export interface BackfillCounts {
  readonly patientsScanned: number;
  readonly expectationsCreated: number;
  readonly casesOpened: number;
}

export interface BackfillProgress extends BackfillCounts {
  readonly clinicId: ClinicId;
  readonly runId: string;
  readonly status: BackfillStatus;
  /** Last patient fully processed; pass as `after` to `listPatientIds`. */
  readonly cursor?: PatientId;
  readonly lastError?: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt?: Date;
}

export interface BackfillProgressStore {
  /** Starts a run. Throws `ConflictError` if the clinic already has a running backfill or the run id exists. */
  start(clinicId: ClinicId, runId: string, now: Date): Promise<BackfillProgress>;

  get(clinicId: ClinicId, runId: string): Promise<BackfillProgress | undefined>;

  /** The clinic's running backfill, if any (to resume after a restart). */
  findRunning(clinicId: ClinicId): Promise<BackfillProgress | undefined>;

  /**
   * Moves the cursor past a processed page and adds `delta` to the counters.
   * Call inside the unit of work that wrote the page, so progress and its
   * effects commit together. Throws `NotFoundError` unless the run is running.
   */
  advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: BackfillCounts; readonly now: Date },
  ): Promise<BackfillProgress>;

  /** Marks a running run `completed` or `failed`. Throws `NotFoundError` unless it is running. */
  finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<BackfillProgress>;
}
