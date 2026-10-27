import {
  type ClinicalEvent,
  type ClinicalEventQuery,
  type ClinicalRecordRepository,
  type ClinicId,
  type FhirResourceJson,
  type PatientId,
  type PatientIdPage,
  type ResourceRef,
  type SaveResourceResult,
  type StoredResource,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : nested,
  );
}

/** In-memory {@link ClinicalRecordRepository}. */
export class MemoryClinicalRecordRepository implements ClinicalRecordRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  saveResource(
    clinicId: ClinicId,
    patientId: PatientId,
    resource: FhirResourceJson,
    receivedAt: Date,
  ): Promise<SaveResourceResult> {
    const key = tenantKey(clinicId, resource.resourceType, resource.id);
    const existing = this.#db.state.resources.get(key);
    if (existing !== undefined && stableJson(existing.resource) === stableJson(resource)) {
      return Promise.resolve({ versionId: existing.versionId, changed: false });
    }
    const versionId = String(existing === undefined ? 1 : Number(existing.versionId) + 1);
    this.#db.setIn(this.#db.state.resources, key, {
      clinicId,
      patientId,
      resource: structuredClone(resource),
      versionId,
      receivedAt,
    });
    return Promise.resolve({ versionId, changed: true });
  }

  getResource(clinicId: ClinicId, ref: ResourceRef): Promise<StoredResource | undefined> {
    const stored = this.#db.state.resources.get(tenantKey(clinicId, ref.resourceType, ref.id));
    return Promise.resolve(
      stored === undefined
        ? undefined
        : {
            patientId: stored.patientId,
            resource: structuredClone(stored.resource),
            versionId: stored.versionId,
            receivedAt: stored.receivedAt,
          },
    );
  }

  appendEvents(
    clinicId: ClinicId,
    events: readonly ClinicalEvent[],
  ): Promise<{ inserted: number }> {
    const state = this.#db.state;
    if (!state.events.has(clinicId)) {
      this.#db.setIn(state.events, clinicId, []);
      this.#db.setIn(state.eventKeys, clinicId, new Set<string>());
    }
    const stored = state.events.get(clinicId) ?? [];
    const keys = state.eventKeys.get(clinicId) ?? new Set<string>();
    let inserted = 0;
    for (const event of events) {
      if (event.clinicId !== clinicId) {
        return Promise.reject(new TenantMismatchError());
      }
      if (keys.has(event.idempotencyKey)) {
        continue;
      }
      this.#db.addTo(keys, event.idempotencyKey);
      this.#db.pushTo(stored, event);
      inserted += 1;
    }
    return Promise.resolve({ inserted });
  }

  listEventsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    query: ClinicalEventQuery = {},
  ): Promise<readonly ClinicalEvent[]> {
    const events = (this.#db.state.events.get(clinicId) ?? [])
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.patientId === patientId &&
          (query.types === undefined || query.types.includes(event.type)) &&
          (query.since === undefined || event.occurredAt.getTime() >= query.since.getTime()) &&
          (query.until === undefined || event.occurredAt.getTime() < query.until.getTime()),
      )
      .sort(
        (left, right) =>
          left.event.occurredAt.getTime() - right.event.occurredAt.getTime() ||
          left.index - right.index,
      )
      .map(({ event }) => event);
    return Promise.resolve(events);
  }

  listPatientIds(
    clinicId: ClinicId,
    page: { readonly after?: PatientId; readonly limit: number },
  ): Promise<PatientIdPage> {
    const ids = [
      ...new Set((this.#db.state.events.get(clinicId) ?? []).map((event) => event.patientId)),
    ]
      .sort()
      .filter((id) => page.after === undefined || id > page.after);
    const patientIds = ids.slice(0, page.limit);
    const last = patientIds.at(-1);
    return Promise.resolve(
      ids.length > page.limit && last !== undefined ? { patientIds, next: last } : { patientIds },
    );
  }
}
