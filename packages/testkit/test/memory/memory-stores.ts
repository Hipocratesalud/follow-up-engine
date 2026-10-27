/**
 * Throwaway in-memory implementation of every port, used only to prove the
 * contract suites run and are satisfiable. Not exported: the real memory
 * adapter lives in `@follow-up-engine/adapter-memory`.
 */
import { randomUUID } from 'node:crypto';
import {
  ACTIVE_CASE_STATUSES,
  type AuditLog,
  type CaseEvent,
  type CaseFeedback,
  type CaseRepository,
  type ClaimedJob,
  type ClinicalEvent,
  type ClinicalRecordRepository,
  type ClinicId,
  type ConditionRepository,
  ConflictError,
  type DomainEvent,
  durationToMilliseconds,
  type Expectation,
  type ExpectationRepository,
  type FeedbackRepository,
  type FhirResourceJson,
  type FollowUpCase,
  type JobId,
  jobId,
  type JobQueue,
  NotFoundError,
  type Outbox,
  type PatientCondition,
  type PatientId,
  type QualityFinding,
  type QualityFindingRepository,
  type StoredResource,
  TenantMismatchError,
  type TransactionalStores,
  type UnitOfWork,
} from '@follow-up-engine/core';
import type {
  Clinic,
  ClinicDirectory,
  LlmCallRecord,
  LlmUsageLog,
} from '../../src/contracts/shapes.ts';

interface StoredJob {
  readonly id: JobId;
  readonly clinicId: ClinicId;
  readonly type: string;
  readonly payload: ClaimedJob['payload'];
  readonly dedupKey?: string;
  readonly maxAttempts: number;
  runAt: Date;
  attempt: number;
  status: 'queued' | 'leased' | 'done' | 'dead';
  leaseToken?: string;
  leaseExpiresAt?: Date;
}

interface Data {
  expectations: Expectation[];
  cases: FollowUpCase[];
  feedback: CaseFeedback[];
  conditions: PatientCondition[];
  findings: QualityFinding[];
  audit: CaseEvent[];
  jobs: StoredJob[];
  outbox: DomainEvent[];
  resources: (StoredResource & { clinicId: ClinicId })[];
  events: ClinicalEvent[];
}

const emptyData = (): Data => ({
  expectations: [],
  cases: [],
  feedback: [],
  conditions: [],
  findings: [],
  audit: [],
  jobs: [],
  outbox: [],
  resources: [],
  events: [],
});

function sameTenant(clinicId: ClinicId, value: { readonly clinicId: ClinicId }): void {
  if (value.clinicId !== clinicId) throw new TenantMismatchError();
}

/** Runs `body`, turning a synchronous throw into a rejected promise, as a real adapter would. */
function attempt<T>(body: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(body());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

const byTime =
  <T>(get: (item: T) => Date) =>
  (x: T, y: T) =>
    get(x).getTime() - get(y).getTime();

export class MemoryDb {
  data: Data = emptyData();

  /** Runs `work` on a copy of the data and keeps it only if `work` succeeds. */
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.data);
    try {
      return await work();
    } catch (error) {
      this.data = snapshot;
      throw error;
    }
  }
}

