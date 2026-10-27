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

/** Per-clinic record of LLM usage, used for budgets and cost reporting. */
export interface LlmUsageLog {
  record(call: LlmCallRecord): Promise<void>;
  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number>;
}
