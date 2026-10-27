import type { MemoryDatabase } from '@follow-up-engine/adapter-memory';
import { DEFAULT_SCHEMA, type Queryable } from '@follow-up-engine/adapter-postgres';
import type {
  CaseId,
  ClinicId,
  Evidence,
  Expectation,
  ExpectationId,
  ExpectationLayer,
  ExpectationStatus,
  FhirResourceJson,
  Origin,
  PatientId,
} from '@follow-up-engine/core';

/** A stored `Patient` resource. */
export interface PatientRecord {
  readonly id: string;
  readonly resource: FhirResourceJson;
}

/** LLM usage of a clinic over a period, for the inbox stats. */
export interface LlmUsageSummary {
  /** Provider calls (retries and repairs included). */
  readonly calls: number;
  readonly successfulCalls: number;
  readonly costUsd: number;
}

/**
 * Read-only queries the inbox and the FHIR search need that the core ports
 * deliberately do not offer (they serve the engine's write paths). Kept in
 * the composition root, next to the adapters it reads.
 *
 * Candidates for the core ports: `ExpectationRepository.listByPatient`
 * and `LlmUsageLog.summary`.
 */
export interface ReadModel {
  /** Every expectation of a patient, whatever its status, by `dueAt` descending. */
  expectationsByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly Expectation[]>;
  expectationsByIds(
    clinicId: ClinicId,
    ids: readonly ExpectationId[],
  ): Promise<readonly Expectation[]>;
  /** Stored `Patient` resources whose id or name contains `query` (case-insensitive). */
  searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]>;
  llmUsage(clinicId: ClinicId, since: Date): Promise<LlmUsageSummary>;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matchesPatient(record: PatientRecord, query: string | undefined): boolean {
  if (query === undefined || query === '') {
    return true;
  }
  const needle = normalize(query);
  return normalize(`${record.id} ${JSON.stringify(record.resource['name'] ?? '')}`).includes(
    needle,
  );
}

/** {@link ReadModel} over the memory adapters' database. */
export class MemoryReadModel implements ReadModel {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  expectationsByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly Expectation[]> {
    const found = [...this.#db.state.expectations.values()]
      .filter((item) => item.clinicId === clinicId && item.patientId === patientId)
      .sort((left, right) => right.dueAt.getTime() - left.dueAt.getTime());
    return Promise.resolve(structuredClone(found));
  }

  expectationsByIds(
    clinicId: ClinicId,
    ids: readonly ExpectationId[],
  ): Promise<readonly Expectation[]> {
    const wanted = new Set<string>(ids);
    return Promise.resolve(
      structuredClone(
        [...this.#db.state.expectations.values()].filter(
          (item) => item.clinicId === clinicId && wanted.has(item.id),
        ),
      ),
    );
  }

  searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]> {
    const records = [...this.#db.state.resources.values()]
      .filter((row) => row.clinicId === clinicId && row.resource.resourceType === 'Patient')
      .map((row) => ({ id: row.resource.id, resource: structuredClone(row.resource) }))
      .filter((record) => matchesPatient(record, options.query))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, options.limit);
    return Promise.resolve(records);
  }

  llmUsage(clinicId: ClinicId, since: Date): Promise<LlmUsageSummary> {
    const calls = this.#db.state.llmCalls.filter(
      (call) => call.clinicId === clinicId && call.at.getTime() >= since.getTime(),
    );
    return Promise.resolve({
      calls: calls.length,
      successfulCalls: calls.filter((call) => call.ok).length,
      costUsd: calls.reduce((total, call) => total + call.costUsd, 0),
    });
  }
}

interface ExpectationRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly idempotency_key: string;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly layer: ExpectationLayer;
  readonly source_type: string;
  readonly source_id: string;
  readonly match_key: string;
  readonly due_at: Date;
  readonly status: ExpectationStatus;
  readonly case_id: string | null;
  readonly closed_reason: string | null;
  readonly closed_at: Date | null;
  readonly origin: Origin;
  readonly protocol_id: string | null;
  readonly protocol_version: string | null;
  readonly reason_code: string;
  readonly reason_label: string;
  readonly evidence: Evidence | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toExpectation(row: ExpectationRow): Expectation {
  return {
    id: row.id as ExpectationId,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    idempotencyKey: row.idempotency_key,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    layer: row.layer,
    source: { resourceType: row.source_type, id: row.source_id },
    matchKey: row.match_key,
    dueAt: row.due_at,
    status: row.status,
    ...(row.case_id === null ? {} : { caseId: row.case_id as CaseId }),
    ...(row.closed_reason === null ? {} : { closedReason: row.closed_reason }),
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    origin: row.origin,
    ...(row.protocol_id === null ? {} : { protocolId: row.protocol_id }),
    ...(row.protocol_version === null ? {} : { protocolVersion: row.protocol_version }),
    reason: { code: row.reason_code, label: row.reason_label },
    ...(row.evidence === null ? {} : { evidence: row.evidence }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** {@link ReadModel} over the Postgres adapter's tables (schema `follow_up` by default). */
export class PostgresReadModel implements ReadModel {
  readonly #db: () => Queryable;
  readonly #schema: string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(`Invalid schema name: ${schema}`);
    }
    this.#db = db;
    this.#schema = `"${schema}"`;
  }

  async expectationsByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly Expectation[]> {
    const { rows } = await this.#db().query<ExpectationRow>(
      `SELECT * FROM ${this.#schema}.expectations
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY due_at DESC, id`,
      [clinicId, patientId],
    );
    return rows.map(toExpectation);
  }

  async expectationsByIds(
    clinicId: ClinicId,
    ids: readonly ExpectationId[],
  ): Promise<readonly Expectation[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.#db().query<ExpectationRow>(
      `SELECT * FROM ${this.#schema}.expectations WHERE clinic_id = $1 AND id = ANY($2::text[])`,
      [clinicId, ids],
    );
    return rows.map(toExpectation);
  }

  async searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]> {
    const query = options.query === undefined || options.query === '' ? null : options.query;
    const { rows } = await this.#db().query<{ resource_id: string; resource: FhirResourceJson }>(
      `SELECT resource_id, resource FROM ${this.#schema}.clinical_resources
       WHERE clinic_id = $1 AND resource_type = 'Patient'
         AND ($2::text IS NULL
              OR resource_id ILIKE '%' || $2 || '%'
              OR (resource -> 'name')::text ILIKE '%' || $2 || '%')
       ORDER BY resource_id LIMIT $3`,
      [clinicId, query, options.limit],
    );
    return rows.map((row) => ({ id: row.resource_id, resource: row.resource }));
  }

  async llmUsage(clinicId: ClinicId, since: Date): Promise<LlmUsageSummary> {
    const { rows } = await this.#db().query<{ calls: string; ok: string; cost: string }>(
      `SELECT count(*)::text AS calls, count(*) FILTER (WHERE ok)::text AS ok,
              COALESCE(sum(cost_usd), 0)::text AS cost
       FROM ${this.#schema}.llm_calls WHERE clinic_id = $1 AND at >= $2`,
      [clinicId, since],
    );
    const [row] = rows;
    return {
      calls: Number(row?.calls ?? 0),
      successfulCalls: Number(row?.ok ?? 0),
      costUsd: Number(row?.cost ?? 0),
    };
  }
}