class MemoryExpectations implements ExpectationRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  upsertByIdempotencyKey(clinicId: ClinicId, expectation: Expectation) {
    return attempt(() => {
      sameTenant(clinicId, expectation);
      const existing = this.#db.data.expectations.find(
        (e) => e.clinicId === clinicId && e.idempotencyKey === expectation.idempotencyKey,
      );
      if (existing) return Promise.resolve({ expectation: existing, created: false });
      this.#db.data.expectations.push(expectation);
      return Promise.resolve({ expectation, created: true });
    });
  }
  get(clinicId: ClinicId, id: Expectation['id']) {
    return Promise.resolve(
      this.#db.data.expectations.find((e) => e.clinicId === clinicId && e.id === id),
    );
  }
  findOpenByPatient(clinicId: ClinicId, patientId: PatientId) {
    return Promise.resolve(
      this.#db.data.expectations
        .filter((e) => e.clinicId === clinicId && e.patientId === patientId && e.status === 'open')
        .sort(byTime((e) => e.dueAt)),
    );
  }
  findDue(clinicId: ClinicId, now: Date, limit: number) {
    return Promise.resolve(
      this.#db.data.expectations
        .filter((e) => e.clinicId === clinicId && e.status === 'open' && e.dueAt <= now)
        .sort(byTime((e) => e.dueAt))
        .slice(0, limit),
    );
  }
  update(clinicId: ClinicId, expectation: Expectation) {
    return attempt(() => {
      sameTenant(clinicId, expectation);
      const list = this.#db.data.expectations;
      const index = list.findIndex((e) => e.clinicId === clinicId && e.id === expectation.id);
      if (index < 0) return Promise.reject(new NotFoundError('Expectation', expectation.id));
      list[index] = expectation;
      return Promise.resolve();
    });
  }
}

const isActive = (c: FollowUpCase) =>
  (ACTIVE_CASE_STATUSES as readonly string[]).includes(c.status);

class MemoryCases implements CaseRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  get(clinicId: ClinicId, id: FollowUpCase['id']) {
    return Promise.resolve(this.#db.data.cases.find((c) => c.clinicId === clinicId && c.id === id));
  }
  findActiveByDedupKey(clinicId: ClinicId, dedupKey: string) {
    return Promise.resolve(
      this.#db.data.cases.find(
        (c) => c.clinicId === clinicId && c.dedupKey === dedupKey && isActive(c),
      ),
    );
  }
  async create(clinicId: ClinicId, value: FollowUpCase) {
    sameTenant(clinicId, value);
    if (isActive(value) && (await this.findActiveByDedupKey(clinicId, value.dedupKey))) {
      throw new ConflictError('FollowUpCase', value.dedupKey);
    }
    this.#db.data.cases.push(value);
  }
  update(clinicId: ClinicId, value: FollowUpCase) {
    return attempt(() => {
      sameTenant(clinicId, value);
      const list = this.#db.data.cases;
      const index = list.findIndex((c) => c.clinicId === clinicId && c.id === value.id);
      if (index < 0) return Promise.reject(new NotFoundError('FollowUpCase', value.id));
      list[index] = value;
      return Promise.resolve();
    });
  }
  list(clinicId: ClinicId, query: Parameters<CaseRepository['list']>[1]) {
    const released = query.releasedAsOf;
    const items = this.#db.data.cases
      .filter(
        (c) =>
          c.clinicId === clinicId &&
          (!query.statuses || query.statuses.includes(c.status)) &&
          (!query.patientId || c.patientId === query.patientId) &&
          (!query.assignee || c.assignee === query.assignee) &&
          (!query.origin || c.origin === query.origin) &&
          (!released || !c.releaseAt || c.releaseAt <= released),
      )
      .sort(
        (x, y) =>
          y.priority - x.priority ||
          x.createdAt.getTime() - y.createdAt.getTime() ||
          x.id.localeCompare(y.id),
      );
    const offset = query.cursor ? Number(query.cursor) : 0;
    const page = items.slice(offset, offset + query.limit);
    const next = offset + query.limit;
    return Promise.resolve({
      items: page,
      ...(next < items.length ? { nextCursor: String(next) } : {}),
    });
  }
  findDueForAction(clinicId: ClinicId, now: Date, limit: number) {
    const instant = (c: FollowUpCase) => (c.status === 'snoozed' ? c.snoozedUntil : c.nextActionAt);
    return Promise.resolve(
      this.#db.data.cases
        .filter((c) => {
          const when = instant(c);
          return c.clinicId === clinicId && isActive(c) && when !== undefined && when <= now;
        })
        .sort(byTime((c) => instant(c) ?? now))
        .slice(0, limit),
    );
  }
}

