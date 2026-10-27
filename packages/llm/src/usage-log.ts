import type { ClinicId } from '@follow-up-engine/core';

/*
 * Structural copies of `LlmCallRecord` / `LlmUsageLog` from
 * `packages/core/src/ports/llm-usage-log.ts` (added to core in parallel).
 * Identical shape, so a core-typed adapter (Postgres, memory) is accepted
 * here as is. Replace with `import type` from core once it is merged.
 */

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

/**
 * In-process usage log for the eval harness, tests and demos. Production
 * wiring uses the Postgres adapter.
 */
export class InMemoryLlmUsageLog implements LlmUsageLog {
  readonly #records: LlmCallRecord[] = [];

  record(call: LlmCallRecord): Promise<void> {
    this.#records.push(call);
    return Promise.resolve();
  }

  totalCostUsd(clinicId: ClinicId, since: Date): Promise<number> {
    const total = this.#records
      .filter((r) => r.clinicId === clinicId && r.at.getTime() >= since.getTime())
      .reduce((sum, r) => sum + r.costUsd, 0);
    return Promise.resolve(total);
  }

  /** Every record so far, oldest first. */
  get records(): readonly LlmCallRecord[] {
    return [...this.#records];
  }
}
