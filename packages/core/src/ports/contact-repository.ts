import type {
  ContactCommunication,
  ContactRequest,
  PatientContactFlag,
} from '../domain/contact.ts';
import type { CaseId, ClinicId, ContactRequestId, PatientId } from '../domain/ids.ts';

export interface ContactRequestReadOptions {
  /** Lock the request until the transaction ends (Postgres `FOR UPDATE`), like a case. */
  readonly forUpdate?: boolean;
}

/** What {@link ContactRepository.saveCommunication} did. */
export interface SaveCommunicationResult {
  /** The stored version (the new one, or the one kept). */
  readonly communication: ContactCommunication;
  /** False when the same version was already stored (a re-delivery) or the given one was older. */
  readonly changed: boolean;
  /** The given version was older than the stored one: nothing was stored. */
  readonly stale: boolean;
  /** The version stored before this one, if any. */
  readonly previous?: ContactCommunication;
}

/**
 * Contact attempts (`CommunicationRequest`), what came of them
 * (`Communication`) and the patient's contact data flags. Every method is
 * scoped to a clinic; adapters throw `TenantMismatchError` when a value's
 * `clinicId` differs from the call's.
 */
export interface ContactRepository {
  /** Throws `ConflictError` if the id exists. */
  createRequest(clinicId: ClinicId, request: ContactRequest): Promise<void>;

  getRequest(
    clinicId: ClinicId,
    id: ContactRequestId,
    options?: ContactRequestReadOptions,
  ): Promise<ContactRequest | undefined>;

  /** A patient's attempts, from any case, by `requestedAt` then id. */
  listRequestsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactRequest[]>;

  /** A case's attempts, by `requestedAt` then id. */
  listRequestsForCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly ContactRequest[]>;

  /**
   * Stores a communication at its latest version, keyed by `id` in the
   * clinic. A version is older when its numeric `versionId` is lower, else
   * when its `lastUpdated` is earlier (the same order the FHIR resources
   * follow); an older one is not stored (`stale`). The same version again is
   * `changed: false`.
   */
  saveCommunication(
    clinicId: ClinicId,
    communication: ContactCommunication,
  ): Promise<SaveCommunicationResult>;

  getCommunication(clinicId: ClinicId, id: string): Promise<ContactCommunication | undefined>;

  /** Communications of the patient's attempts, by `recordedAt` then id. */
  listCommunicationsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactCommunication[]>;

  /** Communications of one case's attempts, by `recordedAt` then id. */
  listCommunicationsForCase(
    clinicId: ClinicId,
    caseId: CaseId,
  ): Promise<readonly ContactCommunication[]>;

  /** Raises or replaces the patient's flag for `flag.issue` (one per patient and issue). */
  saveFlag(clinicId: ClinicId, flag: PatientContactFlag): Promise<void>;

  /** The patient's flags, cleared ones included, newest first. */
  listFlags(clinicId: ClinicId, patientId: PatientId): Promise<readonly PatientContactFlag[]>;
}
