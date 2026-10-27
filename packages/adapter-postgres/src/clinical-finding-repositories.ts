import {
  type ClinicalFinding,
  type ClinicalFindingRepository,
  type ClinicalReviewRun,
  type ClinicalReviewRunRepository,
  type ClinicId,
  ConflictError,
  type FindingCitation,
  type FindingCounts,
  type FindingCoverage,
  type FindingFlag,
  type FindingFlagRepository,
  type FindingListQuery,
  type FindingPage,
  type FindingReview,
  InvalidCursorError,
  NotFoundError,
  type PatientId,
  type ReviewRunStats,
  type ReviewStep,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { reviveDate } from './codec.ts';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface FindingRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly category: ClinicalFinding['category'];
  readonly severity: ClinicalFinding['severity'];
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
  readonly citations: readonly (Omit<FindingCitation, 'occurredAt'> & { occurredAt: string })[];
  readonly already_covered: boolean;
  readonly covered_by: readonly FindingCoverage[];
  readonly specialty: string | null;
  readonly mode: ClinicalFinding['mode'];
  readonly status: ClinicalFinding['status'];
  readonly origin: ClinicalFinding['origin'];
  readonly dedup_key: string;
  readonly run_id: string;
  readonly model_id: string;
  readonly prompt_version: string;
  readonly reviewed_by: string | null;
  readonly reviewed_at: Date | null;
  readonly review_reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const FINDING_COLUMNS = `clinic_id, id, patient_id, category, severity, summary, rationale, suggestion,
  citations, already_covered, covered_by, specialty, mode, status, origin, dedup_key, run_id,
  model_id, prompt_version, reviewed_by, reviewed_at, review_reason, created_at, updated_at`;

function toFinding(row: FindingRow): ClinicalFinding {
  const verdict =
    row.status === 'relevant' || row.status === 'already_known' || row.status === 'not_relevant'
      ? row.status
      : undefined;
  const review: FindingReview | undefined =
    verdict !== undefined && row.reviewed_by !== null && row.reviewed_at !== null
      ? {
          verdict,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at,
          ...optional('reason', row.review_reason),
        }
      : undefined;
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    category: row.category,
    severity: row.severity,
    summary: row.summary,
    rationale: row.rationale,
    suggestion: row.suggestion,
    citations: row.citations.map((citation) => ({
      source: citation.source,
      kind: citation.kind,
      quote: citation.quote,
      occurredAt: reviveDate(citation.occurredAt, 'citations.occurredAt'),
    })),
    alreadyCovered: row.already_covered,
    coveredBy: row.covered_by,
    ...optional('specialty', row.specialty),
    mode: row.mode,
    status: row.status,
    origin: row.origin,
    dedupKey: row.dedup_key,
    runId: row.run_id,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    ...(review === undefined ? {} : { review }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Keyset cursor of the newest-first order: `[createdAt, id]` plus a query fingerprint. */
function encodeCursor(fingerprint: string, row: FindingRow): string {
  return Buffer.from(JSON.stringify([fingerprint, row.created_at.toISOString(), row.id])).toString(
    'base64url',
  );
}

function decodeCursor(fingerprint: string, cursor: string): { at: string; id: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    decoded[0] !== fingerprint ||
    typeof decoded[1] !== 'string' ||
    Number.isNaN(Date.parse(decoded[1])) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(decoded[1]) ||
    typeof decoded[2] !== 'string' ||
    decoded[2].includes('\u0000')
  ) {
    throw new InvalidCursorError();
  }
  return { at: decoded[1], id: decoded[2] };
}

function fingerprintOf(query: FindingListQuery): string {
  return JSON.stringify([
    query.mode ?? null,
    query.patientId ?? null,
    [...(query.statuses ?? [])].sort(),
    [...(query.categories ?? [])].sort(),
    [...(query.severities ?? [])].sort(),
  ]);
}

/** Clinical reviewer findings (`clinical_findings`). */
export class PostgresClinicalFindingRepository implements ClinicalFindingRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async create(clinicId: ClinicId, finding: ClinicalFinding): Promise<void> {
    if (finding.clinicId !== clinicId) throw new TenantMismatchError();
    try {
      await this.#ctx.db().query(
        `INSERT INTO ${this.#ctx.tables.clinical_findings} (${FINDING_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
        [
          clinicId,
          finding.id,
          finding.patientId,
          finding.category,
          finding.severity,
          finding.summary,
          finding.rationale,
          finding.suggestion,
          jsonParam(finding.citations),
          finding.alreadyCovered,
          jsonParam(finding.coveredBy),
          finding.specialty ?? null,
          finding.mode,
          finding.status,
          finding.origin,
          finding.dedupKey,
          finding.runId,
          finding.modelId,
          finding.promptVersion,
          finding.review?.reviewedBy ?? null,
          finding.review?.reviewedAt ?? null,
          finding.review?.reason ?? null,
          finding.createdAt,
          finding.updatedAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('ClinicalFinding', finding.id);
      throw error;
    }
  }

  async get(clinicId: ClinicId, id: string): Promise<ClinicalFinding | undefined> {
    const { rows } = await this.#ctx.db().query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM ${this.#ctx.tables.clinical_findings}
       WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toFinding(row);
  }

  async review(clinicId: ClinicId, id: string, review: FindingReview): Promise<ClinicalFinding> {
    const { rows } = await this.#ctx.db().query<FindingRow>(
      `UPDATE ${this.#ctx.tables.clinical_findings}
       SET status = $3, reviewed_by = $4, reviewed_at = $5, review_reason = $6, updated_at = $5
       WHERE clinic_id = $1 AND id = $2
       RETURNING ${FINDING_COLUMNS}`,
      [clinicId, id, review.verdict, review.reviewedBy, review.reviewedAt, review.reason ?? null],
    );
    const [row] = rows;
    if (row === undefined) throw new NotFoundError('ClinicalFinding', id);
    return toFinding(row);
  }

  async findDuplicates(
    clinicId: ClinicId,
    patientId: PatientId,
    dedupKey: string,
    since: Date,
  ): Promise<readonly ClinicalFinding[]> {
    const { rows } = await this.#ctx.db().query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM ${this.#ctx.tables.clinical_findings}
       WHERE clinic_id = $1 AND patient_id = $2 AND dedup_key = $3
         AND (status = 'open' OR created_at >= $4 OR reviewed_at >= $4)
       ORDER BY created_at DESC, id DESC`,
      [clinicId, patientId, dedupKey, since],
    );
    return rows.map(toFinding);
  }

  async list(clinicId: ClinicId, query: FindingListQuery): Promise<FindingPage> {
    const fingerprint = fingerprintOf(query);
    const after = query.cursor === undefined ? undefined : decodeCursor(fingerprint, query.cursor);
    const { rows } = await this.#ctx.db().query<FindingRow>(
      `SELECT ${FINDING_COLUMNS} FROM ${this.#ctx.tables.clinical_findings}
       WHERE clinic_id = $1
         AND ($2::text IS NULL OR mode = $2)
         AND ($3::text IS NULL OR patient_id = $3)
         AND ($4::text[] IS NULL OR status = ANY($4::text[]))
         AND ($5::text[] IS NULL OR category = ANY($5::text[]))
         AND ($6::text[] IS NULL OR severity = ANY($6::text[]))
         AND ($7::timestamptz IS NULL OR (created_at, id) < ($7::timestamptz, $8::text))
       ORDER BY created_at DESC, id DESC
       LIMIT $9`,
      [
        clinicId,
        query.mode ?? null,
        query.patientId ?? null,
        query.statuses ?? null,
        query.categories ?? null,
        query.severities ?? null,
        after?.at ?? null,
        after?.id ?? null,
        query.limit + 1,
      ],
    );
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return rows.length > query.limit && last !== undefined
      ? { items: items.map(toFinding), nextCursor: encodeCursor(fingerprint, last) }
      : { items: items.map(toFinding) };
  }

  async counts(
    clinicId: ClinicId,
    query: Pick<FindingListQuery, 'mode' | 'patientId'>,
  ): Promise<FindingCounts> {
    const { rows } = await this.#ctx.db().query<{
      status: string;
      category: string;
      severity: string;
      total: string;
    }>(
      `SELECT status, category, severity, count(*) AS total
       FROM ${this.#ctx.tables.clinical_findings}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR mode = $2) AND ($3::text IS NULL OR patient_id = $3)
       GROUP BY status, category, severity`,
      [clinicId, query.mode ?? null, query.patientId ?? null],
    );
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byCategoryStatus: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.total);
      total += count;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
      byCategory[row.category] = (byCategory[row.category] ?? 0) + count;
      bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + count;
      const perStatus = (byCategoryStatus[row.category] ??= {});
      perStatus[row.status] = (perStatus[row.status] ?? 0) + count;
    }
    return { total, byStatus, byCategory, bySeverity, byCategoryStatus };
  }
}

