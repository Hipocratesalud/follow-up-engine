import {
  type ClinicalBatch,
  type ClinicId,
  type Clock,
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
  type OperationOutcomeIssue,
} from '@follow-up-engine/fhir';
import type { Storage } from './storage.ts';

/** Job that runs the engine over an accepted Bundle (asynchronous ingestion). */
export const INGEST_BUNDLE_JOB = 'fhir.ingest_bundle';

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

/** What happened to one request entry of an accepted Bundle, by position. */
export interface EntryResult {
  /** The resource the entry carried, when it could be identified. */
  readonly ref?: { readonly resourceType: string; readonly id: string };
  /** Present when the resource was stored (new, changed or unchanged). */
  readonly stored?: StoredEntry;
  /** The issues that point at this entry (`Bundle.entry[i]...`). */
  readonly issues: readonly OperationOutcomeIssue[];
}

export interface BundleAcceptance {
  /** False when the Bundle was rejected; nothing was stored. */
  readonly ok: boolean;
  /** Errors when rejected; warnings and notes otherwise. */
  readonly outcome?: OperationOutcome;
  readonly stored: readonly StoredEntry[];
  /** One result per request entry, in request order (empty when rejected). */
  readonly entries: readonly EntryResult[];
  readonly batches: number;
  /** Asynchronous mode: the job that will run the engine. */
  readonly jobId?: JobId;
  /** Synchronous mode: what the engine did with each batch. */
  readonly reports?: readonly IngestReport[];
}

/** What {@link IngestionService.stageHistory} did with a historical Bundle. */
export interface HistoryStaging {
  /** False when the Bundle was rejected; nothing was stored. */
  readonly ok: boolean;
  readonly outcome?: OperationOutcome;
  /** Resources stored (new or unchanged). */
  readonly stored: number;
  /** Clinical events staged for the backfill (new ones only). */
  readonly staged: number;
}

interface IngestJobPayload {
  readonly bundle: unknown;
  readonly receivedAt: string;
}

/** Position of the request entry an issue points at; `undefined` for Bundle-level issues. */
function entryIndexOf(issue: OperationOutcomeIssue): number | undefined {
  const position = /^Bundle\.entry\[(\d+)\]/.exec(issue.expression?.[0] ?? '')?.[1];
  return position === undefined ? undefined : Number(position);
}

function entryResults(mapping: BundleMappingResult, stored: readonly StoredEntry[]): EntryResult[] {
  const issues = mapping.issues?.issue ?? [];
  return mapping.entryRefs.map((ref, position) => {
    const saved =
      ref === undefined
        ? undefined
        : stored.find((entry) => entry.resourceType === ref.resourceType && entry.id === ref.id);
    return {
      ...(ref === undefined ? {} : { ref: { resourceType: ref.resourceType, id: ref.id } }),
      ...(saved === undefined ? {} : { stored: saved }),
      issues: issues.filter((issue) => entryIndexOf(issue) === position),
    };
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
    const mapping = mapBundleToBatches(bundle, { clinicId, receivedAt, checkFutureDates: true });
    const outcome = mapping.issues;
    if (hasErrors(outcome) && mapping.batches.length === 0 && mapping.resources.length === 0) {
      return {
        ok: false,
        ...(outcome === undefined ? {} : { outcome }),
        stored: [],
        entries: [],
        batches: 0,
      };
    }
    const { stored, jobId } = await this.#deps.storage.unitOfWork.withTransaction(
      clinicId,
      async (stores) => {
        const saved = await this.#store(stores.clinicalRecords, clinicId, mapping, receivedAt);
        const job =
          mode === 'async' && mapping.batches.length > 0
            ? await stores.jobs.enqueue(clinicId, {
                type: INGEST_BUNDLE_JOB,
                // The Bundle as mapped: control characters already removed.
                payload: {
                  bundle: mapping.bundle as JsonObject,
                  receivedAt: receivedAt.toISOString(),
                },
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
      entries: entryResults(mapping, stored),
      batches: mapping.batches.length,
    };
    if (mode === 'async') {
      return { ...base, ...(jobId === undefined ? {} : { jobId }) };
    }
    return { ...base, reports: await this.#ingestBatches(mapping.batches) };
  }

  /**
   * Initial backfill import of one historical Bundle: stores its resources
   * (patients, practitioners, ...) and stages its clinical events with
   * `engine.backfill.stage`, without annotating them. A later
   * `engine.backfill.run` replays the clinic's history patient by patient.
   * `receivedAt` is when the host originally recorded the Bundle.
   * Idempotent: staging the same history twice changes nothing.
   */
  async stageHistory(
    clinicId: ClinicId,
    bundle: unknown,
    receivedAt: Date,
  ): Promise<HistoryStaging> {
    const mapping = mapBundleToBatches(bundle, { clinicId, receivedAt });
    const outcome = mapping.issues;
    if (hasErrors(outcome) && mapping.batches.length === 0 && mapping.resources.length === 0) {
      return { ok: false, ...(outcome === undefined ? {} : { outcome }), stored: 0, staged: 0 };
    }
    const stored = await this.#deps.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      this.#store(stores.clinicalRecords, clinicId, mapping, receivedAt),
    );
    let staged = 0;
    for (const batch of mapping.batches) {
      staged += (await this.#deps.engine.backfill.stage(batch)).inserted;
    }
    return {
      ok: true,
      ...(outcome === undefined ? {} : { outcome }),
      stored: stored.length,
      staged,
    };
  }

  /** Handler of {@link INGEST_BUNDLE_JOB}. Throws to be retried. */
  async processJob(clinicId: ClinicId, payload: JsonObject): Promise<readonly IngestReport[]> {
    const { bundle, receivedAt } = payload as unknown as IngestJobPayload;
    if (typeof receivedAt !== 'string' || bundle === undefined) {
      throw new ValidationError('payload', `Invalid ${INGEST_BUNDLE_JOB} payload`);
    }
    // Mapped exactly as when it was accepted, so the same entries count.
    const mapping = mapBundleToBatches(bundle, {
      clinicId,
      receivedAt: new Date(receivedAt),
      checkFutureDates: true,
    });
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
    receivedAt: Date,
  ): Promise<StoredEntry[]> {
    const stored: StoredEntry[] = [];
    for (const { patientId, resource } of mapping.resources) {
      const result = await records.saveResource(clinicId, patientId, resource, receivedAt);
      stored.push({ resourceType: resource.resourceType, id: resource.id, ...result });
    }
    // Practitioners, organizations and locations sent along the consultation
    // (the inbox names each case's treating practitioner with them).
    const owner: PatientId = mapping.resources[0]?.patientId ?? toPatientId(CLINIC_CONTEXT_OWNER);
    for (const resource of mapping.contextResources) {
      const result = await records.saveResource(clinicId, owner, resource, receivedAt);
      stored.push({ resourceType: resource.resourceType, id: resource.id, ...result });
    }
    return stored;
  }
}