class MemoryFeedback implements FeedbackRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  record(clinicId: ClinicId, feedback: CaseFeedback) {
    return attempt(() => {
      sameTenant(clinicId, feedback);
      if (this.#db.data.feedback.some((f) => f.clinicId === clinicId && f.id === feedback.id)) {
        return Promise.reject(new ConflictError('CaseFeedback', feedback.id));
      }
      this.#db.data.feedback.push(feedback);
      return Promise.resolve();
    });
  }
  listForCase(clinicId: ClinicId, caseId: CaseFeedback['caseId']) {
    return Promise.resolve(
      this.#db.data.feedback
        .filter((f) => f.clinicId === clinicId && f.caseId === caseId)
        .sort(byTime((f) => f.createdAt)),
    );
  }
  listSince(clinicId: ClinicId, since: Date, limit: number) {
    return Promise.resolve(
      this.#db.data.feedback
        .filter((f) => f.clinicId === clinicId && f.createdAt >= since)
        .sort(byTime((f) => f.createdAt))
        .slice(0, limit),
    );
  }
}

class MemoryConditions implements ConditionRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  upsert(clinicId: ClinicId, condition: PatientCondition) {
    return attempt(() => {
      sameTenant(clinicId, condition);
      const list = this.#db.data.conditions;
      const index = list.findIndex(
        (c) =>
          c.clinicId === clinicId &&
          c.patientId === condition.patientId &&
          c.code.system === condition.code.system &&
          c.code.code === condition.code.code,
      );
      if (index < 0) list.push(condition);
      else list[index] = condition;
      return Promise.resolve();
    });
  }
  listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    statuses?: readonly PatientCondition['status'][],
  ) {
    return Promise.resolve(
      this.#db.data.conditions.filter(
        (c) =>
          c.clinicId === clinicId &&
          c.patientId === patientId &&
          (!statuses || statuses.includes(c.status)),
      ),
    );
  }
}

class MemoryFindings implements QualityFindingRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  save(clinicId: ClinicId, finding: QualityFinding) {
    return attempt(() => {
      sameTenant(clinicId, finding);
      if (!this.#db.data.findings.some((f) => f.clinicId === clinicId && f.id === finding.id)) {
        this.#db.data.findings.push(finding);
      }
      return Promise.resolve();
    });
  }
  listByPatient(clinicId: ClinicId, patientId: PatientId) {
    return Promise.resolve(
      this.#db.data.findings.filter((f) => f.clinicId === clinicId && f.patientId === patientId),
    );
  }
}

class MemoryAudit implements AuditLog {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  append(clinicId: ClinicId, event: CaseEvent) {
    return attempt(() => {
      sameTenant(clinicId, event);
      this.#db.data.audit.push(event);
      return Promise.resolve();
    });
  }
  listForCase(clinicId: ClinicId, caseId: CaseEvent['caseId']) {
    return Promise.resolve(
      this.#db.data.audit
        .filter((e) => e.clinicId === clinicId && e.caseId === caseId)
        .sort(byTime((e) => e.at)),
    );
  }
}

