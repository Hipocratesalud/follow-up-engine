import type { ClinicalBatch } from '../../domain/clinical-event.ts';
import type { BackfillProgress } from '../../ports/backfill-progress.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { Clock } from '../../ports/clock.ts';
import type {
  EscalationPolicySource,
  ProtocolSource,
  RuleSource,
} from '../../ports/config-sources.ts';
import type {
  ContactCommunication,
  ContactRequest,
  PatientContactFlag,
} from '../../domain/contact.ts';
import type { ContactRequestId } from '../../domain/ids.ts';
import { type CalibrationReport, calibrationReport } from '../calibration/calibration.ts';
import {
  clearContactFlags,
  type CommunicationInput,
  type CommunicationRecordResult,
  recordCommunication,
} from '../patient-contact/outcomes.ts';
import {
  createSuppressionCommands,
  type SuppressionCommands,
} from '../suppression/suppressions.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { NoteExtractor } from '../../ports/note-extractor.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import {
  type BackfillOptions,
  type BackfillReport,
  runBackfill,
  stageHistory,
} from '../backfill/backfill.ts';
import {
  type BackfillReleasePlan,
  planBackfillRelease,
  releaseDueBackfillCases,
} from '../backfill/release.ts';
import type { CaseId } from '../../domain/ids.ts';
import { type CaseCommands, createCaseCommands } from '../case-manager/commands.ts';
import { protocolEnabled } from '../../config/protocol.ts';
import { Catalog } from '../catalog.ts';
import { type EscalationReport, runEscalation } from '../escalation/escalation.ts';
import {
  hasInvalidContactData,
  hasOptedOut,
  lastPatientContactAt,
} from '../patient-contact/history.ts';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../settings.ts';
import { runWatcher, type WatcherReport } from '../watcher/watcher.ts';
import { type ConditionCommands, createConditionCommands } from './condition-commands.ts';
import { ingest, type IngestReport, runNoteExtractionJob } from './ingest.ts';

/** The ports the engine runs on. Apps wire adapters (Postgres, memory, LLM) into them. */
export interface FollowUpEngineDeps {
  readonly unitOfWork: UnitOfWork;
  readonly noteExtractor: NoteExtractor;
  readonly rules: RuleSource;
  readonly protocols: ProtocolSource;
  readonly clinics: ClinicDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly settings?: Partial<EngineSettings>;
  /**
   * Named escalation policies, for clinic overrides
   * (`ClinicSettings.escalationPolicyId`) and cases pinned to a policy no
   * rule references any more. Without it, only the policies rules reference.
   */
  readonly escalationPolicies?: EscalationPolicySource;
}

/** Whether the engine may contact a patient, for the inbox. */
export interface PatientContactStatus {
  /** The clinic allows contact and the patient did not opt out. */
  readonly allowed: boolean;
  readonly optedOut: boolean;
  /** The last message the host was asked to send (calls do not count). */
  readonly lastContactAt?: Date;
  /** The patient's contact data is flagged (a wrong number): messages are skipped, calls go ahead. */
  readonly contactDataInvalid: boolean;
}

/** The patient-contact loop: attempts out, outcomes back. */
export interface ContactCommands {
  /**
   * What came of an attempt (an inbound FHIR `Communication`, or a call the
   * team recorded): stored at its latest version, then the engine reacts
   * (see `recordCommunication`). `NotFoundError` for an unknown attempt.
   */
  recordCommunication(
    clinicId: ClinicId,
    input: CommunicationInput,
  ): Promise<CommunicationRecordResult>;
  /**
   * The host sent the patient's contact data again, changed (a corrected
   * phone number): clears the patient's contact data flags so messages go
   * out again. Returns how many flags it cleared.
   */
  contactDataUpdated(clinicId: ClinicId, patientId: PatientId): Promise<number>;
  /** One attempt, or `undefined` (another clinic's attempt is unknown here). */
  getRequest(clinicId: ClinicId, id: ContactRequestId): Promise<ContactRequest | undefined>;
  getCommunication(clinicId: ClinicId, id: string): Promise<ContactCommunication | undefined>;
  /** The patient's attempts and their communications, oldest first. */
  forPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<{
    readonly requests: readonly ContactRequest[];
    readonly communications: readonly ContactCommunication[];
    readonly flags: readonly PatientContactFlag[];
  }>;
}

