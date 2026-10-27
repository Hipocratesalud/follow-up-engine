import {
  type AuditLog,
  type CaseEvent,
  type CaseFeedback,
  type CaseId,
  type ClinicId,
  type ConditionRepository,
  ConflictError,
  type FeedbackRepository,
  type PatientCondition,
  type PatientConditionStatus,
  type PatientId,
  type QualityFinding,
  type QualityFindingRepository,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

/** In-memory {@link FeedbackRepository}. */
export class MemoryFeedbackRepository implements FeedbackRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  record(clinicId: ClinicId, feedback: CaseFeedback): Promise<void> {
    if (feedback.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    if (
      this.#db.state.feedback.some((item) => item.clinicId === clinicId && item.id === feedback.id)
    ) {
      return Promise.reject(new ConflictError('CaseFeedback', feedback.id));
    }
    this.#db.state.feedback.push(feedback);
    return Promise.resolve();
  }

  listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseFeedback[]> {
    return Promise.resolve(
      this.#db.state.feedback
        .filter((item) => item.clinicId === clinicId && item.caseId === caseId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    );
  }

  listSince(clinicId: ClinicId, since: Date, limit: number): Promise<readonly CaseFeedback[]> {
    return Promise.resolve(
      this.#db.state.feedback
        .filter((item) => item.clinicId === clinicId && item.createdAt.getTime() >= since.getTime())
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .slice(0, limit),
    );
  }
}

/** In-memory {@link ConditionRepository}, unique per patient and code. */
export class MemoryConditionRepository implements ConditionRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  upsert(clinicId: ClinicId, condition: PatientCondition): Promise<void> {
    if (condition.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    this.#db.state.conditions.set(
      tenantKey(clinicId, condition.patientId, condition.code.system, condition.code.code),
      condition,
    );
    return Promise.resolve();
  }

  listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    statuses?: readonly PatientConditionStatus[],
  ): Promise<readonly PatientCondition[]> {
    return Promise.resolve(
      [...this.#db.state.conditions.values()].filter(
        (condition) =>
          condition.clinicId === clinicId &&
          condition.patientId === patientId &&
          (statuses === undefined || statuses.includes(condition.status)),
      ),
    );
  }
}

/** In-memory {@link QualityFindingRepository}, idempotent on id. */
export class MemoryQualityFindingRepository implements QualityFindingRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  save(clinicId: ClinicId, finding: QualityFinding): Promise<void> {
    if (finding.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, finding.id);
    if (!this.#db.state.findings.has(key)) {
      this.#db.state.findings.set(key, finding);
    }
    return Promise.resolve();
  }

  listByPatient(clinicId: ClinicId, patientId: PatientId): Promise<readonly QualityFinding[]> {
    return Promise.resolve(
      [...this.#db.state.findings.values()].filter(
        (finding) => finding.clinicId === clinicId && finding.patientId === patientId,
      ),
    );
  }
}

/** In-memory append-only {@link AuditLog}. */
export class MemoryAuditLog implements AuditLog {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  append(clinicId: ClinicId, event: CaseEvent): Promise<void> {
    if (event.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    this.#db.state.audit.push(event);
    return Promise.resolve();
  }

  listForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly CaseEvent[]> {
    return Promise.resolve(
      this.#db.state.audit
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.clinicId === clinicId && event.caseId === caseId)
        .sort(
          (left, right) =>
            left.event.at.getTime() - right.event.at.getTime() || left.index - right.index,
        )
        .map(({ event }) => event),
    );
  }
}
