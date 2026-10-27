import {
  type ClinicalBatch,
  type ClinicId,
  type Clock,
  type FhirResourceJson,
  type FollowUpEngine,
  type IngestReport,
  type JobId,
  type JsonObject,
  type PatientId,
  patientId as toPatientId,
  ValidationError,
} from '@follow-up-engine/core';
import {
  type BundleMappingResult,
  mapBundleToBatches,
  type OperationOutcome,
} from '@follow-up-engine/fhir';
import type { Storage } from './storage.ts';

/** Job that runs the engine over an accepted Bundle (asynchronous ingestion). */
export const INGEST_BUNDLE_JOB = 'fhir.ingest_bundle';

/**
 * Resource types that give context to a consultation and are kept so the
 * inbox can show them (the treating practitioner's name), but produce no
 * clinical event.
 */
const CONTEXT_TYPES = new Set(['Practitioner', 'PractitionerRole', 'Organization', 'Location']);

/** Patient id under which context resources of a Bundle without patients are stored. */
export const CLINIC_CONTEXT_OWNER = '_clinic';

export type IngestMode = 'sync' | 'async';

/** A resource the engine stored, for the transaction-response. */
export interface StoredEntry {
  readonly resourceType: string;
  readonly id: string;
  readonly versionId: string;
  readonly changed: boolean;
}

export interface BundleAcceptance {
  /** False when the Bundle was rejected; nothing was stored. */
  readonly ok: boolean;
  /** Errors when rejected; warnings and notes otherwise. */
  readonly outcome?: OperationOutcome;
  readonly stored: readonly StoredEntry[];
  readonly batches: number;
  /** Asynchronous mode: the job that will run the engine. */
  readonly jobId?: JobId;
  /** Synchronous mode: what the engine did with each batch. */
  readonly reports?: readonly IngestReport[];
}

interface IngestJobPayload {
  readonly bundle: unknown;
  readonly receivedAt: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bundle-local identity of an entry, as the FHIR mapping resolves it (id, fullUrl, PUT url). */
function entryId(
  entry: Readonly<Record<string, unknown>>,
  resourceType: string,
): string | undefined {
  const resource = entry['resource'];
  if (isRecord(resource) && typeof resource['id'] === 'string' && resource['id'] !== '') {
    return resource['id'];
  }
  const fullUrl = entry['fullUrl'];
  if (typeof fullUrl === 'string') {
    const urn = /^urn:(?:uuid|oid):(.+)$/.exec(fullUrl);
    if (urn?.[1] !== undefined) {
      return urn[1];
    }
    const absolute = new RegExp(`/${resourceType}/([^/]+)$`).exec(fullUrl);
    if (absolute?.[1] !== undefined) {
      return absolute[1];
    }
  }
  const request = entry['request'];
  if (isRecord(request) && request['method'] === 'PUT' && typeof request['url'] === 'string') {
    const [type, id] = request['url'].split('/');
    return type === resourceType && id !== undefined && id !== '' ? id : undefined;
  }
  return undefined;
}

/** Practitioners, organizations and locations sent along the consultation. */
function contextResources(bundle: unknown): FhirResourceJson[] {
  if (!isRecord(bundle) || !Array.isArray(bundle['entry'])) {
    return [];
  }
  return (bundle['entry'] as unknown[]).flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry['resource'])) {
      return [];
    }
    const resourceType = entry['resource']['resourceType'];
    if (typeof resourceType !== 'string' || !CONTEXT_TYPES.has(resourceType)) {
      return [];
    }
    const id = entryId(entry, resourceType);
    return id === undefined ? [] : [{ ...(entry['resource'] as JsonObject), resourceType, id }];
  });
}

function hasErrors(outcome: OperationOutcome | undefined): boolean {
  return (outcome?.issue ?? []).some(
    (issue) => issue.severity === 'error' || issue.severity === 'fatal',
  );
}

