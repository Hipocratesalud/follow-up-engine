import {
  ConflictError,
  TenantMismatchError,
  type AuditLog,
  type CaseEvent,
  type CaseEventActor,
  type CaseEventType,
  type CaseFeedback,
  type CaseFeedbackReason,
  type CaseId,
  type ClinicId,
  type FeedbackId,
  type FeedbackRepository,
  type JsonObject,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface CaseEventRow {
  readonly clinic_id: string;
  readonly case_id: string;
  readonly type: CaseEventType;
  readonly actor_type: CaseEventActor['type'];
  readonly actor_id: string | null;
  readonly payload: JsonObject;
  readonly at: Date;
}

/** Append-only audit trail of cases (`case_events`). The adapter never updates or deletes rows. */
export class PostgresAuditLog implements AuditLog {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async append(clinicId: ClinicId, event: CaseEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.case_events} (clinic_id, case_id, type, actor_type, actor_id, payload, at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        clinicId,
        event.caseId,
        event.type,
        event.actor.type,
        event.actor.id ?? null,
        jsonParam(event.payload),
        event.at,
      ],
    );
  }

  async listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseEvent[]> {
    const { rows } = await this.#ctx.db().query<CaseEventRow>(
      `SELECT clinic_id, case_id, type, actor_type, actor_id, payload, at
       FROM ${this.#ctx.tables.case_events}
       WHERE clinic_id = $1 AND case_id = $2
       ORDER BY at, seq`,
      [clinicId, caseId],
    );
    return rows.map((row) => ({
      clinicId: row.clinic_id as ClinicId,
      caseId: row.case_id as CaseId,
      type: row.type,
      actor: { type: row.actor_type, ...optional('id', row.actor_id) },
      payload: row.payload,
      at: row.at,
    }));
  }
}

interface FeedbackRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly case_id: string;
  readonly useful: boolean;
  readonly reason: CaseFeedbackReason | null;
  readonly comment: string | null;
  readonly author_id: string | null;
  readonly created_at: Date;
}

const FEEDBACK_COLUMNS = 'clinic_id, id, case_id, useful, reason, comment, author_id, created_at';

function toFeedback(row: FeedbackRow): CaseFeedback {
  return {
    id: row.id as FeedbackId,
    clinicId: row.clinic_id as ClinicId,
    caseId: row.case_id as CaseId,
    useful: row.useful,
    ...optional('reason', row.reason),
    ...optional('comment', row.comment),
    ...optional('authorId', row.author_id),
    createdAt: row.created_at,
  };
}

/** Append-only clinician feedback (`case_feedback`). */
export class PostgresFeedbackRepository implements FeedbackRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async record(clinicId: ClinicId, feedback: CaseFeedback): Promise<void> {
    if (feedback.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.case_feedback} (${FEEDBACK_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          clinicId,
          feedback.id,
          feedback.caseId,
          feedback.useful,
          feedback.reason ?? null,
          feedback.comment ?? null,
          feedback.authorId ?? null,
          feedback.createdAt,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('CaseFeedback', feedback.id) : error;
      });
  }

  async listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseFeedback[]> {
    const { rows } = await this.#ctx.db().query<FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM ${this.#ctx.tables.case_feedback}
       WHERE clinic_id = $1 AND case_id = $2
       ORDER BY created_at, id`,
      [clinicId, caseId],
    );
    return rows.map(toFeedback);
  }

  async listSince(
    clinicId: ClinicId,
    since: Date,
    limit: number,
  ): Promise<readonly CaseFeedback[]> {
    const { rows } = await this.#ctx.db().query<FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM ${this.#ctx.tables.case_feedback}
       WHERE clinic_id = $1 AND created_at >= $2
       ORDER BY created_at, id
       LIMIT $3`,
      [clinicId, since, limit],
    );
    return rows.map(toFeedback);
  }
}
