import type { MemoryDatabase } from '@follow-up-engine/adapter-memory';
import { DEFAULT_SCHEMA, type Queryable } from '@follow-up-engine/adapter-postgres';
import type { ClinicId, FhirResourceJson } from '@follow-up-engine/core';

/** A stored `Patient` resource. */
export interface PatientRecord {
  readonly id: string;
  readonly resource: FhirResourceJson;
}

/**
 * The one read query the inbox needs that no core port offers: a search over
 * the stored `Patient` resources by id or name. The engine never searches
 * patients (it works per patient id), so this stays next to the adapters it
 * reads instead of widening `ClinicalRecordRepository`. Everything else the
 * API reads goes through the ports (`ExpectationRepository.listByPatient`,
 * `LlmUsageLog.summary`, `CaseRepository.list`).
 */
export interface ReadModel {
  /** Stored `Patient` resources whose id or name contains `query` (case and accent insensitive in memory). */
  searchPatients(
    clinicId: ClinicId,
    options: { readonly query?: string; readonly limit: number },
  ): Promise<readonly PatientRecord[]>;
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
}
