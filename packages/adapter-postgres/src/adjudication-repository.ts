import {
  type Adjudication,
  type AdjudicationDecision,
  type AdjudicationListQuery,
  type AdjudicationOverride,
  type AdjudicationOverrideDecision,
  type AdjudicationReasonCode,
  type AdjudicationRepository,
  type CaseId,
  type ClinicId,
  ConflictError,
  type Evidence,
  type ExpectationId,
  NotFoundError,
  type PatientId,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AdjudicationRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly expectation_id: string;
  readonly case_id: string | null;
  readonly decision: AdjudicationDecision;
  readonly model_decision: AdjudicationDecision;
  readonly probability: number;
  readonly reason_codes: AdjudicationReasonCode[];
  readonly rationale: { en: string; es: string };
  readonly quotes: Evidence[];
  readonly input_confidence: number;
  readonly mode: 'shadow' | 'active';
  readonly applied: boolean;
  readonly provider: string;
  readonly model: string;
  readonly prompt_version: string;
  readonly cost_usd: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly latency_ms: number;
  readonly created_at: Date;
  readonly override_decision: AdjudicationOverrideDecision | null;
  readonly override_by: string | null;
  readonly override_at: Date | null;
  readonly override_note: string | null;
}

const COLUMNS = `clinic_id, id, patient_id, expectation_id, case_id, decision, model_decision,
  probability, reason_codes, rationale, quotes, input_confidence, mode, applied, provider, model,
  prompt_version, cost_usd, input_tokens, output_tokens, latency_ms, created_at,
  override_decision, override_by, override_at, override_note`;

function toAdjudication(row: AdjudicationRow): Adjudication {
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    expectationId: row.expectation_id as ExpectationId,
    ...optional('caseId', row.case_id as CaseId | null),
    decision: row.decision,
    modelDecision: row.model_decision,
    probability: row.probability,
    reasonCodes: row.reason_codes,
    rationale: row.rationale,
    quotes: row.quotes,
    inputConfidence: row.input_confidence,
    mode: row.mode,
    applied: row.applied,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    costUsd: Number(row.cost_usd),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    ...(row.override_decision === null || row.override_by === null || row.override_at === null
      ? {}
      : {
          override: {
            decision: row.override_decision,
            userId: row.override_by,
            at: row.override_at,
            ...optional('note', row.override_note),
          },
        }),
  };
}

/** The adjudicator's decisions (`adjudications`, migration 0018): one per expectation. */
export class PostgresAdjudicationRepository implements AdjudicationRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async create(clinicId: ClinicId, adjudication: Adjudication): Promise<void> {
    if (adjudication.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.adjudications} (clinic_id, id, patient_id, expectation_id,
           case_id, decision, model_decision, probability, reason_codes, rationale, quotes,
           input_confidence, mode, applied, provider, model, prompt_version, cost_usd,
           input_tokens, output_tokens, latency_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
           $19, $20, $21, $22)`,
        [
          clinicId,
          adjudication.id,
          adjudication.patientId,
          adjudication.expectationId,
          adjudication.caseId ?? null,
          adjudication.decision,
          adjudication.modelDecision,
          adjudication.probability,
          [...adjudication.reasonCodes],
          jsonParam(adjudication.rationale),
          jsonParam(adjudication.quotes),
          adjudication.inputConfidence,
          adjudication.mode,
          adjudication.applied,
          adjudication.provider,
          adjudication.model,
          adjudication.promptVersion,
          adjudication.costUsd,
          adjudication.inputTokens,
          adjudication.outputTokens,
          Math.round(adjudication.latencyMs),
          adjudication.createdAt,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('Adjudication', adjudication.id) : error;
      });
  }

  async get(clinicId: ClinicId, id: string): Promise<Adjudication | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<AdjudicationRow>(
        `SELECT ${COLUMNS} FROM ${this.#ctx.tables.adjudications} WHERE clinic_id = $1 AND id = $2`,
        [clinicId, id],
      );
    const [row] = rows;
    return row === undefined ? undefined : toAdjudication(row);
  }

  async forExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<Adjudication | undefined> {
    const { rows } = await this.#ctx.db().query<AdjudicationRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.adjudications}
       WHERE clinic_id = $1 AND expectation_id = $2`,
      [clinicId, expectationId],
    );
    const [row] = rows;
    return row === undefined ? undefined : toAdjudication(row);
  }

  async list(
    clinicId: ClinicId,
    query: AdjudicationListQuery = {},
  ): Promise<readonly Adjudication[]> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const { rows } = await this.#ctx.db().query<AdjudicationRow>(
      `SELECT ${COLUMNS} FROM ${this.#ctx.tables.adjudications}
       WHERE clinic_id = $1
         AND ($2::text IS NULL OR patient_id = $2)
         AND ($3::text[] IS NULL OR expectation_id = ANY($3::text[]))
         AND ($4::text[] IS NULL OR decision = ANY($4::text[]))
       ORDER BY created_at DESC, seq DESC
       LIMIT $5`,
      [
        clinicId,
        query.patientId ?? null,
        query.expectationIds === undefined ? null : [...query.expectationIds],
        query.decisions === undefined ? null : [...query.decisions],
        limit,
      ],
    );
    return rows.map(toAdjudication);
  }

  async setOverride(
    clinicId: ClinicId,
    id: string,
    override: AdjudicationOverride,
  ): Promise<Adjudication> {
    const { rows } = await this.#ctx.db().query<AdjudicationRow>(
      `UPDATE ${this.#ctx.tables.adjudications}
       SET override_decision = $3, override_by = $4, override_at = $5, override_note = $6
       WHERE clinic_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [clinicId, id, override.decision, override.userId, override.at, override.note ?? null],
    );
    const [row] = rows;
    if (row === undefined) throw new NotFoundError('Adjudication', id);
    return toAdjudication(row);
  }
}
