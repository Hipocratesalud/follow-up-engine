import {
  ACTIVE_CASE_STATUSES,
  type CaseCount,
  type CaseFilter,
  type CaseId,
  type CaseListQuery,
  type CasePage,
  type CaseRepository,
  type CaseStatus,
  type ClinicId,
  ConflictError,
  InvalidCursorError,
  type FollowUpCase,
  NotFoundError,
  type PatientCasePage,
  type PatientCases,
  type PatientQueueQuery,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

const ACTIVE: readonly CaseStatus[] = ACTIVE_CASE_STATUSES;

function isActive(followUpCase: FollowUpCase): boolean {
  return ACTIVE.includes(followUpCase.status);
}

/** When the worker must next look at a case, or `undefined` if never. */
function actionInstant(followUpCase: FollowUpCase): number | undefined {
  if (followUpCase.status === 'snoozed' && followUpCase.snoozedUntil !== undefined) {
    return followUpCase.snoozedUntil.getTime();
  }
  return followUpCase.nextActionAt?.getTime();
}

function comparator(
  orderBy: CaseListQuery['orderBy'],
): (a: FollowUpCase, b: FollowUpCase) => number {
  switch (orderBy) {
    case 'created_at':
      return (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
    case 'next_action_at':
      return (a, b) =>
        (a.nextActionAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.nextActionAt?.getTime() ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id);
    case 'priority':
    case undefined:
      return (a, b) =>
        b.priority - a.priority ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id);
  }
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d{1,9}$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  return Number(cursor);
}

function oldest(cases: readonly FollowUpCase[]): number {
  return Math.min(...cases.map((followUpCase) => followUpCase.createdAt.getTime()));
}

/** Patient order of the queue, the same as the Postgres adapter's keyset order. */
function patientComparator(
  orderBy: PatientQueueQuery['orderBy'],
): (a: PatientCases, b: PatientCases) => number {
  const byId = (a: PatientCases, b: PatientCases): number =>
    a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
  if (orderBy === 'created_at') {
    return (a, b) => oldest(a.cases) - oldest(b.cases) || byId(a, b);
  }
  const top = (item: PatientCases): number =>
    Math.max(...item.cases.map((followUpCase) => followUpCase.priority));
  return (a, b) => top(b) - top(a) || oldest(a.cases) - oldest(b.cases) || byId(a, b);
}

/** In-memory {@link CaseRepository}. Cursors are opaque offsets. */
export class MemoryCaseRepository implements CaseRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  // Transactions are serialized: a read is always the latest, no lock needed.
  get(clinicId: ClinicId, id: CaseId): Promise<FollowUpCase | undefined> {
    return Promise.resolve(this.#db.state.cases.get(tenantKey(clinicId, id)));
  }

  findActiveByDedupKey(clinicId: ClinicId, dedupKey: string): Promise<FollowUpCase | undefined> {
    return Promise.resolve(
      this.#all(clinicId).find(
        (followUpCase) => followUpCase.dedupKey === dedupKey && isActive(followUpCase),
      ),
    );
  }

  create(clinicId: ClinicId, value: FollowUpCase): Promise<void> {
    if (value.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const clash = this.#all(clinicId).some(
      (followUpCase) =>
        followUpCase.id === value.id ||
        (isActive(value) && isActive(followUpCase) && followUpCase.dedupKey === value.dedupKey),
    );
    if (clash) {
      return Promise.reject(new ConflictError('FollowUpCase', value.dedupKey));
    }
    this.#db.setIn(this.#db.state.cases, tenantKey(clinicId, value.id), value);
    return Promise.resolve();
  }

  update(clinicId: ClinicId, value: FollowUpCase): Promise<void> {
    if (value.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, value.id);
    if (!this.#db.state.cases.has(key)) {
      return Promise.reject(new NotFoundError('FollowUpCase', value.id));
    }
    this.#db.setIn(this.#db.state.cases, key, value);
    return Promise.resolve();
  }

  setPriority(clinicId: ClinicId, id: CaseId, priority: number): Promise<boolean> {
    const key = tenantKey(clinicId, id);
    const stored = this.#db.state.cases.get(key);
    if (stored === undefined || !isActive(stored)) {
      return Promise.resolve(false);
    }
    this.#db.setIn(this.#db.state.cases, key, { ...stored, priority });
    return Promise.resolve(true);
  }

  list(clinicId: ClinicId, query: CaseListQuery): Promise<CasePage> {
    const matching = this.#matching(clinicId, {
      ...query,
      ...(query.patientId === undefined ? {} : { patientIds: [query.patientId] }),
    }).sort(comparator(query.orderBy));
    const offset = parseOffset(query.cursor);
    const items = matching.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return Promise.resolve(
      next < matching.length ? { items, nextCursor: String(next) } : { items },
    );
  }

  listPatients(clinicId: ClinicId, query: PatientQueueQuery): Promise<PatientCasePage> {
    try {
      return Promise.resolve(this.#patientPage(clinicId, query));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #patientPage(clinicId: ClinicId, query: PatientQueueQuery): PatientCasePage {
    const order = query.orderBy ?? 'priority';
    const byPatient = new Map<string, FollowUpCase[]>();
    for (const followUpCase of this.#matching(clinicId, query).sort(comparator(order))) {
      const cases = byPatient.get(followUpCase.patientId) ?? [];
      cases.push(followUpCase);
      byPatient.set(followUpCase.patientId, cases);
    }
    const patients: PatientCases[] = [...byPatient.values()].map((cases) => ({
      patientId: cases[0]?.patientId ?? ('' as FollowUpCase['patientId']),
      cases,
    }));
    patients.sort(patientComparator(order));
    const offset = parseOffset(query.cursor);
    const items = patients.slice(offset, offset + query.limit);
    const next = offset + items.length;
    return next < patients.length ? { items, nextCursor: String(next) } : { items };
  }

  count(clinicId: ClinicId, filter: CaseFilter): Promise<CaseCount> {
    const matching = this.#matching(clinicId, filter);
    return Promise.resolve({
      cases: matching.length,
      patients: new Set(matching.map((followUpCase) => followUpCase.patientId)).size,
    });
  }

  #matching(clinicId: ClinicId, query: CaseFilter): FollowUpCase[] {
    const patientIds = query.patientIds === undefined ? undefined : new Set(query.patientIds);
    return this.#all(clinicId).filter(
      (followUpCase) =>
        (query.statuses === undefined || query.statuses.includes(followUpCase.status)) &&
        (patientIds === undefined || patientIds.has(followUpCase.patientId)) &&
        (query.assignee === undefined || followUpCase.assignee === query.assignee) &&
        (query.origin === undefined || followUpCase.origin === query.origin) &&
        (query.releasedAsOf === undefined ||
          followUpCase.releaseAt === undefined ||
          followUpCase.releaseAt.getTime() <= query.releasedAsOf.getTime()) &&
        (query.unreleasedAsOf === undefined ||
          (followUpCase.releaseAt !== undefined &&
            followUpCase.releaseAt.getTime() > query.unreleasedAsOf.getTime())),
    );
  }

  findDueForAction(clinicId: ClinicId, now: Date, limit: number): Promise<readonly FollowUpCase[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter((followUpCase) => {
          const at = actionInstant(followUpCase);
          return isActive(followUpCase) && at !== undefined && at <= now.getTime();
        })
        .sort((a, b) => (actionInstant(a) ?? 0) - (actionInstant(b) ?? 0))
        .slice(0, limit),
    );
  }

  #all(clinicId: ClinicId): FollowUpCase[] {
    return [...this.#db.state.cases.values()].filter(
      (followUpCase) => followUpCase.clinicId === clinicId,
    );
  }
}
