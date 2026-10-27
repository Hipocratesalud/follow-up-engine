import type { ClinicalBatch } from '../../domain/clinical-event.ts';
import type { BackfillProgress } from '../../ports/backfill-progress.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { Clock } from '../../ports/clock.ts';
import type { ProtocolSource, RuleSource } from '../../ports/config-sources.ts';
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
import { Catalog } from '../catalog.ts';
import { type EscalationReport, runEscalation } from '../escalation/escalation.ts';
import { hasOptedOut, lastPatientContactAt } from '../patient-contact/history.ts';
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
}

/** Whether the engine may contact a patient, for the inbox. */
export interface PatientContactStatus {
  /** The clinic allows contact and the patient did not opt out. */
  readonly allowed: boolean;
  readonly optedOut: boolean;
  readonly lastContactAt?: Date;
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
    const [rules, protocols] = await Promise.all([
      deps.rules.listRules(clinicId),
      deps.protocols.listProtocols(clinicId),
    ]);
    return new Catalog(rules, protocols);
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
    catalog: loadCatalog,
    async patientContactStatus(clinicId, patientId) {
      const clinic = await deps.clinics.get(clinicId);
      const { optedOut, lastContactAt } = await deps.unitOfWork.withTransaction(
        clinicId,
        async (stores) => ({
          optedOut: await hasOptedOut(stores, clinicId, patientId),
          lastContactAt: await lastPatientContactAt(stores, clinicId, patientId),
        }),
      );
      return {
        allowed: clinic?.active === true && clinic.settings.allowPatientContact && !optedOut,
        optedOut,
        ...(lastContactAt === undefined ? {} : { lastContactAt }),
      };
    },
  };
}
