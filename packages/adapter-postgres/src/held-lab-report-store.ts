import type {
  ClinicId,
  HeldLabReport,
  HeldLabResult,
  HeldLabReportStatus,
  HeldLabReportStore,
  PatientId,
} from '@follow-up-engine/core';
import { DEFAULT_SCHEMA, jsonParam, quoteSchema, type Queryable } from './sql.ts';

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : date(value);
}

function optional<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
}

function toReport(row: Row): HeldLabReport {
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    documentKey: String(row['document_key']),
    filename: String(row['filename']),
    documentDate: date(row['document_date']),
    effectiveAt: date(row['effective_at']),
    ...optional('printedDate', optionalDate(row['printed_date'])),
    ...optional('printedName', row['printed_name'] as string | null),
    ...optional('recordName', row['record_name'] as string | null),
    reason: row['reason'] === 'photo_not_allowed' ? 'photo_not_allowed' : 'name_mismatch',
    source: row['source'] === 'photo' ? 'photo' : 'text',
    ...optional('model', row['model'] as string | null),
    results: (row['results'] ?? []) as HeldLabResult[],
    status: String(row['status']) as HeldLabReportStatus,
    createdAt: date(row['created_at']),
    ...optional('decidedBy', row['decided_by'] as string | null),
    ...optional('decidedAt', optionalDate(row['decided_at'])),
  };
}

/** Postgres {@link HeldLabReportStore} (migration 0025): one row per document key per clinic. */
export class PostgresHeldLabReportStore implements HeldLabReportStore {
  readonly #db: () => Queryable;
  readonly #table: string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    this.#db = db;
    this.#table = `${quoteSchema(schema)}."held_lab_reports"`;
  }

  async hold(report: HeldLabReport): Promise<HeldLabReport> {
    await this.#db().query(
      `INSERT INTO ${this.#table}
         (clinic_id, id, patient_id, document_key, filename, document_date, effective_at,
          printed_date, printed_name, record_name, reason, source, model, results, status,
          created_at, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (clinic_id, document_key) DO NOTHING`,
      [
        report.clinicId,
        report.id,
        report.patientId,
        report.documentKey,
        report.filename,
        report.documentDate,
        report.effectiveAt,
        report.printedDate ?? null,
        report.printedName ?? null,
        report.recordName ?? null,
        report.reason,
        report.source,
        report.model ?? null,
        jsonParam(report.results),
        report.status,
        report.createdAt,
        report.decidedBy ?? null,
        report.decidedAt ?? null,
      ],
    );
    return (await this.findByDocumentKey(report.clinicId, report.documentKey)) ?? report;
  }

  async get(clinicId: ClinicId, id: string): Promise<HeldLabReport | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#table} WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    return rows[0] === undefined ? undefined : toReport(rows[0]);
  }

  async findByDocumentKey(
    clinicId: ClinicId,
    documentKey: string,
  ): Promise<HeldLabReport | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#table} WHERE clinic_id = $1 AND document_key = $2`,
      [clinicId, documentKey],
    );
    return rows[0] === undefined ? undefined : toReport(rows[0]);
  }

  async list(
    clinicId: ClinicId,
    query: { readonly status?: HeldLabReportStatus; readonly patientId?: PatientId } = {},
  ): Promise<readonly HeldLabReport[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#table}
        WHERE clinic_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR patient_id = $3)
        ORDER BY created_at DESC, id ASC`,
      [clinicId, query.status ?? null, query.patientId ?? null],
    );
    return rows.map(toReport);
  }

  async decide(
    clinicId: ClinicId,
    id: string,
    decision: {
      readonly status: Exclude<HeldLabReportStatus, 'pending'>;
      readonly by: string;
      readonly at: Date;
    },
  ): Promise<HeldLabReport | undefined> {
    const { rows } = await this.#db().query<Row>(
      `UPDATE ${this.#table}
          SET status = $3, decided_by = $4, decided_at = $5
        WHERE clinic_id = $1 AND id = $2 AND status = 'pending'
        RETURNING *`,
      [clinicId, id, decision.status, decision.by, decision.at],
    );
    return rows[0] === undefined ? undefined : toReport(rows[0]);
  }
}
