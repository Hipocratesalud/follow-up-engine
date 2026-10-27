import type { ClinicId } from '../domain/ids.ts';

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

/** LLM usage of one provider and model over a period. */
export interface LlmModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly calls: number;
  readonly costUsd: number;
}

/** LLM usage of a clinic over a period (inbox stats, cost per clinic). */
export interface LlmUsageSummary {
  /** Provider calls, retries and failures included. */
  readonly calls: number;
  readonly successfulCalls: number;
  readonly costUsd: number;
  /** Most used first (calls descending, then provider and model). */
  readonly byModel: readonly LlmModelUsage[];
}

/** Per-clinic record of LLM usage, used for budgets and cost reporting. */
export interface LlmUsageLog {
  record(call: LlmCallRecord): Promise<void>;
  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number>;
  /** Calls at or after `since`. */
  summary(clinicId: ClinicId, since: Date): Promise<LlmUsageSummary>;
}
