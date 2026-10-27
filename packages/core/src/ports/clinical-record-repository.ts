import type { ClinicalEvent, ClinicalEventType } from '../domain/clinical-event.ts';
import type { ClinicId, PatientId } from '../domain/ids.ts';
import type { FhirResourceJson, ResourceRef } from '../domain/resource.ts';

/** A raw FHIR resource as stored, with storage metadata. */
export interface StoredResource {
  readonly patientId: PatientId;
  readonly resource: FhirResourceJson;
  /** Changes when, and only when, the stored content changes (FHIR `meta.versionId`). */
  readonly versionId: string;
  readonly receivedAt: Date;
}

export interface SaveResourceResult {
  readonly versionId: string;
  /** False when identical content was already stored (idempotent re-delivery), or when stale. */
  readonly changed: boolean;
  /**
   * The resource was an older version of the stored one (see
   * `isOlderResourceVersion`): nothing was stored, and its events must not
   * be ingested.
   */
  readonly stale?: boolean;
}

/** A patient with events derived from a resource. */
export interface SourcePatient {
  readonly source: ResourceRef;
  readonly patientId: PatientId;
}

export interface ClinicalEventQuery {
  readonly types?: readonly ClinicalEventType[];
  /** Inclusive lower bound on `occurredAt`. */
  readonly since?: Date;
  /** Exclusive upper bound on `occurredAt`. */
  readonly until?: Date;
}

export interface PatientIdPage {
  readonly patientIds: readonly PatientId[];
  /** Pass as `after` to get the next page; absent on the last page. */
  readonly next?: PatientId;
}

/**
 * The engine's copy of what the host pushed: raw FHIR resources (`jsonb`)
 * and the normalized clinical events derived from them.
 */
export interface ClinicalRecordRepository {
  /**
   * Inserts or replaces a resource keyed by `resourceType/id` in the clinic.
   * Idempotent. An older version than the stored one (out-of-order
   * delivery) is not stored: `{ changed: false, stale: true }`.
   */
  saveResource(
    clinicId: ClinicId,
    patientId: PatientId,
    resource: FhirResourceJson,
    receivedAt: Date,
  ): Promise<SaveResourceResult>;

  getResource(clinicId: ClinicId, ref: ResourceRef): Promise<StoredResource | undefined>;

  /**
   * Stores events, skipping any whose `idempotencyKey` already exists.
   *
   * @returns how many were new.
   */
  appendEvents(clinicId: ClinicId, events: readonly ClinicalEvent[]): Promise<{ inserted: number }>;

  /** A patient's events, chronologically by `occurredAt` (ties in insertion order). */
  listEventsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    query?: ClinicalEventQuery,
  ): Promise<readonly ClinicalEvent[]>;

  /**
   * The patients other than `exceptPatientId` that have events derived from
   * any of `sources`: a resource whose subject was corrected left its events
   * on the old patient.
   */
  findOtherPatientsWithSources(
    clinicId: ClinicId,
    exceptPatientId: PatientId,
    sources: readonly ResourceRef[],
  ): Promise<readonly SourcePatient[]>;

  /** Pages through every patient with at least one event, ordered by id (used by backfill). */
  listPatientIds(
    clinicId: ClinicId,
    page: { readonly after?: PatientId; readonly limit: number },
  ): Promise<PatientIdPage>;
}
