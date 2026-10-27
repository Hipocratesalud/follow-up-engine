import type { ClinicId, LlmCallRecord, LlmUsageLog, LlmUsageSummary } from '@follow-up-engine/core';
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

  /** Calls, successful calls and cost since `since`, in total and per provider and model. */
  async summary(
    clinicId: ClinicId,
    since: Date,
    options: { readonly task?: string } = {},
  ): Promise<LlmUsageSummary> {
    const { rows } = await this.#ctx.db().query<{
      provider: string;
      model: string;
      calls: number;
      ok: number;
      cost: string;
    }>(
      `SELECT provider, model, count(*)::int AS calls, count(*) FILTER (WHERE ok)::int AS ok,
              sum(cost_usd)::text AS cost
       FROM ${this.#ctx.tables.llm_calls}
       WHERE clinic_id = $1 AND at >= $2 AND ($3::text IS NULL OR task = $3)
       GROUP BY provider, model
       ORDER BY count(*) DESC, provider, model`,
      [clinicId, since, options.task ?? null],
    );
    // Sum the exact numeric texts per model before turning them into floats.
    const total = rows.reduce((sum, row) => sum + Number(row.cost), 0);
    return {
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      successfulCalls: rows.reduce((sum, row) => sum + row.ok, 0),
      costUsd: total,
      byModel: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        calls: row.calls,
        costUsd: Number(row.cost),
      })),
    };
  }
}