/** The initial backfill of a clinic (see `runBackfill`). */
export interface BackfillCommands {
  /** Imports a historical batch without annotating it (the backfill replays it later). Idempotent. */
  stage(batch: ClinicalBatch): Promise<{ readonly inserted: number }>;
  /**
   * Starts the backfill, or resumes the clinic's unfinished run (crashed or
   * paused on budget). Returns when it completes or pauses.
   */
  run(clinicId: ClinicId, options?: BackfillOptions): Promise<BackfillReport>;
  /** A run by id, or the clinic's unfinished run when `runId` is absent. */
  status(clinicId: ClinicId, runId?: string): Promise<BackfillProgress | undefined>;
  /** Activates the held cases whose release day came (the watcher also does it on every sweep). */
  release(clinicId: ClinicId, now: Date): Promise<readonly CaseId[]>;
  /**
   * Schedules every still-unscheduled backfill case (risk order, daily cap per
   * owner, age window). How a shadow run goes live. Idempotent.
   */
  schedule(clinicId: ClinicId, now: Date): Promise<BackfillReleasePlan>;
}

/**
 * The follow-up engine: the application services over the pure domain.
 * Every method is scoped to a clinic and runs in `UnitOfWork` transactions.
 */
export interface FollowUpEngine {
  /** "A consultation was saved": annotate a batch of clinical events. Idempotent. */
  ingest(batch: ClinicalBatch): Promise<IngestReport>;
  /** Deadline sweep: expire due expectations and open or merge cases. */
  runWatcher(clinicId: ClinicId, now: Date): Promise<WatcherReport>;
  /** Escalation sweep: advance due cases along their escalation policy. */
  runEscalation(clinicId: ClinicId, now: Date): Promise<EscalationReport>;
  /** Handler of the `note.extract_plan` job (retry of a failed extraction). Throws to retry. */
  runNoteExtractionJob(
    clinicId: ClinicId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<IngestReport>;
  readonly cases: CaseCommands;
  readonly conditions: ConditionCommands;
  readonly backfill: BackfillCommands;
  readonly contacts: ContactCommands;
  readonly suppressions: SuppressionCommands;
  /** Per rule: how many cases the team found useful and why it dismissed the rest. */
  calibration(clinicId: ClinicId, options?: { readonly since?: Date }): Promise<CalibrationReport>;
  /** The rules and protocols enabled for a clinic (labels, suggested actions, policies). */
  catalog(clinicId: ClinicId): Promise<Catalog>;
  patientContactStatus(clinicId: ClinicId, patientId: PatientId): Promise<PatientContactStatus>;
}

/**
 * Builds the engine from its ports.
 *
 * @example
 * ```ts
 * const engine = createFollowUpEngine({ unitOfWork, noteExtractor, rules, protocols, clinics, clock, ids });
 * await engine.ingest(batch);
 * await engine.runWatcher(clinicId, clock.now());
 * await engine.runEscalation(clinicId, clock.now());
 * ```
 */
export function createFollowUpEngine(deps: FollowUpEngineDeps): FollowUpEngine {
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...deps.settings };
  async function loadCatalog(clinicId: ClinicId): Promise<Catalog> {
    const [rules, protocols, policies, clinic] = await Promise.all([
      deps.rules.listRules(clinicId),
      deps.protocols.listProtocols(clinicId),
      deps.escalationPolicies?.listPolicies(clinicId) ?? Promise.resolve([]),
      deps.clinics.get(clinicId),
    ]);
    // Per-clinic opt-in: a protocol runs only where the clinic enabled it.
    const enabled = clinic?.settings.enabledProtocols;
    const clinicPolicyId = clinic?.settings.escalationPolicyId;
    return new Catalog(
      rules,
      protocols.filter((protocol) => protocolEnabled(protocol.id, enabled)),
      {
        policies,
        ...(clinicPolicyId === undefined ? {} : { clinicPolicyId }),
      },
    );
  }
  const shared = { unitOfWork: deps.unitOfWork, ids: deps.ids, settings, loadCatalog };
  const ingestDeps = { ...shared, noteExtractor: deps.noteExtractor, clock: deps.clock };

