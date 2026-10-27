import {
  type CaseId,
  type ClinicId,
  compareCommunicationVersions,
  ConflictError,
  type ContactCommunication,
  type ContactRepository,
  type ContactRequest,
  type ContactRequestId,
  isActiveSuppression,
  type PatientContactFlag,
  type PatientId,
  type RuleSuppression,
  type SaveCommunicationResult,
  type SuppressionId,
  type SuppressionRepository,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

function byRequestedAt(left: ContactRequest, right: ContactRequest): number {
  return (
    left.requestedAt.getTime() - right.requestedAt.getTime() || left.id.localeCompare(right.id)
  );
}

function byRecordedAt(left: ContactCommunication, right: ContactCommunication): number {
  return left.recordedAt.getTime() - right.recordedAt.getTime() || left.id.localeCompare(right.id);
}

/** In-memory {@link ContactRepository}. */
export class MemoryContactRepository implements ContactRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  createRequest(clinicId: ClinicId, request: ContactRequest): Promise<void> {
    if (request.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, request.id);
    if (this.#db.state.contactRequests.has(key)) {
      return Promise.reject(new ConflictError('ContactRequest', request.id));
    }
    this.#db.setIn(this.#db.state.contactRequests, key, request);
    return Promise.resolve();
  }

  // Transactions are serialized: a read is always the latest, no lock needed.
  getRequest(clinicId: ClinicId, id: ContactRequestId): Promise<ContactRequest | undefined> {
    return Promise.resolve(this.#db.state.contactRequests.get(tenantKey(clinicId, id)));
  }

  listRequestsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactRequest[]> {
    return Promise.resolve(
      this.#requests(clinicId).filter((request) => request.patientId === patientId),
    );
  }

  listRequestsForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly ContactRequest[]> {
    return Promise.resolve(this.#requests(clinicId).filter((request) => request.caseId === caseId));
  }

  saveCommunication(
    clinicId: ClinicId,
    communication: ContactCommunication,
  ): Promise<SaveCommunicationResult> {
    if (communication.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, communication.id);
    const stored = this.#db.state.communications.get(key);
    if (stored !== undefined) {
      const order = compareCommunicationVersions(communication, stored);
      if (order <= 0) {
        return Promise.resolve({
          communication: stored,
          changed: false,
          stale: order < 0,
          previous: stored,
        });
      }
    }
    this.#db.setIn(this.#db.state.communications, key, communication);
    return Promise.resolve({
      communication,
      changed: true,
      stale: false,
      ...(stored === undefined ? {} : { previous: stored }),
    });
  }

  getCommunication(clinicId: ClinicId, id: string): Promise<ContactCommunication | undefined> {
    return Promise.resolve(this.#db.state.communications.get(tenantKey(clinicId, id)));
  }

  listCommunicationsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactCommunication[]> {
    return Promise.resolve(
      this.#communications(clinicId).filter(
        (communication) => communication.patientId === patientId,
      ),
    );
  }

  listCommunicationsForCase(
    clinicId: ClinicId,
    caseId: CaseId,
  ): Promise<readonly ContactCommunication[]> {
    return Promise.resolve(
      this.#communications(clinicId).filter((communication) => communication.caseId === caseId),
    );
  }

  saveFlag(clinicId: ClinicId, flag: PatientContactFlag): Promise<void> {
    if (flag.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    this.#db.setIn(
      this.#db.state.contactFlags,
      tenantKey(clinicId, flag.patientId, flag.issue),
      flag,
    );
    return Promise.resolve();
  }

  listFlags(clinicId: ClinicId, patientId: PatientId): Promise<readonly PatientContactFlag[]> {
    return Promise.resolve(
      [...this.#db.state.contactFlags.values()]
        .filter((flag) => flag.clinicId === clinicId && flag.patientId === patientId)
        .sort((left, right) => right.raisedAt.getTime() - left.raisedAt.getTime()),
    );
  }

  #requests(clinicId: ClinicId): ContactRequest[] {
    return [...this.#db.state.contactRequests.values()]
      .filter((request) => request.clinicId === clinicId)
      .sort(byRequestedAt);
  }

  #communications(clinicId: ClinicId): ContactCommunication[] {
    return [...this.#db.state.communications.values()]
      .filter((communication) => communication.clinicId === clinicId)
      .sort(byRecordedAt);
  }
}

/** In-memory {@link SuppressionRepository}. */
export class MemorySuppressionRepository implements SuppressionRepository {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  create(clinicId: ClinicId, suppression: RuleSuppression): Promise<void> {
    if (suppression.clinicId !== clinicId) {
      return Promise.reject(new TenantMismatchError());
    }
    const key = tenantKey(clinicId, suppression.id);
    const duplicate = [...this.#db.state.suppressions.values()].some(
      (other) =>
        other.clinicId === clinicId &&
        other.patientId === suppression.patientId &&
        other.ruleId === suppression.ruleId &&
        isActiveSuppression(other),
    );
    if (this.#db.state.suppressions.has(key) || duplicate) {
      return Promise.reject(
        new ConflictError('RuleSuppression', `${suppression.patientId}:${suppression.ruleId}`),
      );
    }
    this.#db.setIn(this.#db.state.suppressions, key, suppression);
    return Promise.resolve();
  }

  get(clinicId: ClinicId, id: SuppressionId): Promise<RuleSuppression | undefined> {
    return Promise.resolve(this.#db.state.suppressions.get(tenantKey(clinicId, id)));
  }

  listForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    options: { readonly activeOnly?: boolean } = {},
  ): Promise<readonly RuleSuppression[]> {
    return Promise.resolve(
      [...this.#db.state.suppressions.values()]
        .filter(
          (suppression) =>
            suppression.clinicId === clinicId &&
            suppression.patientId === patientId &&
            (options.activeOnly !== true || isActiveSuppression(suppression)),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        ),
    );
  }

  revoke(
    clinicId: ClinicId,
    id: SuppressionId,
    input: { readonly revokedAt: Date; readonly revokedBy?: string },
  ): Promise<RuleSuppression | undefined> {
    const key = tenantKey(clinicId, id);
    const stored = this.#db.state.suppressions.get(key);
    if (stored === undefined || !isActiveSuppression(stored)) {
      return Promise.resolve(undefined);
    }
    const revoked: RuleSuppression = {
      ...stored,
      revokedAt: input.revokedAt,
      ...(input.revokedBy === undefined ? {} : { revokedBy: input.revokedBy }),
    };
    this.#db.setIn(this.#db.state.suppressions, key, revoked);
    return Promise.resolve(revoked);
  }
}
