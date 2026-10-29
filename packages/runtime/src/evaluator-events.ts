import { randomUUID } from 'node:crypto';
import { DEFAULT_SCHEMA, type Queryable } from '@follow-up-engine/adapter-postgres';
import type { ClinicId, PatientId } from '@follow-up-engine/core';

/**
 * Every action the hosted demo's evaluator lab tracks (docs/deploy.md#hosted-demo):
 * the access gate's login, every mutating inbox action a physician takes
 * (case feedback and verdict, dismiss/resolve/snooze/request-contact,
 * plan-item review, suppressions, clinical-review finding feedback), the
 * lab's own actions (document upload, patient creation, date-impact
 * preview) and two lightweight views (case detail, a patient's documents).
 */
export const EVALUATOR_ACTIONS = [
  'login',
  'case_feedback',
  'case_dismiss',
  'case_resolve',
  'case_snooze',
  'case_request_contact',
  'case_call_outcome',
  'suppression_reactivate',
  'plan_item_confirm',
  'plan_item_correct',
  'plan_item_reject',
  'finding_review',
  'lab_patient_created',
  'lab_document_uploaded',
  'lab_record_added',
  'lab_date_viewed',
  'case_viewed',
  'patient_documents_viewed',
  /** A physician's verdict on one guided engine test (docs/deploy.md#engine-tests). */
  'engine_test_verdict',
] as const;
export type EvaluatorAction = (typeof EVALUATOR_ACTIONS)[number];

export function isEvaluatorAction(value: string): value is EvaluatorAction {
  return (EVALUATOR_ACTIONS as readonly string[]).includes(value);
}

/** One row of the append-only `evaluator_events` log (migration 0016). */
export interface EvaluatorEvent {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly evaluatorEmail: string;
  readonly action: EvaluatorAction;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly patientId?: PatientId;
  readonly payload?: Record<string, unknown>;
  /** The engine clock's `now()` when the action happened: what the evaluator was looking at. */
  readonly simulatedAt: Date;
  /** The wall clock: when it really happened. */
  readonly occurredAt: Date;
}

export type NewEvaluatorEvent = Omit<EvaluatorEvent, 'id'> & { readonly id?: string };

export interface EvaluatorEventQuery {
  readonly clinicId?: ClinicId;
  readonly evaluatorEmail?: string;
  readonly limit: number;
  /** Offset cursor: the previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface EvaluatorEventPage {
  readonly items: readonly EvaluatorEvent[];
  readonly total: number;
  readonly nextCursor?: string;
}

/** Per evaluator, for the "Evaluators" admin page: last seen and counts by action. */
export interface EvaluatorSummary {
  readonly evaluatorEmail: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly total: number;
  readonly byAction: Partial<Record<EvaluatorAction, number>>;
}

/**
 * The evaluator lab's action log, append-only. Deliberately not clinic
 * scoped on read (unlike every domain store): the "Evaluators" admin page is
 * the demo operator's cross-clinic view of what every evaluator did, in the
 * shared clinic and in their own lab clinics alike. Writes always carry the
 * clinic the action happened in.
 */
export interface EvaluatorEventStore {
  record(event: NewEvaluatorEvent): Promise<EvaluatorEvent>;
  list(query: EvaluatorEventQuery): Promise<EvaluatorEventPage>;
  /** Every evaluator seen, newest activity first. */
  summary(): Promise<readonly EvaluatorSummary[]>;
}

function newId(id: string | undefined): string {
  return id ?? randomUUID();
}

/** {@link EvaluatorEventStore} for the memory runtime (offline demo, tests). */
export class MemoryEvaluatorEventStore implements EvaluatorEventStore {
  readonly #events: EvaluatorEvent[] = [];

  record(event: NewEvaluatorEvent): Promise<EvaluatorEvent> {
    const stored: EvaluatorEvent = { ...event, id: newId(event.id) };
    this.#events.push(stored);
    return Promise.resolve(stored);
  }

  list(query: EvaluatorEventQuery): Promise<EvaluatorEventPage> {
    const matches = this.#events
      .filter((event) => query.clinicId === undefined || event.clinicId === query.clinicId)
      .filter(
        (event) =>
          query.evaluatorEmail === undefined || event.evaluatorEmail === query.evaluatorEmail,
      )
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const end = start + query.limit;
    const items = matches.slice(start, end);
    return Promise.resolve({
      items,
      total: matches.length,
      ...(end < matches.length ? { nextCursor: String(end) } : {}),
    });
  }

