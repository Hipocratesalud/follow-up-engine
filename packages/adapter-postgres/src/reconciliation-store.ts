import {
  type ClinicId,
  ConflictError,
  NotFoundError,
  type PatientId,
  RECONCILIATION_REPAIR_KINDS,
  type ReconciliationCounts,
  type ReconciliationRepair,
  type ReconciliationRepairKind,
  type ReconciliationRun,
  type ReconciliationScope,
  type ReconciliationStatus,
  type ReconciliationStore,
  type RepairCounts,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface RunRow {
  readonly clinic_id: string;
  readonly run_id: string;
  readonly scope: ReconciliationScope;
  readonly status: ReconciliationStatus;
  readonly watermark: string | null;
  readonly since: string | null;
  readonly patient_cursor: string | null;
  readonly patients_scanned: number;
  readonly patients_repaired: number;
  readonly patients_skipped: number;
  readonly repairs: number;
  readonly repairs_by_kind: Record<string, number>;
  readonly last_error: string | null;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
}

interface RepairRow {
  readonly clinic_id: string;
  readonly run_id: string;
  readonly patient_id: string;
  readonly kind: ReconciliationRepairKind;
  readonly entity_id: string;
  readonly rule_id: string | null;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly detail: string | null;
  readonly actor_type: 'system';
  readonly actor_id: string;
  readonly at: Date;
}

const RUN_COLUMNS = `clinic_id, run_id, scope, status, watermark, since, patient_cursor,
  patients_scanned, patients_repaired, patients_skipped, repairs, repairs_by_kind, last_error,
  started_at, updated_at, finished_at`;

/** Only known kinds with a positive count (a stored object is never trusted blindly). */
function repairCounts(stored: Record<string, number>): RepairCounts {
  const counts: Partial<Record<ReconciliationRepairKind, number>> = {};
  for (const kind of RECONCILIATION_REPAIR_KINDS) {
    const count = stored[kind] ?? 0;
    if (count > 0) {
      counts[kind] = count;
    }
  }
  return counts;
}

function toRun(row: RunRow): ReconciliationRun {
  return {
    clinicId: row.clinic_id as ClinicId,
    runId: row.run_id,
    scope: row.scope,
    status: row.status,
    ...optional('watermark', row.watermark),
    ...optional('since', row.since),
    ...optional('cursor', row.patient_cursor as PatientId | null),
    patientsScanned: row.patients_scanned,
    patientsRepaired: row.patients_repaired,
    patientsSkipped: row.patients_skipped,
    repairs: row.repairs,
    repairsByKind: repairCounts(row.repairs_by_kind),
    ...optional('lastError', row.last_error),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...optional('finishedAt', row.finished_at),
  };
}

function toRepair(row: RepairRow): ReconciliationRepair {
  return {
    clinicId: row.clinic_id as ClinicId,
    runId: row.run_id,
    patientId: row.patient_id as PatientId,
    kind: row.kind,
    entityId: row.entity_id,
    ...optional('ruleId', row.rule_id),
    ...optional('from', row.from_status),
    ...optional('to', row.to_status),
    ...optional('detail', row.detail),
    actor: { type: row.actor_type, id: row.actor_id },
    reason: 'reconciliation',
    at: row.at,
  };
}

/** Runs of the nightly reconciliation (`reconciliation_runs`) and their repairs (`reconciliation_repairs`). */
export class PostgresReconciliationStore implements ReconciliationStore {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async start(
    clinicId: ClinicId,
    runId: string,
    options: {
      readonly scope: ReconciliationScope;
      readonly since?: string;
      readonly watermark?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun> {
    const { rows } = await this.#ctx
      .db()
      .query<RunRow>(
        `INSERT INTO ${this.#ctx.tables.reconciliation_runs}
           (clinic_id, run_id, scope, watermark, since, started_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING ${RUN_COLUMNS}`,
        [
          clinicId,
          runId,
          options.scope,
          options.watermark ?? null,
          options.since ?? null,
          options.now,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('ReconciliationRun', runId) : error;
      });
    return this.#one(rows, runId);
  }

  async get(clinicId: ClinicId, runId: string): Promise<ReconciliationRun | undefined> {
    return this.#first(`clinic_id = $1 AND run_id = $2`, [clinicId, runId]);
  }

  async findRunning(clinicId: ClinicId): Promise<ReconciliationRun | undefined> {
    return this.#first(`clinic_id = $1 AND status = 'running'`, [clinicId]);
  }

  async lastCompleted(clinicId: ClinicId): Promise<ReconciliationRun | undefined> {
    return this.#first(`clinic_id = $1 AND status = 'completed'`, [clinicId]);
  }

  async list(
    clinicId: ClinicId,
    query: { readonly limit: number },
  ): Promise<readonly ReconciliationRun[]> {
    const { rows } = await this.#ctx.db().query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM ${this.#ctx.tables.reconciliation_runs}
       WHERE clinic_id = $1 ORDER BY started_at DESC, seq DESC LIMIT $2`,
      [clinicId, query.limit],
    );
    return rows.map(toRun);
  }

  async advance(
    clinicId: ClinicId,
    runId: string,
    step: { readonly cursor: PatientId; readonly delta: ReconciliationCounts; readonly now: Date },
  ): Promise<ReconciliationRun> {
    const { delta } = step;
    const { rows } = await this.#ctx.db().query<RunRow>(
      `UPDATE ${this.#ctx.tables.reconciliation_runs} r SET
         patient_cursor = $3,
         patients_scanned = patients_scanned + $4,
         patients_repaired = patients_repaired + $5,
         patients_skipped = patients_skipped + $6,
         repairs = repairs + $7,
         repairs_by_kind = COALESCE((
           SELECT jsonb_object_agg(kind, COALESCE((r.repairs_by_kind ->> kind)::integer, 0)
                                       + COALESCE(($8::jsonb ->> kind)::integer, 0))
           FROM jsonb_object_keys(r.repairs_by_kind || $8::jsonb) AS kind
         ), '{}'::jsonb),
         updated_at = $9
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
       RETURNING ${RUN_COLUMNS}`,
      [
        clinicId,
        runId,
        step.cursor,
        delta.patientsScanned,
        delta.patientsRepaired,
        delta.patientsSkipped,
        delta.repairs,
        jsonParam(delta.repairsByKind),
        step.now,
      ],
    );
    return this.#one(rows, runId);
  }

  async finish(
    clinicId: ClinicId,
    runId: string,
    outcome: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly now: Date;
    },
  ): Promise<ReconciliationRun> {
    const { rows } = await this.#ctx.db().query<RunRow>(
      `UPDATE ${this.#ctx.tables.reconciliation_runs} SET
         status = $3, last_error = COALESCE($4, last_error), updated_at = $5, finished_at = $5
       WHERE clinic_id = $1 AND run_id = $2 AND status = 'running'
       RETURNING ${RUN_COLUMNS}`,
      [clinicId, runId, outcome.status, outcome.error ?? null, outcome.now],
    );
    return this.#one(rows, runId);
  }

  async recordRepairs(clinicId: ClinicId, repairs: readonly ReconciliationRepair[]): Promise<void> {
    if (repairs.length === 0) {
      return;
    }
    if (repairs.some((repair) => repair.clinicId !== clinicId)) {
      throw new Error('Repair of another clinic');
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.reconciliation_repairs}
         (clinic_id, run_id, patient_id, kind, entity_id, rule_id, from_status, to_status, detail,
          actor_type, actor_id, reason, at)
       SELECT $1, r->>'runId', r->>'patientId', r->>'kind', r->>'entityId', r->>'ruleId', r->>'from',
              r->>'to', r->>'detail', r->'actor'->>'type', r->'actor'->>'id', r->>'reason',
              (r->>'at')::timestamptz
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS batch(r, ordinal)
       ORDER BY ordinal`,
      [clinicId, jsonParam(repairs)],
    );
  }

  async listRepairs(
    clinicId: ClinicId,
    query: { readonly runId?: string; readonly patientId?: PatientId; readonly limit: number },
  ): Promise<readonly ReconciliationRepair[]> {
    const { rows } = await this.#ctx.db().query<RepairRow>(
      `SELECT clinic_id, run_id, patient_id, kind, entity_id, rule_id, from_status, to_status,
              detail, actor_type, actor_id, at
       FROM ${this.#ctx.tables.reconciliation_repairs}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR run_id = $2)
         AND ($3::text IS NULL OR patient_id = $3)
       ORDER BY seq
       LIMIT $4`,
      [clinicId, query.runId ?? null, query.patientId ?? null, query.limit],
    );
    return rows.map(toRepair);
  }

  async #first(where: string, values: readonly unknown[]): Promise<ReconciliationRun | undefined> {
    const { rows } = await this.#ctx.db().query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM ${this.#ctx.tables.reconciliation_runs}
       WHERE ${where} ORDER BY started_at DESC, seq DESC LIMIT 1`,
      values,
    );
    const [row] = rows;
    return row === undefined ? undefined : toRun(row);
  }

  #one(rows: readonly RunRow[], runId: string): ReconciliationRun {
    const [row] = rows;
    if (row === undefined) {
      throw new NotFoundError('ReconciliationRun', runId);
    }
    return toRun(row);
  }
}
