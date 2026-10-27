import type { ClinicId, LlmCallRecord, LlmUsageLog } from '@follow-up-engine/core';
import type { RepositoryContext } from './sql.ts';

/** Per-clinic LLM accounting (`llm_calls`). Costs are stored as `numeric(20, 10)` USD (no float drift when summing). */
export class PostgresLlmUsageLog implements LlmUsageLog {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  /** Idempotent on `callId`, so a retried write never double-counts a call. */
  async record(call: LlmCallRecord): Promise<void> {
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.llm_calls}
         (clinic_id, call_id, task, prompt_version, provider, model, input_tokens, output_tokens,
          cost_usd, latency_ms, ok, error, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (clinic_id, call_id) DO NOTHING`,
      [
        call.clinicId,
        call.callId,
        call.task,
        call.promptVersion,
        call.provider,
        call.model,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        Math.round(call.latencyMs),
        call.ok,
        call.error ?? null,
        call.at,
      ],
    );
  }

  /** Sum of `costUsd` of calls at or after `since`. */
  async totalCostUsd(clinicId: ClinicId, since: Date): Promise<number> {
    const { rows } = await this.#ctx.db().query<{ total: string }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM ${this.#ctx.tables.llm_calls}
       WHERE clinic_id = $1 AND at >= $2`,
      [clinicId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
