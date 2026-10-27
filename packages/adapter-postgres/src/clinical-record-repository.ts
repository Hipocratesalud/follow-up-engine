import {
  TenantMismatchError,
  type ClinicalEvent,
  type ClinicalEventQuery,
  type ClinicalRecordRepository,
  type ClinicId,
  type FhirResourceJson,
  isOlderResourceVersion,
  type PatientId,
  type PatientIdPage,
  type ResourceRef,
  type SaveResourceResult,
  type SourcePatient,
  type StoredResource,
} from '@follow-up-engine/core';
import { decodeClinicalEvent } from './codec.ts';
import { jsonParam, type RepositoryContext } from './sql.ts';

interface ResourceRow {
  readonly patient_id: string;
  readonly resource: FhirResourceJson;
  readonly version: number;
  readonly received_at: Date;
}

interface EventRow {
  readonly payload: Parameters<typeof decodeClinicalEvent>[0];
}

/**
 * Raw FHIR resources (latest version only, see the migration) and the
 * append-only log of clinical events derived from them.
 */
export class PostgresClinicalRecordRepository implements ClinicalRecordRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async saveResource(
    clinicId: ClinicId,
    patientId: PatientId,
    resource: FhirResourceJson,
    receivedAt: Date,
  ): Promise<SaveResourceResult> {
    const { clinical_resources: table } = this.#ctx.tables;
    // Out-of-order delivery: an older version than the stored one changes
    // nothing. The row lock keeps a concurrent newer version from slipping
    // in between the comparison and the write.
    const current = await this.#ctx.db().query<{ version: number; resource: FhirResourceJson }>(
      `SELECT version, resource FROM ${table}
       WHERE clinic_id = $1 AND resource_type = $2 AND resource_id = $3
       FOR UPDATE`,
      [clinicId, resource.resourceType, resource.id],
    );
    const [stored] = current.rows;
    if (stored !== undefined && isOlderResourceVersion(resource, stored.resource)) {
      return { versionId: String(stored.version), changed: false, stale: true };
    }
    // `jsonb` equality is semantic (key order and whitespace do not matter),
    // so a re-delivery of the same content leaves the version untouched.
    const upserted = await this.#ctx.db().query<{ version: number }>(
      `INSERT INTO ${table} AS r (clinic_id, resource_type, resource_id, patient_id, resource, received_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (clinic_id, resource_type, resource_id) DO UPDATE
         SET version = r.version + 1,
             patient_id = EXCLUDED.patient_id,
             resource = EXCLUDED.resource,
             received_at = EXCLUDED.received_at
         WHERE r.resource IS DISTINCT FROM EXCLUDED.resource
            OR r.patient_id IS DISTINCT FROM EXCLUDED.patient_id
       RETURNING version`,
      [clinicId, resource.resourceType, resource.id, patientId, jsonParam(resource), receivedAt],
    );
    const changed = upserted.rows[0];
    if (changed !== undefined) {
      return { versionId: String(changed.version), changed: true };
    }
    const existing = await this.#ctx
      .db()
      .query<{ version: number }>(
        `SELECT version FROM ${table} WHERE clinic_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [clinicId, resource.resourceType, resource.id],
      );
    const [row] = existing.rows;
    if (row === undefined) {
      throw new Error(`Resource ${resource.resourceType}/${resource.id} vanished during upsert`);
    }
    return { versionId: String(row.version), changed: false };
  }

  async getResource(clinicId: ClinicId, ref: ResourceRef): Promise<StoredResource | undefined> {
    const { rows } = await this.#ctx.db().query<ResourceRow>(
      `SELECT patient_id, resource, version, received_at FROM ${this.#ctx.tables.clinical_resources}
       WHERE clinic_id = $1 AND resource_type = $2 AND resource_id = $3`,
      [clinicId, ref.resourceType, ref.id],
    );
    const [row] = rows;
    return row === undefined
      ? undefined
      : {
          patientId: row.patient_id as PatientId,
          resource: row.resource,
          versionId: String(row.version),
          receivedAt: row.received_at,
        };
  }

  async appendEvents(
    clinicId: ClinicId,
    events: readonly ClinicalEvent[],
  ): Promise<{ inserted: number }> {
    if (events.some((event) => event.clinicId !== clinicId)) {
      throw new TenantMismatchError();
    }
    if (events.length === 0) {
      return { inserted: 0 };
    }
    // One statement for the whole batch, in array order (so `seq` breaks
    // `occurredAt` ties in insertion order). Duplicates, including within
    // the batch, are skipped by the unique idempotency key.
    const result = await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.clinical_events}
         (clinic_id, type, patient_id, encounter_id, occurred_at, idempotency_key, source_type, source_id, payload)
       SELECT $1, e->>'type', e->>'patientId', e->>'encounterId', (e->>'occurredAt')::timestamptz,
              e->>'idempotencyKey', e->'source'->>'resourceType', e->'source'->>'id', e
       FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS batch(e, ordinal)
       ORDER BY ordinal
       ON CONFLICT (clinic_id, idempotency_key) DO NOTHING`,
      [clinicId, jsonParam(events)],
    );
    return { inserted: result.rowCount ?? 0 };
  }

  async listEventsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    query: ClinicalEventQuery = {},
  ): Promise<readonly ClinicalEvent[]> {
    const { rows } = await this.#ctx.db().query<EventRow>(
      `SELECT payload FROM ${this.#ctx.tables.clinical_events}
       WHERE clinic_id = $1 AND patient_id = $2
         AND ($3::text[] IS NULL OR type = ANY($3::text[]))
         AND ($4::timestamptz IS NULL OR occurred_at >= $4)
         AND ($5::timestamptz IS NULL OR occurred_at < $5)
       ORDER BY occurred_at, seq`,
      [clinicId, patientId, query.types ?? null, query.since ?? null, query.until ?? null],
    );
    return rows.map((row) => decodeClinicalEvent(row.payload));
  }

  async findOtherPatientsWithSources(
    clinicId: ClinicId,
    exceptPatientId: PatientId,
    sources: readonly ResourceRef[],
  ): Promise<readonly SourcePatient[]> {
    if (sources.length === 0) {
      return [];
    }
    const { rows } = await this.#ctx.db().query<{
      source_type: string;
      source_id: string;
      patient_id: string;
    }>(
      `SELECT DISTINCT e.source_type, e.source_id, e.patient_id
       FROM ${this.#ctx.tables.clinical_events} e
       JOIN unnest($3::text[], $4::text[]) AS s(source_type, source_id)
         ON e.source_type = s.source_type AND e.source_id = s.source_id
       WHERE e.clinic_id = $1 AND e.patient_id <> $2
       ORDER BY e.source_type, e.source_id, e.patient_id`,
      [
        clinicId,
        exceptPatientId,
        sources.map((source) => source.resourceType),
        sources.map((source) => source.id),
      ],
    );
    return rows.map((row) => ({
      source: { resourceType: row.source_type, id: row.source_id },
      patientId: row.patient_id as PatientId,
    }));
  }

  async listPatientIds(
    clinicId: ClinicId,
    page: { readonly after?: PatientId; readonly limit: number },
  ): Promise<PatientIdPage> {
    const { rows } = await this.#ctx.db().query<{ patient_id: string }>(
      `SELECT DISTINCT patient_id FROM ${this.#ctx.tables.clinical_events}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR patient_id > $2)
       ORDER BY patient_id
       LIMIT $3`,
      [clinicId, page.after ?? null, page.limit + 1],
    );
    const patientIds = rows.slice(0, page.limit).map((row) => row.patient_id as PatientId);
    const last = patientIds.at(-1);
    return rows.length > page.limit && last !== undefined
      ? { patientIds, next: last }
      : { patientIds };
  }
}