interface RunRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly trigger_event: ClinicalReviewRun['trigger'];
  readonly status: ClinicalReviewRun['status'];
  readonly signals_count: number;
  readonly findings_count: number;
  readonly discarded_count: number;
  readonly duplicate_count: number;
  readonly discarded: ClinicalReviewRun['discarded'];
  readonly steps: number;
  readonly tool_calls: number;
  readonly trace: readonly ReviewStep[];
  readonly input_tokens: number;
  readonly output_tokens: number;
  /** `numeric` comes back as text. */
  readonly cost_usd: string;
  readonly model_id: string;
  readonly prompt_version: string;
  readonly stop_reason: string;
  readonly error: string | null;
  readonly started_at: Date;
  readonly finished_at: Date;
}

const RUN_COLUMNS = `clinic_id, id, patient_id, trigger_event, status, signals_count, findings_count,
  discarded_count, duplicate_count, discarded, steps, tool_calls, trace, input_tokens, output_tokens,
  cost_usd, model_id, prompt_version, stop_reason, error, started_at, finished_at`;

function toRun(row: RunRow): ClinicalReviewRun {
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    trigger: row.trigger_event,
    status: row.status,
    signalsCount: row.signals_count,
    findingsCount: row.findings_count,
    discardedCount: row.discarded_count,
    duplicateCount: row.duplicate_count,
    discarded: row.discarded,
    steps: row.steps,
    toolCalls: row.tool_calls,
    trace: row.trace,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: Number(row.cost_usd),
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    stopReason: row.stop_reason,
    ...optional('error', row.error),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Review runs (`clinical_review_runs`). */
export class PostgresClinicalReviewRunRepository implements ClinicalReviewRunRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async record(clinicId: ClinicId, run: ClinicalReviewRun): Promise<void> {
    if (run.clinicId !== clinicId) throw new TenantMismatchError();
    try {
      await this.#ctx.db().query(
        `INSERT INTO ${this.#ctx.tables.clinical_review_runs} (${RUN_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15,
                 $16, $17, $18, $19, $20, $21, $22)`,
        [
          clinicId,
          run.id,
          run.patientId,
          run.trigger,
          run.status,
          run.signalsCount,
          run.findingsCount,
          run.discardedCount,
          run.duplicateCount,
          jsonParam(run.discarded),
          run.steps,
          run.toolCalls,
          jsonParam(run.trace),
          run.inputTokens,
          run.outputTokens,
          run.costUsd.toFixed(6),
          run.modelId,
          run.promptVersion,
          run.stopReason,
          run.error ?? null,
          run.startedAt,
          run.finishedAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('ClinicalReviewRun', run.id);
      throw error;
    }
  }

  async get(clinicId: ClinicId, id: string): Promise<ClinicalReviewRun | undefined> {
    const { rows } = await this.#ctx.db().query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM ${this.#ctx.tables.clinical_review_runs}
       WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toRun(row);
  }

  async lastReviewedAt(clinicId: ClinicId, patientId: PatientId): Promise<Date | undefined> {
    const { rows } = await this.#ctx.db().query<{ at: Date | null }>(
      `SELECT max(started_at) AS at FROM ${this.#ctx.tables.clinical_review_runs}
       WHERE clinic_id = $1 AND patient_id = $2 AND status <> 'failed'`,
      [clinicId, patientId],
    );
    return rows[0]?.at ?? undefined;
  }

  async stats(clinicId: ClinicId, since: Date): Promise<ReviewRunStats> {
    const { rows } = await this.#ctx.db().query<Record<string, string | null>>(
      `SELECT count(*) AS runs,
              count(DISTINCT patient_id) AS patients,
              coalesce(sum(findings_count), 0) AS findings,
              coalesce(sum(discarded_count), 0) AS discarded,
              coalesce(sum(duplicate_count), 0) AS duplicates,
              count(*) FILTER (WHERE status = 'degraded') AS degraded,
              coalesce(sum(steps), 0) AS steps,
              coalesce(sum(tool_calls), 0) AS tool_calls,
              coalesce(sum(cost_usd), 0) AS cost
       FROM ${this.#ctx.tables.clinical_review_runs}
       WHERE clinic_id = $1 AND started_at >= $2`,
      [clinicId, since],
    );
    const row = rows[0] ?? {};
    const value = (key: string): number => Number(row[key] ?? 0);
    return {
      runs: value('runs'),
      patientsReviewed: value('patients'),
      findings: value('findings'),
      discarded: value('discarded'),
      duplicates: value('duplicates'),
      degraded: value('degraded'),
      steps: value('steps'),
      toolCalls: value('tool_calls'),
      costUsd: value('cost'),
    };
  }
}

