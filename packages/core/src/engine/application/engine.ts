import type { ClinicalBatch } from '../../domain/clinical-event.ts';
import type { BackfillProgress } from '../../ports/backfill-progress.ts';
import type { ClinicId, ExpectationId, PatientId } from '../../domain/ids.ts';
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
import type { ClinicMetrics } from '../metrics/metrics.ts';
import { clinicMetrics } from '../metrics/service.ts';
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
import type { RuleOverrideStore } from '../../ports/rule-override-store.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import {
  type BackfillOptions,
  type BackfillReport,
  type PatientReplayReport,
  replayPatients,
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
import {
  type AuthoredRuleCommands,
  createAuthoredRuleCommands,
} from '../rule-authoring/commands.ts';
import { type AuthoredDefinition, authoredDefinitionId } from '../../domain/authored-rule.ts';
import { createExplainer, type ExpectationExplanation } from '../explain/explain.ts';
import { type EscalationReport, runEscalation } from '../escalation/escalation.ts';
import {
  hasInvalidContactData,
  hasOptedOut,
  lastPatientContactAt,
} from '../patient-contact/history.ts';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../settings.ts';
import { runWatcher, type WatcherReport } from '../watcher/watcher.ts';
import {
  type ReconciliationOptions,
  type ReconciliationReport,
  runReconciliation,
  runReconciliationJob,
  scheduleReconciliation,
} from '../reconciliation/reconcile.ts';
import {
  createRuleOverrideCommands,
  OverridingRuleSource,
  type RuleOverrideCommands,
} from '../rules/overrides.ts';
import type {
  ReconciliationRepair,
  ReconciliationRun,
  ReconciliationScope,
} from '../../domain/reconciliation.ts';
import { type ConditionCommands, createConditionCommands } from './condition-commands.ts';
import { createPlanItemCommands, type PlanItemCommands } from './plan-item-commands.ts';
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
  /**
   * The rule overrides store outside any transaction, for reads: a catalog
   * is also loaded inside a transaction (a case action), where the memory
   * unit of work cannot open another. Without it, overrides are read through
   * `unitOfWork` (fine on Postgres, which nests with savepoints).
   */
  readonly ruleOverrides?: RuleOverrideStore;
  /**
   * Test and QA accounts (actor ids): left out of the metrics and the rule
   * calibration, never of the stored history. Without it, every actor counts.
   */
  readonly isTestActor?: (actorId: string) => boolean;
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
  /**
   * Replays a few patients' imported history ("Import history") like the
   * backfill, as its own run: the clinic's backfill run is never touched.
   */
  replayPatients(
    clinicId: ClinicId,
    patientIds: readonly PatientId[],
    options?: { readonly clock?: Clock; readonly runId?: string },
  ): Promise<PatientReplayReport>;
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