class MemoryJobs implements JobQueue {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  enqueue(clinicId: ClinicId, job: Parameters<JobQueue['enqueue']>[1]) {
    const duplicate = job.dedupKey
      ? this.#db.data.jobs.find(
          (j) => j.clinicId === clinicId && j.type === job.type && j.dedupKey === job.dedupKey,
        )
      : undefined;
    if (duplicate) return Promise.resolve(duplicate.id);
    const id = jobId(randomUUID());
    this.#db.data.jobs.push({
      id,
      clinicId,
      type: job.type,
      payload: job.payload,
      ...(job.dedupKey ? { dedupKey: job.dedupKey } : {}),
      maxAttempts: job.maxAttempts ?? 5,
      runAt: job.runAt ?? new Date(0),
      attempt: 0,
      status: 'queued',
    });
    return Promise.resolve(id);
  }
  claim(options: Parameters<JobQueue['claim']>[0]) {
    const { now } = options;
    const leaseExpiresAt = new Date(now.getTime() + durationToMilliseconds(options.leaseFor));
    const runnable = this.#db.data.jobs
      .filter(
        (j) =>
          (!options.types || options.types.includes(j.type)) &&
          ((j.status === 'queued' && j.runAt <= now) ||
            (j.status === 'leased' && j.leaseExpiresAt !== undefined && j.leaseExpiresAt <= now)),
      )
      .sort(byTime((j) => j.runAt))
      .slice(0, options.limit);
    return Promise.resolve(
      runnable.map((job): ClaimedJob => {
        job.status = 'leased';
        job.attempt += 1;
        job.leaseToken = randomUUID();
        job.leaseExpiresAt = leaseExpiresAt;
        return {
          id: job.id,
          clinicId: job.clinicId,
          type: job.type,
          payload: job.payload,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          leaseToken: job.leaseToken,
          leaseExpiresAt,
        };
      }),
    );
  }
  #held(clinicId: ClinicId, lease: Parameters<JobQueue['complete']>[1]): StoredJob | undefined {
    return this.#db.data.jobs.find(
      (j) =>
        j.clinicId === clinicId &&
        j.id === lease.id &&
        j.status === 'leased' &&
        j.leaseToken === lease.leaseToken,
    );
  }
  complete(clinicId: ClinicId, lease: Parameters<JobQueue['complete']>[1]) {
    const job = this.#held(clinicId, lease);
    if (!job) return Promise.resolve('lease_lost' as const);
    job.status = 'done';
    return Promise.resolve('acknowledged' as const);
  }
  fail(
    clinicId: ClinicId,
    lease: Parameters<JobQueue['fail']>[1],
    failure: Parameters<JobQueue['fail']>[2],
  ) {
    const job = this.#held(clinicId, lease);
    if (!job) return Promise.resolve('lease_lost' as const);
    if (job.attempt >= job.maxAttempts) {
      job.status = 'dead';
    } else {
      job.status = 'queued';
      job.runAt = failure.retryAt ?? job.leaseExpiresAt ?? job.runAt;
    }
    return Promise.resolve('acknowledged' as const);
  }
}

class MemoryOutbox implements Outbox {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  add(clinicId: ClinicId, event: DomainEvent) {
    return attempt(() => {
      sameTenant(clinicId, event);
      this.#db.data.outbox.push(event);
      return Promise.resolve();
    });
  }
  pending(clinicId: ClinicId): Promise<readonly DomainEvent[]> {
    return Promise.resolve(this.#db.data.outbox.filter((e) => e.clinicId === clinicId));
  }
}

class MemoryClinicalRecords implements ClinicalRecordRepository {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  saveResource(
    clinicId: ClinicId,
    patientId: PatientId,
    resource: FhirResourceJson,
    receivedAt: Date,
  ) {
    const list = this.#db.data.resources;
    const index = list.findIndex(
      (r) =>
        r.clinicId === clinicId &&
        r.resource.resourceType === resource.resourceType &&
        r.resource.id === resource.id,
    );
    const existing = list[index];
    if (existing && JSON.stringify(existing.resource) === JSON.stringify(resource)) {
      return Promise.resolve({ versionId: existing.versionId, changed: false });
    }
    const versionId = String(existing ? Number(existing.versionId) + 1 : 1);
    const stored = { clinicId, patientId, resource, versionId, receivedAt };
    if (existing) list[index] = stored;
    else list.push(stored);
    return Promise.resolve({ versionId, changed: true });
  }
  getResource(clinicId: ClinicId, ref: { readonly resourceType: string; readonly id: string }) {
    const found = this.#db.data.resources.find(
      (r) =>
        r.clinicId === clinicId &&
        r.resource.resourceType === ref.resourceType &&
        r.resource.id === ref.id,
    );
    if (!found) return Promise.resolve(undefined);
    return Promise.resolve({
      patientId: found.patientId,
      resource: found.resource,
      versionId: found.versionId,
      receivedAt: found.receivedAt,
    });
  }
  appendEvents(clinicId: ClinicId, events: readonly ClinicalEvent[]) {
    return attempt(() => {
      let inserted = 0;
      for (const event of events) {
        sameTenant(clinicId, event);
        if (
          this.#db.data.events.some(
            (e) => e.clinicId === clinicId && e.idempotencyKey === event.idempotencyKey,
          )
        )
          continue;
        this.#db.data.events.push(event);
        inserted += 1;
      }
      return Promise.resolve({ inserted });
    });
  }
  listEventsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    query: Parameters<ClinicalRecordRepository['listEventsForPatient']>[2] = {},
  ) {
    return Promise.resolve(
      this.#db.data.events
        .filter(
          (e) =>
            e.clinicId === clinicId &&
            e.patientId === patientId &&
            (!query.types || query.types.includes(e.type)) &&
            (!query.since || e.occurredAt >= query.since) &&
            (!query.until || e.occurredAt < query.until),
        )
        .sort(byTime((e) => e.occurredAt)),
    );
  }
  listPatientIds(clinicId: ClinicId, page: { readonly after?: PatientId; readonly limit: number }) {
    const ids = [
      ...new Set(
        this.#db.data.events.filter((e) => e.clinicId === clinicId).map((e) => e.patientId),
      ),
    ]
      .sort()
      .filter((id) => !page.after || id > page.after);
    const patientIds = ids.slice(0, page.limit);
    const last = patientIds[patientIds.length - 1];
    return Promise.resolve({
      patientIds,
      ...(ids.length > page.limit && last ? { next: last } : {}),
    });
  }
}