interface FlagRow {
  readonly clinic_id: string;
  readonly category: FindingFlag['category'];
  readonly specialty: string;
  readonly enabled: boolean;
  readonly mode: FindingFlag['mode'];
  readonly validated_by: string | null;
  readonly validated_at: Date | null;
  readonly updated_by: string | null;
  readonly updated_at: Date;
}

/** Finding category flags (`finding_flags`); `specialty = ''` is the clinic-wide flag. */
export class PostgresFindingFlagRepository implements FindingFlagRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async list(clinicId: ClinicId): Promise<readonly FindingFlag[]> {
    const { rows } = await this.#ctx.db().query<FlagRow>(
      `SELECT clinic_id, category, specialty, enabled, mode, validated_by, validated_at,
              updated_by, updated_at
       FROM ${this.#ctx.tables.finding_flags}
       WHERE clinic_id = $1
       ORDER BY category COLLATE "C", specialty COLLATE "C"`,
      [clinicId],
    );
    return rows.map((row) => ({
      clinicId: row.clinic_id as ClinicId,
      category: row.category,
      ...(row.specialty === '' ? {} : { specialty: row.specialty }),
      enabled: row.enabled,
      mode: row.mode,
      ...optional('validatedBy', row.validated_by),
      ...optional('validatedAt', row.validated_at),
      ...optional('updatedBy', row.updated_by),
      updatedAt: row.updated_at,
    }));
  }

  async upsert(clinicId: ClinicId, flag: FindingFlag): Promise<void> {
    if (flag.clinicId !== clinicId) throw new TenantMismatchError();
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.finding_flags}
         (clinic_id, category, specialty, enabled, mode, validated_by, validated_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (clinic_id, category, specialty) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         mode = EXCLUDED.mode,
         validated_by = EXCLUDED.validated_by,
         validated_at = EXCLUDED.validated_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = EXCLUDED.updated_at`,
      [
        clinicId,
        flag.category,
        flag.specialty ?? '',
        flag.enabled,
        flag.mode,
        flag.validatedBy ?? null,
        flag.validatedAt ?? null,
        flag.updatedBy ?? null,
        flag.updatedAt,
      ],
    );
  }
}
