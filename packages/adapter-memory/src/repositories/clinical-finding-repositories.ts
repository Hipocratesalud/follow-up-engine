import {
  type ClinicalFinding,
  type ClinicalFindingRepository,
  type ClinicalReviewRun,
  type ClinicalReviewRunRepository,
  type ClinicId,
  ConflictError,
  type FindingCounts,
  type FindingFlag,
  type FindingFlagRepository,
  type FindingInboxRelease,
  type FindingTexts,
  type FindingListQuery,
  type FindingPage,
  type FindingReview,
  InvalidCursorError,
  NotFoundError,
  type PatientId,
  type ReviewRunStats,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

function matches(finding: ClinicalFinding, query: Partial<FindingListQuery>): boolean {
  return (
    (query.mode === undefined || finding.mode === query.mode) &&
    (query.patientId === undefined || finding.patientId === query.patientId) &&
    (query.statuses === undefined || query.statuses.includes(finding.status)) &&
    (query.categories === undefined || query.categories.includes(finding.category)) &&
    (query.severities === undefined || query.severities.includes(finding.severity)) &&
    (query.releasedSince === undefined ||
      (finding.inboxRelease !== undefined && finding.inboxRelease.at >= query.releasedSince))
  );
}

function newestFirst(left: ClinicalFinding, right: ClinicalFinding): number {
  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    (right.id < left.id ? -1 : right.id > left.id ? 1 : 0)
  );
}

function increment<TKey extends string>(record: Partial<Record<TKey, number>>, key: TKey): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** In-memory {@link ClinicalFindingRepository}. Cursors are opaque offsets. */
export class MemoryClinicalFindingRepository implements ClinicalFindingRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  #all(clinicId: ClinicId): ClinicalFinding[] {
    return [...this.#db.state.clinicalFindings.values()].filter(
      (finding) => finding.clinicId === clinicId,
    );
  }

  create(clinicId: ClinicId, finding: ClinicalFinding): Promise<void> {
    if (finding.clinicId !== clinicId) return Promise.reject(new TenantMismatchError());
    const key = tenantKey(clinicId, finding.id);
    if (this.#db.state.clinicalFindings.has(key)) {
      return Promise.reject(new ConflictError('ClinicalFinding', finding.id));
    }
    this.#db.setIn(this.#db.state.clinicalFindings, key, structuredClone(finding));
    return Promise.resolve();
  }

  get(clinicId: ClinicId, id: string): Promise<ClinicalFinding | undefined> {
    const found = this.#db.state.clinicalFindings.get(tenantKey(clinicId, id));
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  review(clinicId: ClinicId, id: string, review: FindingReview): Promise<ClinicalFinding> {
    const key = tenantKey(clinicId, id);
    const current = this.#db.state.clinicalFindings.get(key);
    if (current === undefined) return Promise.reject(new NotFoundError('ClinicalFinding', id));
    const updated: ClinicalFinding = {
      ...current,
      status: review.verdict,
      review,
      updatedAt: review.reviewedAt,
    };
    this.#db.setIn(this.#db.state.clinicalFindings, key, updated);
    return Promise.resolve(structuredClone(updated));
  }

  setTexts(clinicId: ClinicId, id: string, texts: FindingTexts): Promise<ClinicalFinding> {
    const key = tenantKey(clinicId, id);
    const current = this.#db.state.clinicalFindings.get(key);
    if (current === undefined) return Promise.reject(new NotFoundError('ClinicalFinding', id));
    const updated: ClinicalFinding = { ...current, texts: structuredClone(texts) };
    this.#db.setIn(this.#db.state.clinicalFindings, key, updated);
    return Promise.resolve(structuredClone(updated));
  }

  release(clinicId: ClinicId, id: string, release: FindingInboxRelease): Promise<void> {
    const key = tenantKey(clinicId, id);
    const current = this.#db.state.clinicalFindings.get(key);
    if (current === undefined) return Promise.reject(new NotFoundError('ClinicalFinding', id));
    this.#db.setIn(this.#db.state.clinicalFindings, key, {
      ...current,
      inboxRelease: { at: release.at, doctor: release.doctor },
    });
    return Promise.resolve();
  }

  findDuplicates(
    clinicId: ClinicId,
    patientId: PatientId,
    dedupKey: string,
    since: Date,
  ): Promise<readonly ClinicalFinding[]> {
    return Promise.resolve(
      this.#all(clinicId)
        .filter(
          (finding) =>
            finding.patientId === patientId &&
            finding.dedupKey === dedupKey &&
            (finding.status === 'open' ||
              finding.createdAt >= since ||
              (finding.review !== undefined && finding.review.reviewedAt >= since)),
        )
        .sort(newestFirst)
        .map((finding) => structuredClone(finding)),
    );
  }

  list(clinicId: ClinicId, query: FindingListQuery): Promise<FindingPage> {
    if (query.cursor !== undefined && !/^\d{1,9}$/.test(query.cursor)) {
      return Promise.reject(new InvalidCursorError());
    }
    const all = this.#all(clinicId)
      .filter((finding) => matches(finding, query))
      .sort(newestFirst);
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const items = all
      .slice(offset, offset + query.limit)
      .map((finding) => structuredClone(finding));
    const next = offset + query.limit;
    return Promise.resolve(next < all.length ? { items, nextCursor: String(next) } : { items });
  }

  counts(
    clinicId: ClinicId,
    query: Pick<FindingListQuery, 'mode' | 'patientId'>,
  ): Promise<FindingCounts> {
    const counts = {
      total: 0,
      byStatus: {} as Record<string, number>,
      byCategory: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
      byCategoryStatus: {} as Record<string, Record<string, number>>,
    };
    for (const finding of this.#all(clinicId).filter((item) => matches(item, query))) {
      counts.total += 1;
      increment(counts.byStatus, finding.status);
      increment(counts.byCategory, finding.category);
      increment(counts.bySeverity, finding.severity);
      const perStatus = (counts.byCategoryStatus[finding.category] ??= {});
      increment(perStatus, finding.status);
    }
    return Promise.resolve(counts as FindingCounts);
  }
}