  summary(): Promise<readonly EvaluatorSummary[]> {
    const byEmail = new Map<string, EvaluatorEvent[]>();
    for (const event of this.#events) {
      const list = byEmail.get(event.evaluatorEmail) ?? [];
      list.push(event);
      byEmail.set(event.evaluatorEmail, list);
    }
    const summaries = [...byEmail.entries()].map(([evaluatorEmail, events]) => {
      const byAction: Partial<Record<EvaluatorAction, number>> = {};
      for (const event of events) {
        byAction[event.action] = (byAction[event.action] ?? 0) + 1;
      }
      const occurredTimes = events.map((event) => event.occurredAt.getTime());
      return {
        evaluatorEmail,
        firstSeenAt: new Date(Math.min(...occurredTimes)),
        lastSeenAt: new Date(Math.max(...occurredTimes)),
        total: events.length,
        byAction,
      };
    });
    summaries.sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
    return Promise.resolve(summaries);
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

interface EventRow {
  readonly id: string;
  readonly clinic_id: string;
  readonly evaluator_email: string;
  readonly action: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly patient_id: string | null;
  readonly payload: Record<string, unknown> | null;
  readonly simulated_at: Date;
  readonly occurred_at: Date;
}

function toEvent(row: EventRow): EvaluatorEvent {
  const action = isEvaluatorAction(row.action) ? row.action : 'login';
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    evaluatorEmail: row.evaluator_email,
    action,
    ...(row.entity_type === null ? {} : { entityType: row.entity_type }),
    ...(row.entity_id === null ? {} : { entityId: row.entity_id }),
    ...(row.patient_id === null ? {} : { patientId: row.patient_id as PatientId }),
    ...(row.payload === null ? {} : { payload: row.payload }),
    simulatedAt: row.simulated_at,
    occurredAt: row.occurred_at,
  };
}

/** {@link EvaluatorEventStore} over the `evaluator_events` table (migration 0016). */
export class PostgresEvaluatorEventStore implements EvaluatorEventStore {
  readonly #db: () => Queryable;
  readonly #table: string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(`Invalid schema name: ${schema}`);
    }
    this.#db = db;
    this.#table = `"${schema}".evaluator_events`;
  }

  async record(event: NewEvaluatorEvent): Promise<EvaluatorEvent> {
    const id = newId(event.id);
    await this.#db().query(
      `INSERT INTO ${this.#table}
         (id, clinic_id, evaluator_email, action, entity_type, entity_id, patient_id, payload,
          simulated_at, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        id,
        event.clinicId,
        event.evaluatorEmail,
        event.action,
        event.entityType ?? null,
        event.entityId ?? null,
        event.patientId ?? null,
        event.payload === undefined ? null : JSON.stringify(event.payload),
        event.simulatedAt,
        event.occurredAt,
      ],
    );
    return { ...event, id };
  }

  async list(query: EvaluatorEventQuery): Promise<EvaluatorEventPage> {
    const start = query.cursor === undefined ? 0 : Number(query.cursor);
    const { rows: countRows } = await this.#db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.#table}
       WHERE ($1::text IS NULL OR clinic_id = $1) AND ($2::text IS NULL OR evaluator_email = $2)`,
      [query.clinicId ?? null, query.evaluatorEmail ?? null],
    );
    const total = Number(countRows[0]?.count ?? '0');
    const { rows } = await this.#db().query<EventRow>(
      `SELECT id, clinic_id, evaluator_email, action, entity_type, entity_id, patient_id, payload,
              simulated_at, occurred_at
       FROM ${this.#table}
       WHERE ($1::text IS NULL OR clinic_id = $1) AND ($2::text IS NULL OR evaluator_email = $2)
       ORDER BY seq DESC
       OFFSET $3 LIMIT $4`,
      [query.clinicId ?? null, query.evaluatorEmail ?? null, start, query.limit],
    );
    const items = rows.map(toEvent);
    const end = start + query.limit;
    return { items, total, ...(end < total ? { nextCursor: String(end) } : {}) };
  }

  async summary(): Promise<readonly EvaluatorSummary[]> {
    const { rows } = await this.#db().query<{
      evaluator_email: string;
      first_seen_at: Date;
      last_seen_at: Date;
      action: string;
      count: string;
    }>(
      `SELECT evaluator_email, action, count(*)::text AS count,
              min(occurred_at) AS first_seen_at, max(occurred_at) AS last_seen_at
       FROM ${this.#table}
       GROUP BY evaluator_email, action`,
    );
    const byEmail = new Map<
      string,
      { firstSeenAt: Date; lastSeenAt: Date; byAction: Partial<Record<EvaluatorAction, number>> }
    >();
    for (const row of rows) {
      const entry = byEmail.get(row.evaluator_email) ?? {
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        byAction: {},
      };
      entry.firstSeenAt =
        row.first_seen_at < entry.firstSeenAt ? row.first_seen_at : entry.firstSeenAt;
      entry.lastSeenAt = row.last_seen_at > entry.lastSeenAt ? row.last_seen_at : entry.lastSeenAt;
      if (isEvaluatorAction(row.action)) {
        entry.byAction[row.action] = Number(row.count);
      }
      byEmail.set(row.evaluator_email, entry);
    }
    const summaries = [...byEmail.entries()].map(([evaluatorEmail, entry]) => ({
      evaluatorEmail,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      total: Object.values(entry.byAction).reduce((sum, count) => sum + count, 0),
      byAction: entry.byAction,
    }));
    summaries.sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
    return summaries;
  }
}