export function memoryStores(
  db: MemoryDb,
): TransactionalStores & { readonly outbox: MemoryOutbox } {
  return {
    clinicalRecords: new MemoryClinicalRecords(db),
    expectations: new MemoryExpectations(db),
    cases: new MemoryCases(db),
    feedback: new MemoryFeedback(db),
    conditions: new MemoryConditions(db),
    qualityFindings: new MemoryFindings(db),
    audit: new MemoryAudit(db),
    jobs: new MemoryJobs(db),
    outbox: new MemoryOutbox(db),
  };
}

class MemoryUnitOfWork implements UnitOfWork {
  readonly #db: MemoryDb;
  constructor(db: MemoryDb) {
    this.#db = db;
  }
  withTransaction<TResult>(
    _clinicId: ClinicId,
    work: (stores: TransactionalStores) => Promise<TResult>,
  ) {
    return this.#db.transaction(() => work(memoryStores(this.#db)));
  }
}

class MemoryClinicDirectory implements ClinicDirectory {
  readonly #clinics: readonly { readonly clinic: Clinic; readonly apiKeyHash: string }[];
  constructor(clinics: readonly { readonly clinic: Clinic; readonly apiKeyHash: string }[]) {
    this.#clinics = clinics;
  }
  listActive() {
    return Promise.resolve(this.#clinics.map((c) => c.clinic).filter((c) => c.active));
  }
  get(clinicId: ClinicId) {
    return Promise.resolve(this.#clinics.find((c) => c.clinic.id === clinicId)?.clinic);
  }
  findByApiKeyHash(apiKeyHash: string) {
    return Promise.resolve(this.#clinics.find((c) => c.apiKeyHash === apiKeyHash)?.clinic);
  }
}

class MemoryLlmUsageLog implements LlmUsageLog {
  readonly #calls: LlmCallRecord[] = [];
  record(call: LlmCallRecord) {
    this.#calls.push(call);
    return Promise.resolve();
  }
  totalCostUsd(clinicId: ClinicId, since: Date) {
    return Promise.resolve(
      this.#calls
        .filter((c) => c.clinicId === clinicId && c.at >= since)
        .reduce((sum, c) => sum + c.costUsd, 0),
    );
  }
}

export function memoryUnitOfWork(db: MemoryDb): UnitOfWork {
  return new MemoryUnitOfWork(db);
}

export function memoryClinicDirectory(
  clinics: readonly { readonly clinic: Clinic; readonly apiKeyHash: string }[],
): ClinicDirectory {
  return new MemoryClinicDirectory(clinics);
}

export function memoryLlmUsageLog(): LlmUsageLog {
  return new MemoryLlmUsageLog();
}