/** In-memory {@link ClinicalReviewRunRepository}. */
export class MemoryClinicalReviewRunRepository implements ClinicalReviewRunRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  record(clinicId: ClinicId, run: ClinicalReviewRun): Promise<void> {
    if (run.clinicId !== clinicId) return Promise.reject(new TenantMismatchError());
    const key = tenantKey(clinicId, run.id);
    if (this.#db.state.reviewRuns.has(key)) {
      return Promise.reject(new ConflictError('ClinicalReviewRun', run.id));
    }
    this.#db.setIn(this.#db.state.reviewRuns, key, structuredClone(run));
    return Promise.resolve();
  }

  get(clinicId: ClinicId, id: string): Promise<ClinicalReviewRun | undefined> {
    const found = this.#db.state.reviewRuns.get(tenantKey(clinicId, id));
    return Promise.resolve(found === undefined ? undefined : structuredClone(found));
  }

  lastReviewedAt(clinicId: ClinicId, patientId: PatientId): Promise<Date | undefined> {
    const runs = [...this.#db.state.reviewRuns.values()].filter(
      (run) => run.clinicId === clinicId && run.patientId === patientId && run.status !== 'failed',
    );
    const latest = runs.reduce<Date | undefined>(
      (max, run) => (max === undefined || run.startedAt > max ? run.startedAt : max),
      undefined,
    );
    return Promise.resolve(latest === undefined ? undefined : new Date(latest));
  }

  stats(clinicId: ClinicId, since: Date): Promise<ReviewRunStats> {
    const runs = [...this.#db.state.reviewRuns.values()].filter(
      (run) => run.clinicId === clinicId && run.startedAt >= since,
    );
    return Promise.resolve({
      runs: runs.length,
      patientsReviewed: new Set(runs.map((run) => run.patientId)).size,
      findings: runs.reduce((total, run) => total + run.findingsCount, 0),
      discarded: runs.reduce((total, run) => total + run.discardedCount, 0),
      duplicates: runs.reduce((total, run) => total + run.duplicateCount, 0),
      degraded: runs.filter((run) => run.status === 'degraded').length,
      steps: runs.reduce((total, run) => total + run.steps, 0),
      toolCalls: runs.reduce((total, run) => total + run.toolCalls, 0),
      costUsd: runs.reduce((total, run) => total + run.costUsd, 0),
    });
  }
}

/** In-memory {@link FindingFlagRepository}, keyed by clinic, category and specialty. */
export class MemoryFindingFlagRepository implements FindingFlagRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  list(clinicId: ClinicId): Promise<readonly FindingFlag[]> {
    return Promise.resolve(
      [...this.#db.state.findingFlags.values()]
        .filter((flag) => flag.clinicId === clinicId)
        .sort(
          (left, right) =>
            left.category.localeCompare(right.category) ||
            (left.specialty ?? '').localeCompare(right.specialty ?? ''),
        )
        .map((flag) => structuredClone(flag)),
    );
  }

  upsert(clinicId: ClinicId, flag: FindingFlag): Promise<void> {
    if (flag.clinicId !== clinicId) return Promise.reject(new TenantMismatchError());
    this.#db.setIn(
      this.#db.state.findingFlags,
      tenantKey(clinicId, flag.category, flag.specialty ?? ''),
      structuredClone(flag),
    );
    return Promise.resolve();
  }
}