  return {
    ingest: (batch) => ingest(ingestDeps, batch),
    runWatcher: (clinicId, now) => runWatcher({ ...shared, clinics: deps.clinics }, clinicId, now),
    runEscalation: (clinicId, now) =>
      runEscalation({ ...shared, clinics: deps.clinics }, clinicId, now),
    runNoteExtractionJob: (clinicId, payload) =>
      runNoteExtractionJob(ingestDeps, clinicId, payload),
    cases: createCaseCommands({ ...shared, clock: deps.clock, clinics: deps.clinics }),
    backfill: {
      stage: (batch) => stageHistory(deps, batch),
      run: (clinicId, options) =>
        runBackfill({ ...ingestDeps, clinics: deps.clinics }, clinicId, options),
      status: (clinicId, runId) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          runId === undefined
            ? stores.backfillProgress.findRunning(clinicId)
            : stores.backfillProgress.get(clinicId, runId),
        ),
      release: async (clinicId, now) =>
        releaseDueBackfillCases(shared, clinicId, now, await loadCatalog(clinicId)),
      schedule: (clinicId, now) =>
        planBackfillRelease({ ...shared, clinics: deps.clinics }, clinicId, now),
    },
    conditions: createConditionCommands({ ...shared, clock: deps.clock }),
    contacts: {
      recordCommunication: (clinicId, input) =>
        recordCommunication(
          { ...shared, clinics: deps.clinics },
          clinicId,
          input,
          deps.clock.now(),
        ),
      contactDataUpdated: (clinicId, patientId) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          clearContactFlags(stores, clinicId, patientId, deps.clock.now()),
        ),
      getRequest: (clinicId, id) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          stores.contacts.getRequest(clinicId, id),
        ),
      getCommunication: (clinicId, id) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          stores.contacts.getCommunication(clinicId, id),
        ),
      forPatient: (clinicId, patientId) =>
        deps.unitOfWork.withTransaction(clinicId, async (stores) => ({
          requests: await stores.contacts.listRequestsForPatient(clinicId, patientId),
          communications: await stores.contacts.listCommunicationsForPatient(clinicId, patientId),
          flags: await stores.contacts.listFlags(clinicId, patientId),
        })),
    },
    suppressions: createSuppressionCommands({ ...shared, clock: deps.clock }),
    calibration: (clinicId, options) => calibrationReport(shared, clinicId, options),
    catalog: loadCatalog,
    async patientContactStatus(clinicId, patientId) {
      const clinic = await deps.clinics.get(clinicId);
      const { optedOut, lastContactAt, contactDataInvalid } = await deps.unitOfWork.withTransaction(
        clinicId,
        async (stores) => ({
          optedOut: await hasOptedOut(stores, clinicId, patientId),
          lastContactAt: await lastPatientContactAt(stores, clinicId, patientId),
          contactDataInvalid: await hasInvalidContactData(stores, clinicId, patientId),
        }),
      );
      return {
        allowed: clinic?.active === true && clinic.settings.allowPatientContact && !optedOut,
        optedOut,
        contactDataInvalid,
        ...(lastContactAt === undefined ? {} : { lastContactAt }),
      };
    },
  };
}