/** The nightly reconciliation of a clinic (see `runReconciliation`). */
export interface ReconciliationCommands {
  /** Runs a reconciliation now, or resumes the clinic's unfinished one. */
  run(clinicId: ClinicId, options?: ReconciliationOptions): Promise<ReconciliationReport>;
  /** Handler of the `reconciliation.run` job. Throws to retry (the retry resumes). */
  runJob(
    clinicId: ClinicId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<ReconciliationReport>;
  /** Queues the clinic's next nightly run (idempotent); `undefined` when switched off. */
  schedule(
    clinicId: ClinicId,
    now: Date,
  ): Promise<{ readonly at: Date; readonly scope: ReconciliationScope } | undefined>;
  /** Runs, most recent first. */
  runs(clinicId: ClinicId, limit?: number): Promise<readonly ReconciliationRun[]>;
  /** The audited repairs (of one run, or one patient, when given), in order. */
  repairs(
    clinicId: ClinicId,
    query?: { readonly runId?: string; readonly patientId?: PatientId; readonly limit?: number },
  ): Promise<readonly ReconciliationRepair[]>;
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
  /** Clinician review of AI-read plan items: confirm, correct, reject (HIP-141). */
  readonly planItems: PlanItemCommands;
  readonly backfill: BackfillCommands;
  readonly contacts: ContactCommands;
  readonly suppressions: SuppressionCommands;
  /** Per-clinic rule overrides: deadlines and switches, versioned and audited. */
  readonly ruleOverrides: RuleOverrideCommands;
  /**
   * Rules a clinic wrote for itself (the rule-authoring agent's drafts),
   * kept in its rule overrides: draft, enable (by a clinician), discard,
   * and the engine's dry run over the clinic's current records.
   */
  readonly authoredRules: AuthoredRuleCommands;
  /** The nightly safety net for lost or out-of-order events. */
  readonly reconciliation: ReconciliationCommands;
  /** Per rule: how many cases the team found useful and why it dismissed the rest. */
  calibration(clinicId: ClinicId, options?: { readonly since?: Date }): Promise<CalibrationReport>;
  /**
   * The clinic's metrics over `[from, to)` (default: the last 30 days up to
   * now): cases, bookings attributed to the engine or organic, attendance,
   * time to first action, feedback, dismissals, extraction reviews, AI cost
   * (docs/metrics.md). Throws `ValidationError` for an empty or too long period.
   */
  metrics(
    clinicId: ClinicId,
    period?: { readonly from?: Date; readonly to?: Date },
  ): Promise<ClinicMetrics>;
  /** The rules and protocols enabled for a clinic (labels, suggested actions, policies). */
  catalog(clinicId: ClinicId): Promise<Catalog>;
  /**
   * Why each of a patient's expectations exists (all of them, or those of
   * `expectationIds`), recomputed from the stored record and the clinic's
   * catalog (HIP-142): the due date's anchor and interval, the protocol
   * enrollment, the visit pattern, what would fulfill it. Read only.
   */
  explain(
    clinicId: ClinicId,
    patientId: PatientId,
    expectationIds?: readonly ExpectationId[],
  ): Promise<readonly ExpectationExplanation[]>;
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
  // The clinic's stored overrides (a 10-day lab deadline, a rule switched
  // off) layered over the validated rules.
  const rules = new OverridingRuleSource(deps.rules, deps.ruleOverrides ?? deps.unitOfWork);
  /**
   * The clinic's catalog; with `extra`, as it would be with that
   * clinic-authored definition enabled too (the rule-authoring dry run).
   */
  async function buildCatalog(clinicId: ClinicId, extra?: AuthoredDefinition): Promise<Catalog> {
    const retired = await rules.listRetiredRules(clinicId);
    const [enabledRules, protocols, authoredProtocols, policies, clinic] = await Promise.all([
      rules.listRules(clinicId),
      deps.protocols.listProtocols(clinicId),
      rules.listAuthoredProtocols(clinicId),
      deps.escalationPolicies?.listPolicies(clinicId) ?? Promise.resolve([]),
      deps.clinics.get(clinicId),
    ]);
    // Per-clinic opt-in: a protocol runs only where the clinic enabled it.
    // A clinic-authored protocol was enabled by a clinician of the clinic.
    const enabled = clinic?.settings.enabledProtocols;
    const clinicPolicyId = clinic?.settings.escalationPolicyId;
    const extraId = extra === undefined ? undefined : authoredDefinitionId(extra);
    return new Catalog(
      [
        ...enabledRules.filter((rule) => rule.id !== extraId),
        ...(extra?.kind === 'rule' ? [extra.rule] : []),
      ],
      [
        ...protocols.filter((protocol) => protocolEnabled(protocol.id, enabled)),
        ...authoredProtocols.filter((protocol) => protocol.id !== extraId),
        ...(extra?.kind === 'protocol' ? [extra.protocol] : []),
      ],
      {
        policies,
        ...(clinicPolicyId === undefined ? {} : { clinicPolicyId }),
        ...(retired.length === 0 ? {} : { retiredRules: retired }),
      },
    );
  }
  const loadCatalog = (clinicId: ClinicId): Promise<Catalog> => buildCatalog(clinicId);
  const shared = {
    unitOfWork: deps.unitOfWork,
    ids: deps.ids,
    settings,
    loadCatalog,
    ...(deps.isTestActor === undefined ? {} : { isTestActor: deps.isTestActor }),
  };
  const ingestDeps = {
    ...shared,
    noteExtractor: deps.noteExtractor,
    clock: deps.clock,
    clinics: deps.clinics,
  };
  const reconciliationDeps = ingestDeps;

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
      replayPatients: (clinicId, patientIds, options) =>
        replayPatients({ ...ingestDeps, clinics: deps.clinics }, clinicId, patientIds, options),
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
    planItems: createPlanItemCommands({ ...shared, clock: deps.clock }),
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
    ruleOverrides: createRuleOverrideCommands({
      unitOfWork: deps.unitOfWork,
      rules,
      clock: deps.clock,
    }),
    authoredRules: createAuthoredRuleCommands({
      unitOfWork: deps.unitOfWork,
      rules,
      clock: deps.clock,
      dryRun: { ...ingestDeps, catalogWith: buildCatalog },
    }),
    reconciliation: {
      run: (clinicId, options) => runReconciliation(reconciliationDeps, clinicId, options),
      runJob: (clinicId, payload) => runReconciliationJob(reconciliationDeps, clinicId, payload),
      schedule: (clinicId, now) => scheduleReconciliation(reconciliationDeps, clinicId, now),
      runs: (clinicId, limit = 20) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          stores.reconciliation.list(clinicId, { limit }),
        ),
      repairs: (clinicId, query = {}) =>
        deps.unitOfWork.withTransaction(clinicId, (stores) =>
          stores.reconciliation.listRepairs(clinicId, { limit: 1000, ...query }),
        ),
    },
    calibration: (clinicId, options) => calibrationReport(shared, clinicId, options),
    metrics: (clinicId, period) =>
      clinicMetrics(
        {
          unitOfWork: deps.unitOfWork,
          clock: deps.clock,
          ...(deps.isTestActor === undefined ? {} : { isTestActor: deps.isTestActor }),
        },
        clinicId,
        period,
      ),
    catalog: loadCatalog,
    async explain(clinicId, patientId, expectationIds) {
      const catalog = await loadCatalog(clinicId);
      const { events, conditions, expectations } = await deps.unitOfWork.withTransaction(
        clinicId,
        async (stores) => ({
          events: await stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
          conditions: await stores.conditions.listByPatient(clinicId, patientId),
          expectations: await stores.expectations.listByPatient(clinicId, patientId),
        }),
      );
      const wanted = expectationIds === undefined ? undefined : new Set<string>(expectationIds);
      const explainer = createExplainer({ catalog, conditions, events, now: deps.clock.now() });
      return expectations
        .filter((expectation) => wanted === undefined || wanted.has(expectation.id))
        .map(explainer);
    },
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