export interface IngestionDeps {
  readonly storage: Storage;
  readonly engine: FollowUpEngine;
  readonly clock: Clock;
}

/**
 * Accepts FHIR Bundles from the host: validates and maps them (pure, in
 * `@follow-up-engine/fhir`), stores the raw resources, then runs the engine
 * per consultation batch, either now (`sync`) or through the job queue
 * (`async`, the default for the API: the host gets its answer before any LLM
 * call). Every step is idempotent, so a re-sent Bundle changes nothing.
 */
export class IngestionService {
  readonly #deps: IngestionDeps;

  constructor(deps: IngestionDeps) {
    this.#deps = deps;
  }

  async accept(clinicId: ClinicId, bundle: unknown, mode: IngestMode): Promise<BundleAcceptance> {
    const receivedAt = this.#deps.clock.now();
    const mapping = mapBundleToBatches(bundle, { clinicId, receivedAt });
    const outcome = mapping.issues;
    if (hasErrors(outcome) && mapping.batches.length === 0 && mapping.resources.length === 0) {
      return { ok: false, ...(outcome === undefined ? {} : { outcome }), stored: [], batches: 0 };
    }
    const { stored, jobId } = await this.#deps.storage.unitOfWork.withTransaction(
      clinicId,
      async (stores) => {
        const saved = await this.#store(
          stores.clinicalRecords,
          clinicId,
          mapping,
          bundle,
          receivedAt,
        );
        const job =
          mode === 'async' && mapping.batches.length > 0
            ? await stores.jobs.enqueue(clinicId, {
                type: INGEST_BUNDLE_JOB,
                payload: { bundle: bundle as JsonObject, receivedAt: receivedAt.toISOString() },
                maxAttempts: 10,
              })
            : undefined;
        return { stored: saved, jobId: job };
      },
    );
    const base = {
      ok: true,
      ...(outcome === undefined ? {} : { outcome }),
      stored,
      batches: mapping.batches.length,
    };
    if (mode === 'async') {
      return { ...base, ...(jobId === undefined ? {} : { jobId }) };
    }
    return { ...base, reports: await this.#ingestBatches(mapping.batches) };
  }

  /** Handler of {@link INGEST_BUNDLE_JOB}. Throws to be retried. */
  async processJob(clinicId: ClinicId, payload: JsonObject): Promise<readonly IngestReport[]> {
    const { bundle, receivedAt } = payload as unknown as IngestJobPayload;
    if (typeof receivedAt !== 'string' || bundle === undefined) {
      throw new ValidationError('payload', `Invalid ${INGEST_BUNDLE_JOB} payload`);
    }
    const mapping = mapBundleToBatches(bundle, { clinicId, receivedAt: new Date(receivedAt) });
    return this.#ingestBatches(mapping.batches);
  }

  async #ingestBatches(batches: readonly ClinicalBatch[]): Promise<readonly IngestReport[]> {
    const reports: IngestReport[] = [];
    for (const batch of batches) {
      reports.push(await this.#deps.engine.ingest(batch));
    }
    return reports;
  }

  async #store(
    records: Storage['stores']['clinicalRecords'],
    clinicId: ClinicId,
    mapping: BundleMappingResult,
    bundle: unknown,
    receivedAt: Date,
  ): Promise<StoredEntry[]> {
    const stored: StoredEntry[] = [];
    for (const { patientId, resource } of mapping.resources) {
      const result = await records.saveResource(clinicId, patientId, resource, receivedAt);
      stored.push({ resourceType: resource.resourceType, id: resource.id, ...result });
    }
    const owner: PatientId = mapping.resources[0]?.patientId ?? toPatientId(CLINIC_CONTEXT_OWNER);
    for (const resource of contextResources(bundle)) {
      const result = await records.saveResource(clinicId, owner, resource, receivedAt);
      stored.push({ resourceType: resource.resourceType, id: resource.id, ...result });
    }
    return stored;
  }
}
