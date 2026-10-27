import {
  type ClinicalBatch,
  type ClinicId,
  type Clock,
  type CommunicationRecordResult,
  contactRequestId,
  type FhirResourceJson,
  type FollowUpEngine,
  type IngestReport,
  isOlderResourceVersion,
  type JobId,
  type JsonObject,
  NotFoundError,
  type PatientId,
  patientId as toPatientId,
  ValidationError,
} from '@follow-up-engine/core';
import {
  type BundleCommunication,
  type BundleMappingResult,
  mapBundleToBatches,
  type MappingIssue,
  type OperationOutcome,
  type OperationOutcomeIssue,
  toOperationOutcome,
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
  /** An older version than the stored one: not stored, its events not ingested. */
  readonly stale?: boolean;
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
  /** Synchronous mode: the contact outcomes (`Communication`s) recorded. */
  readonly contactOutcomes?: readonly CommunicationRecordResult[];
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

/**
 * Whether the whole Bundle is refused: an invalid envelope, or a
 * transaction with errors. A batch is answered entry by entry, so a batch
 * whose every entry failed still gets its batch-response.
 */
function rejected(mapping: BundleMappingResult): boolean {
  if (!hasErrors(mapping.issues) || mapping.batches.length > 0 || mapping.resources.length > 0) {
    return false;
  }
  return mapping.bundleType !== 'batch' || mapping.entryRefs.length === 0;
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
    const mapping = await this.#checkCommunications(
      clinicId,
      mapBundleToBatches(bundle, { clinicId, receivedAt, checkFutureDates: true }),
    );
    const outcome = mapping.issues;
    if (rejected(mapping)) {
      return {
        ok: false,
        ...(outcome === undefined ? {} : { outcome }),
        stored: [],
        entries: [],
        batches: 0,
      };
    }
    const contactDataChanged: PatientId[] = [];
    const { stored, jobId } = await this.#deps.storage.unitOfWork.withTransaction(
      clinicId,
      async (stores) => {
        const saved = await this.#store(
          stores.clinicalRecords,
          clinicId,
          mapping,
          receivedAt,
          contactDataChanged,
        );
        const job =
          mode === 'async' && (mapping.batches.length > 0 || mapping.communications.length > 0)
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
    // The host corrected the patient's phone or e-mail: a wrong-number flag
    // no longer stands, messages may go out again.
    for (const patientId of contactDataChanged) {
      await this.#deps.engine.contacts.contactDataUpdated(clinicId, patientId);
    }
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
    const reports = await this.#ingestBatches(await this.#current(clinicId, mapping));
    return {
      ...base,
      reports,
      contactOutcomes: await this.#recordCommunications(clinicId, mapping.communications),
    };
  }

  /**
   * Checks every `Communication` against the clinic's contact attempts: its
   * `basedOn` must be a `CommunicationRequest` of this clinic (another
   * clinic's is as unknown as a made-up one) about the same patient. A
   * failing entry is an error like any mapping error: a transaction is
   * rejected whole, a batch answers that entry with its `OperationOutcome`
   * and stores nothing of it.
   */
  async #checkCommunications(
    clinicId: ClinicId,
    mapping: BundleMappingResult,
  ): Promise<BundleMappingResult> {
    if (mapping.communications.length === 0) {
      return mapping;
    }
    const failures = await this.#deps.storage.unitOfWork.withTransaction(
      clinicId,
      async (stores) => {
        const found: { readonly item: BundleCommunication; readonly issue: MappingIssue }[] = [];
        for (const item of mapping.communications) {
          const { communication } = item;
          const request = await stores.contacts.getRequest(
            clinicId,
            contactRequestId(communication.requestId),
          );
          if (request === undefined) {
            found.push({
              item,
              issue: {
                severity: 'error',
                code: 'not-found',
                message: `CommunicationRequest/${communication.requestId} is not a contact request of this clinic`,
                expression: `${item.expression}.basedOn`,
              },
            });
          } else if (request.patientId !== communication.patientId) {
            found.push({
              item,
              issue: {
                severity: 'error',
                code: 'value',
                message: `subject must be the patient of CommunicationRequest/${communication.requestId}`,
                expression: `${item.expression}.subject`,
              },
            });
          }
        }
        return found;
      },
    );
    if (failures.length === 0) {
      return mapping;
    }
    const issues = [...(mapping.issues?.issue ?? []), ...toIssues(failures.map((f) => f.issue))];
    if (mapping.bundleType !== 'batch') {
      const rejection = toIssues([
        {
          severity: 'error',
          code: 'processing',
          message: 'transaction rejected: fix the errors above; nothing was processed',
          expression: 'Bundle',
        },
      ]);
      return {
        ...mapping,
        batches: [],
        communications: [],
        resources: [],
        contextResources: [],
        issues: { resourceType: 'OperationOutcome', issue: [...issues, ...rejection] },
      };
    }
    const failed = new Set(failures.map(({ item }) => item.communication.id));
    return {
      ...mapping,
      communications: mapping.communications.filter(
        ({ communication }) => !failed.has(communication.id),
      ),
      resources: mapping.resources.filter(
        ({ resource }) => !(resource.resourceType === 'Communication' && failed.has(resource.id)),
      ),
      issues: { resourceType: 'OperationOutcome', issue: issues },
    };
  }

  /**
   * Records the contact outcomes of a Bundle on their attempts, after its
   * clinical events (an Appointment sent with a "booked" outcome is in the
   * record first). An attempt that is not the clinic's was refused when the
   * Bundle was accepted; one found missing now (a batch entry re-mapped by
   * the job) is skipped, not retried.
   */
  async #recordCommunications(
    clinicId: ClinicId,
    communications: readonly BundleCommunication[],
  ): Promise<CommunicationRecordResult[]> {
    const recorded: CommunicationRecordResult[] = [];
    for (const { communication } of communications) {
      try {
        recorded.push(
          await this.#deps.engine.contacts.recordCommunication(clinicId, {
            id: communication.id,
            requestId: contactRequestId(communication.requestId),
            patientId: toPatientId(communication.patientId),
            status: communication.status,
            ...(communication.channel === undefined ? {} : { channel: communication.channel }),
            ...(communication.outcome === undefined ? {} : { outcome: communication.outcome }),
            ...(communication.sentAt === undefined ? {} : { sentAt: communication.sentAt }),
            ...(communication.receivedAt === undefined
              ? {}
              : { receivedAt: communication.receivedAt }),
            ...(communication.versionId === undefined
              ? {}
              : { versionId: communication.versionId }),
            ...(communication.lastUpdated === undefined
              ? {}
              : { lastUpdated: communication.lastUpdated }),
            sender: { type: 'host' },
          }),
        );
      } catch (error) {
        if (!(error instanceof NotFoundError) && !(error instanceof ValidationError)) {
          throw error;
        }
      }
    }
    return recorded;
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
    const reports = await this.#ingestBatches(await this.#current(clinicId, mapping));
    await this.#recordCommunications(clinicId, mapping.communications);
    return reports;
  }

  /**
   * The batches without the events of resources older than the version
   * stored (delivery is at least once and may reorder: a late older version
   * must not undo a newer one).
   */
  async #current(
    clinicId: ClinicId,
    mapping: BundleMappingResult,
  ): Promise<readonly ClinicalBatch[]> {
    const stale = await this.#deps.storage.unitOfWork.withTransaction(clinicId, async (stores) => {
      const keys = new Set<string>();
      for (const { resource } of mapping.resources) {
        const stored = await stores.clinicalRecords.getResource(clinicId, resource);
        if (stored !== undefined && isOlderResourceVersion(resource, stored.resource)) {
          keys.add(`${resource.resourceType}/${resource.id}`);
        }
      }
      return keys;
    });
    if (stale.size === 0) {
      return mapping.batches;
    }
    return mapping.batches
      .map((batch) => ({
        ...batch,
        events: batch.events.filter(
          (event) => !stale.has(`${event.source.resourceType}/${event.source.id}`),
        ),
      }))
      .filter((batch) => batch.events.length > 0);
  }

  async #ingestBatches(batches: readonly ClinicalBatch[]): Promise<readonly IngestReport[]> {
    const reports: IngestReport[] = [];
    for (const batch of batches) {
      reports.push(await this.#deps.engine.ingest(batch));
    }
    return reports;
  }

  /**
   * Stores the Bundle's resources. `contactDataChanged` collects the
   * patients whose contact points (`Patient.telecom`) the host changed.
   */
  async #store(
    records: Storage['stores']['clinicalRecords'],
    clinicId: ClinicId,
    mapping: BundleMappingResult,
    receivedAt: Date,
    contactDataChanged: PatientId[] = [],
  ): Promise<StoredEntry[]> {
    const stored: StoredEntry[] = [];
    for (const { patientId, resource } of mapping.resources) {
      const previous =
        resource.resourceType === 'Patient'
          ? await records.getResource(clinicId, resource)
          : undefined;
      const result = await records.saveResource(clinicId, patientId, resource, receivedAt);
      stored.push({ resourceType: resource.resourceType, id: resource.id, ...result });
      if (
        previous !== undefined &&
        result.changed &&
        telecomOf(previous.resource) !== telecomOf(resource)
      ) {
        contactDataChanged.push(patientId);
      }
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

/** The patient's contact points (`Patient.telecom`), compared as JSON. */
function telecomOf(resource: FhirResourceJson): string {
  return JSON.stringify(resource['telecom'] ?? null);
}

function toIssues(issues: readonly MappingIssue[]): OperationOutcomeIssue[] {
  return toOperationOutcome(issues)?.issue ?? [];
}
