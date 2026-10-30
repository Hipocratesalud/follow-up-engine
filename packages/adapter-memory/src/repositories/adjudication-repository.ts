import {
  type Adjudication,
  type AdjudicationListQuery,
  type AdjudicationOverride,
  type AdjudicationRepository,
  type ClinicId,
  ConflictError,
  type ExpectationId,
  NotFoundError,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** In-memory {@link AdjudicationRepository}: one decision per expectation. */
export class MemoryAdjudicationRepository implements AdjudicationRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  create(clinicId: ClinicId, adjudication: Adjudication): Promise<void> {
    if (adjudication.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const all = this.#all(clinicId);
    if (all.some((item) => item.id === adjudication.id)) {
      return Promise.reject(new ConflictError('Adjudication', adjudication.id));
    }
    if (all.some((item) => item.expectationId === adjudication.expectationId)) {
      return Promise.reject(new ConflictError('Adjudication', adjudication.expectationId));
    }
    this.#db.setIn(
      this.#db.state.adjudications,
      tenantKey(clinicId, adjudication.id),
      adjudication,
    );
    return Promise.resolve();
  }

  get(clinicId: ClinicId, id: string): Promise<Adjudication | undefined> {
    return Promise.resolve(this.#db.state.adjudications.get(tenantKey(clinicId, id)));
  }

  forExpectation(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<Adjudication | undefined> {
    return Promise.resolve(
      this.#all(clinicId).find((item) => item.expectationId === expectationId),
    );
  }

  list(clinicId: ClinicId, query: AdjudicationListQuery = {}): Promise<readonly Adjudication[]> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));
    const expectationIds =
      query.expectationIds === undefined ? undefined : new Set<string>(query.expectationIds);
    return Promise.resolve(
      this.#all(clinicId)
        .filter(
          (item) =>
            (query.patientId === undefined || item.patientId === query.patientId) &&
            (expectationIds === undefined || expectationIds.has(item.expectationId)) &&
            (query.decisions === undefined || query.decisions.includes(item.decision)),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        )
        .slice(0, limit),
    );
  }

  setOverride(
    clinicId: ClinicId,
    id: string,
    override: AdjudicationOverride,
  ): Promise<Adjudication> {
    const key = tenantKey(clinicId, id);
    const current = this.#db.state.adjudications.get(key);
    if (current === undefined) {
      return Promise.reject(new NotFoundError('Adjudication', id));
    }
    const next: Adjudication = { ...current, override };
    this.#db.setIn(this.#db.state.adjudications, key, next);
    return Promise.resolve(next);
  }

  #all(clinicId: ClinicId): Adjudication[] {
    return [...this.#db.state.adjudications.values()].filter((item) => item.clinicId === clinicId);
  }
}
