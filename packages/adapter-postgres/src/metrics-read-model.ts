import {
  type CaseEvent,
  type CaseFeedback,
  type CaseId,
  type ClinicId,
  type Expectation,
  type ExpectationId,
  type FollowUpCase,
  type LlmTaskUsage,
  type MetricsPeriod,
  type MetricsReadModel,
  type NoteExtractionCost,
  type PatientCondition,
  PLAN_ITEM_REVIEW_EVENT_TYPES,
  type PlanItemReview,
  type ReviewRunTotals,
} from '@follow-up-engine/core';
import {
  type CaseEventRow,
  FEEDBACK_COLUMNS,
  type FeedbackRow,
  toCaseEvent,
  toFeedback,
} from './case-records.ts';
import { CASE_COLUMNS, type CaseRow, toCase } from './case-repository.ts';
import { CONDITION_COLUMNS, type ConditionRow, toCondition } from './condition-repository.ts';
import {
  EXPECTATION_COLUMNS,
  type ExpectationRow,
  toExpectation,
} from './expectation-repository.ts';
import type { RepositoryContext } from './sql.ts';

/**
 * Read side of the clinic metrics (HIP-141) over the engine's own tables.
 * Every query is scoped to the clinic (and, inside a unit of work, to its
 * row-level security). Sums of money are done in `numeric` and turned into
 * floats once.
 */
export class PostgresMetricsReadModel implements MetricsReadModel {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async casesOpened(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly FollowUpCase[]> {
    // When the case reached the inbox: its release for a held backfill case
    // (`caseOpenedAt` in core), served by follow_up_cases_opened_idx.
    const { rows } = await this.#ctx.db().query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM ${this.#ctx.tables.follow_up_cases}
       WHERE clinic_id = $1
         AND GREATEST(created_at, COALESCE(release_at, created_at)) >= $2
         AND GREATEST(created_at, COALESCE(release_at, created_at)) < $3
       ORDER BY GREATEST(created_at, COALESCE(release_at, created_at)), id`,
      [clinicId, period.from, period.to],
    );
    return rows.map(toCase);
  }

  async caseEvents(clinicId: ClinicId, caseIds: readonly CaseId[]): Promise<readonly CaseEvent[]> {
    if (caseIds.length === 0) {
      return [];
    }
    const { rows } = await this.#ctx.db().query<CaseEventRow>(
      `SELECT clinic_id, case_id, type, actor_type, actor_id, payload, at
       FROM ${this.#ctx.tables.case_events}
       WHERE clinic_id = $1 AND case_id = ANY($2::text[])
       ORDER BY case_id, at, seq`,
      [clinicId, [...caseIds]],
    );
    return rows.map(toCaseEvent);
  }

  async feedbackForCases(
    clinicId: ClinicId,
    caseIds: readonly CaseId[],
  ): Promise<readonly CaseFeedback[]> {
    if (caseIds.length === 0) {
      return [];
    }
    const { rows } = await this.#ctx.db().query<FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM ${this.#ctx.tables.case_feedback}
       WHERE clinic_id = $1 AND case_id = ANY($2::text[])
       ORDER BY created_at, seq`,
      [clinicId, [...caseIds]],
    );
    return rows.map(toFeedback);
  }

  async expectations(
    clinicId: ClinicId,
    ids: readonly ExpectationId[],
  ): Promise<readonly Expectation[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.#ctx.db().query<ExpectationRow>(
      `SELECT ${EXPECTATION_COLUMNS} FROM ${this.#ctx.tables.expectations}
       WHERE clinic_id = $1 AND id = ANY($2::text[])
       ORDER BY id`,
      [clinicId, [...new Set(ids)]],
    );
    return rows.map(toExpectation);
  }

  async noteExtractionCosts(
    clinicId: ClinicId,
    documentIds: readonly string[],
  ): Promise<readonly NoteExtractionCost[]> {
    if (documentIds.length === 0) {
      return [];
    }
    const { rows } = await this.#ctx.db().query<{ document_id: string; cost: string }>(
      `SELECT payload->>'sourceDocumentId' AS document_id,
              SUM(COALESCE((payload->'extractor'->>'costUsd')::numeric, 0))::text AS cost
       FROM ${this.#ctx.tables.clinical_events}
       WHERE clinic_id = $1 AND type = 'plan.extracted'
         AND payload->>'sourceDocumentId' = ANY($2::text[])
       GROUP BY 1
       ORDER BY 1`,
      [clinicId, [...new Set(documentIds)]],
    );
    return rows.map((row) => ({ documentId: row.document_id, costUsd: Number(row.cost) }));
  }

  async engineConditions(clinicId: ClinicId): Promise<readonly PatientCondition[]> {
    const { rows } = await this.#ctx.db().query<ConditionRow>(
      `SELECT ${CONDITION_COLUMNS} FROM ${this.#ctx.tables.patient_conditions}
       WHERE clinic_id = $1 AND source_type <> 'recorded'
       ORDER BY patient_id, code_system, code`,
      [clinicId],
    );
    return rows.map(toCondition);
  }

  async planItemReviews(
    clinicId: ClinicId,
    period: MetricsPeriod,
  ): Promise<readonly PlanItemReview[]> {
    const { rows } = await this.#ctx.db().query<{ type: string; at: Date }>(
      `SELECT type, at FROM ${this.#ctx.tables.case_events}
       WHERE clinic_id = $1 AND type = ANY($2::text[]) AND at >= $3 AND at < $4
       ORDER BY at, seq`,
      [clinicId, [...PLAN_ITEM_REVIEW_EVENT_TYPES], period.from, period.to],
    );
    return rows.map((row) => ({ type: row.type, at: row.at }));
  }

  async llmUsageByTask(
    clinicId: ClinicId,
    period: MetricsPeriod,
  ): Promise<readonly LlmTaskUsage[]> {
    const { rows } = await this.#ctx.db().query<{
      task: string;
      calls: string;
      successful: string;
      input_tokens: string;
      output_tokens: string;
      cost: string;
    }>(
      `SELECT task, count(*)::text AS calls, count(*) FILTER (WHERE ok)::text AS successful,
              sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens,
              sum(cost_usd)::text AS cost
       FROM ${this.#ctx.tables.llm_calls}
       WHERE clinic_id = $1 AND at >= $2 AND at < $3
       GROUP BY task
       ORDER BY task`,
      [clinicId, period.from, period.to],
    );
    return rows.map((row) => ({
      task: row.task,
      calls: Number(row.calls),
      successfulCalls: Number(row.successful),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      costUsd: Number(row.cost),
    }));
  }

  async reviewRuns(clinicId: ClinicId, period: MetricsPeriod): Promise<ReviewRunTotals> {
    const { rows } = await this.#ctx.db().query<{ runs: string; cost: string }>(
      `SELECT count(*)::text AS runs, COALESCE(sum(cost_usd), 0)::text AS cost
       FROM ${this.#ctx.tables.clinical_review_runs}
       WHERE clinic_id = $1 AND started_at >= $2 AND started_at < $3`,
      [clinicId, period.from, period.to],
    );
    const [row] = rows;
    return { runs: Number(row?.runs ?? 0), costUsd: Number(row?.cost ?? 0) };
  }
}
