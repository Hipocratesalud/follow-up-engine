import { ACTIVE_CASE_STATUSES } from '../../domain/case.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import {
  type ClinicalFinding,
  type ClinicalReviewRun,
  type DiscardReason,
  FINDING_CATEGORIES,
  type FindingFlag,
  type FindingVerdict,
  type ReviewLocale,
  REVIEW_TRIGGERS,
  type ReviewTrigger,
} from '../../domain/clinical-finding.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import { type ClinicId, type PatientId, patientId as toPatientId } from '../../domain/ids.ts';
import type { FhirResourceJson } from '../../domain/resource.ts';
import type {
  FindingCounts,
  FindingListQuery,
  FindingPage,
  ReviewRunStats,
} from '../../ports/clinical-finding-repository.ts';
import type { ClinicalReviewAgent, ReviewLimits } from '../../ports/clinical-review-agent.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { Catalog } from '../catalog.ts';
import { listPatientCases } from '../patient-state.ts';
import { refKey } from '../timeline.ts';
import { expectationTestCodes } from './coverage.ts';
import type { ObservationComponent, PatientRecordSnapshot } from './dossier.ts';
import {
  anyEnabled,
  applyFlagUpdate,
  categoryGate,
  type FlagUpdate,
  modeOf,
  resolveFlag,
} from './flags.ts';
import { BLOOD_PRESSURE_PANEL_LOINC, LOINC } from './knowledge.ts';
import { reviewRecord, type ReviewOutcome } from './pipeline.ts';

/** Job that reviews one patient (debounced after new results, notes and prescriptions). */
export const CLINICAL_REVIEW_JOB = 'clinical_review.run';
export const CLINICAL_REVIEW_PROMPT_FALLBACK = 'detectors@1';

/** What starts a review, and the PRD's limits on when it runs. */
export interface ReviewerSettings {
  /** Events of one patient within this window share one review (PRD: 10 minutes). */
  readonly debounceMinutes: number;
  /** A finding identical to one open or reviewed this recently is not stored again (PRD: 90). */
  readonly dedupWindowDays: number;
  /** Patients with an active high-priority case get a review when none ran this recently (PRD: 30). */
  readonly staleAfterDays: number;
  /** Case priority from which a patient counts as high risk (the inbox's "high", 75). */
  readonly highPriorityFrom: number;
  /** Most reviews the daily sweep queues per clinic. */
  readonly staleReviewsPerSweep: number;
  readonly limits?: ReviewLimits;
}

export const DEFAULT_REVIEWER_SETTINGS: ReviewerSettings = {
  debounceMinutes: 10,
  dedupWindowDays: 90,
  staleAfterDays: 30,
  highPriorityFrom: 75,
  staleReviewsPerSweep: 50,
};

/** Event types that queue a review (PRD triggers: result, note, prescription). */
const TRIGGERING_EVENTS: ReadonlySet<ClinicalEvent['type']> = new Set([
  'result.received',
  'note.received',
  'medication.prescribed',
]);

export interface ClinicalReviewJobPayload {
  readonly patientId: string;
  readonly trigger: ReviewTrigger;
}

export interface ClinicalReviewerDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Absent: detectors only (every review stores the checked signals). */
  readonly agent?: ClinicalReviewAgent;
  /** The patient's names and identifiers to mask before anything reaches a model. */
  readonly redactTermsOf?: (patient: FhirResourceJson) => readonly string[];
  /** The clinic's locale: the language findings are written in. Default `en`. */
  readonly localeOf?: (clinicId: ClinicId) => ReviewLocale | Promise<ReviewLocale>;
  readonly settings?: Partial<ReviewerSettings>;
  /**
   * The clinic's catalog (`engine.catalog`): what each open expectation asks
   * for, so a finding about a test a protocol item already expects (any code
   * of its equivalence group) is marked `alreadyCovered`. Absent: only an
   * expectation's own code counts.
   */
  readonly loadCatalog?: (clinicId: ClinicId) => Promise<Catalog>;
}

/** One review and what it stored. */
export interface ReviewReport {
  readonly run: ClinicalReviewRun;
  readonly findings: readonly ClinicalFinding[];
  /** Only for tests and evals: the detector signals and the dossier the review saw. */
  readonly outcome: ReviewOutcome;
}

/** A flag as the inbox shows it: every implemented category, configured or not. */
export interface ResolvedFlag {
  readonly category: FindingFlag['category'];
  readonly specialty?: string;
  readonly enabled: boolean;
  readonly mode: FindingFlag['mode'];
  readonly validatedBy?: string;
  readonly validatedAt?: Date;
  readonly updatedBy?: string;
  readonly updatedAt?: Date;
}

export interface ClinicalReviewer {
  /** Reviews a patient now. Never throws on an agent failure (falls back to the detectors). */
  reviewPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    trigger: ReviewTrigger,
  ): Promise<ReviewReport>;
  /**
   * Handler of {@link CLINICAL_REVIEW_JOB}. `undefined` when a stale-patient
   * review is no longer due (the patient was reviewed since it was queued).
   */
  runReviewJob(
    clinicId: ClinicId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<ReviewReport | undefined>;
  /**
   * Queues a review for every patient with an active high-priority case not
   * reviewed in `staleAfterDays` (the PRD's daily job; V2's risk tier does
   * not exist yet, the case priority stands in for it). Returns how many.
   */
  scheduleStaleReviews(clinicId: ClinicId, now: Date): Promise<number>;
  listFindings(clinicId: ClinicId, query: FindingListQuery): Promise<FindingPage>;
  countFindings(
    clinicId: ClinicId,
    query: Pick<FindingListQuery, 'mode' | 'patientId'>,
  ): Promise<FindingCounts>;
  getFinding(clinicId: ClinicId, id: string): Promise<ClinicalFinding | undefined>;
  /** Records the clinician's verdict. A reason is required for `not_relevant` (`ValidationError`). */
  reviewFinding(
    clinicId: ClinicId,
    id: string,
    input: { readonly verdict: FindingVerdict; readonly reason?: string; readonly userId: string },
  ): Promise<ClinicalFinding>;
  getRun(clinicId: ClinicId, id: string): Promise<ClinicalReviewRun | undefined>;
  runStats(clinicId: ClinicId, since: Date): Promise<ReviewRunStats>;
  listFlags(clinicId: ClinicId): Promise<readonly ResolvedFlag[]>;
  /** Throws `ValidationError` for a live flag without sign-off or a reserved category. */
  updateFlag(clinicId: ClinicId, update: FlagUpdate, userId: string): Promise<ResolvedFlag>;
}

function stringField(resource: FhirResourceJson | undefined, field: string): string | undefined {
  const value = resource?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Numeric components of a panel Observation (`component[].valueQuantity`), by LOINC code. */
export function observationComponents(resource: FhirResourceJson): ObservationComponent[] {
  const components = resource['component'];
  if (!Array.isArray(components)) return [];
  return components.flatMap((component): ObservationComponent[] => {
    if (typeof component !== 'object' || component === null || Array.isArray(component)) return [];
    const record = component as Record<string, unknown>;
    const coding = (record['code'] as { coding?: unknown } | undefined)?.coding;
    const loinc = Array.isArray(coding)
      ? (coding as { system?: unknown; code?: unknown }[]).find((item) => item.system === LOINC)
      : undefined;
    const quantity = record['valueQuantity'] as
      { value?: unknown; unit?: unknown; code?: unknown } | undefined;
    if (typeof loinc?.code !== 'string' || typeof quantity?.value !== 'number') return [];
    const unit =
      typeof quantity.unit === 'string'
        ? quantity.unit
        : typeof quantity.code === 'string'
          ? quantity.code
          : undefined;
    return [{ code: loinc.code, value: quantity.value, ...(unit === undefined ? {} : { unit }) }];
  });
}

function parseJobPayload(payload: Readonly<Record<string, unknown>>): ClinicalReviewJobPayload {
  const { patientId, trigger } = payload;
  if (typeof patientId !== 'string' || patientId === '') {
    throw new ValidationError('payload', `Invalid ${CLINICAL_REVIEW_JOB} payload`);
  }
  const known = REVIEW_TRIGGERS.find((item) => item === trigger);
  return { patientId, trigger: known ?? 'manual' };
}

/**
 * Queues the debounced review of a patient after new results, notes or
 * prescriptions, in the ingest transaction. A review already queued for the
 * patient takes the new events too (the job reads the record when it runs),
 * so a consultation saved with its note, orders and prescriptions is
 * reviewed once. Nothing is queued while every category is off.
 */
export async function scheduleReviewAfterIngest(
  stores: TransactionalStores,
  input: {
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly events: readonly ClinicalEvent[];
    readonly now: Date;
    readonly debounceMinutes?: number;
  },
): Promise<boolean> {
  const trigger = input.events.find((event) => TRIGGERING_EVENTS.has(event.type))?.type;
  if (trigger === undefined) return false;
  if (!anyEnabled(await stores.findingFlags.list(input.clinicId))) return false;
  const debounce = input.debounceMinutes ?? DEFAULT_REVIEWER_SETTINGS.debounceMinutes;
  const payload: ClinicalReviewJobPayload = {
    patientId: input.patientId,
    trigger: trigger as ReviewTrigger,
  };
  await stores.jobs.enqueue(input.clinicId, {
    type: CLINICAL_REVIEW_JOB,
    payload: { ...payload },
    runAt: new Date(input.now.getTime() + debounce * 60_000),
    dedupKey: `${CLINICAL_REVIEW_JOB}:${input.patientId}`,
    maxAttempts: 3,
  });
  return true;
}

function discardList(
  discarded: Readonly<Partial<Record<DiscardReason, number>>>,
): ClinicalReviewRun['discarded'] {
  return Object.entries(discarded)
    .filter((entry): entry is [DiscardReason, number] => entry[1] > 0)
    .map(([reason, count]) => ({ reason, count }));
}

/**
 * The clinical reviewer (PRD V3): reviews a patient when something
 * important changed, stores findings in shadow or live mode by category
 * flag, deduplicates them over 90 days and records the cost of every run.
 * Findings are suggestions to the clinical team only: a shadow finding is
 * never exported nor sent anywhere; a live one emits `clinical_finding.created`
 * to the host, never anything to the patient.
 */
export function createClinicalReviewer(deps: ClinicalReviewerDeps): ClinicalReviewer {
  const settings: ReviewerSettings = { ...DEFAULT_REVIEWER_SETTINGS, ...deps.settings };

  async function snapshotOf(
    stores: TransactionalStores,
    clinicId: ClinicId,
    patientId: PatientId,
    now: Date,
    catalog: Catalog | undefined,
  ): Promise<{ snapshot: PatientRecordSnapshot; redactTerms: readonly string[] }> {
    const [events, conditions, expectations, cases, patient] = await Promise.all([
      stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
      stores.conditions.listByPatient(clinicId, patientId),
      stores.expectations.listByPatient(clinicId, patientId, ['open', 'expired']),
      listPatientCases(stores, clinicId, patientId, { statuses: ACTIVE_CASE_STATUSES }),
      stores.clinicalRecords.getResource(clinicId, { resourceType: 'Patient', id: patientId }),
    ]);
    const components = new Map<string, ObservationComponent[]>();
    for (const event of events) {
      if (
        event.type === 'result.received' &&
        event.value === undefined &&
        event.code.system === LOINC &&
        BLOOD_PRESSURE_PANEL_LOINC.includes(event.code.code)
      ) {
        const stored = await stores.clinicalRecords.getResource(clinicId, event.source);
        if (stored !== undefined)
          components.set(refKey(event.source), observationComponents(stored.resource));
      }
    }
    const birthDate = stringField(patient?.resource, 'birthDate');
    const gender = stringField(patient?.resource, 'gender');
    return {
      snapshot: {
        clinicId,
        patientId,
        now,
        ...(birthDate === undefined ? {} : { birthDate }),
        ...(gender === undefined ? {} : { gender }),
        events,
        conditions,
        liveExpectations: expectations,
        ...(catalog === undefined
          ? {}
          : { expectationTestCodes: expectationTestCodes(catalog, expectations) }),
        activeCases: cases.filter((item) => item.releaseAt === undefined || item.releaseAt <= now),
        components,
      },
      redactTerms: patient === undefined ? [] : (deps.redactTermsOf?.(patient.resource) ?? []),
    };
  }

  async function reviewPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    trigger: ReviewTrigger,
  ): Promise<ReviewReport> {
    const startedAt = deps.clock.now();
    const runId = deps.ids.next('review_run');
    const catalog = await deps.loadCatalog?.(clinicId);
    const { snapshot, redactTerms, flags } = await deps.unitOfWork.withTransaction(
      clinicId,
      async (stores) => ({
        ...(await snapshotOf(stores, clinicId, patientId, startedAt, catalog)),
        flags: await stores.findingFlags.list(clinicId),
      }),
    );
    const locale = (await deps.localeOf?.(clinicId)) ?? 'en';
    // The model is called outside any transaction: no lock is held while it thinks.
    const outcome = await reviewRecord(clinicId, snapshot, {
      locale,
      ...(deps.agent === undefined ? {} : { agent: deps.agent }),
      enabled: categoryGate(flags),
      redactTerms,
      patientRef: `P-${runId.slice(-8)}`,
      ...(settings.limits === undefined ? {} : { limits: settings.limits }),
    });

    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const now = deps.clock.now();
      const since = new Date(now.getTime() - settings.dedupWindowDays * 86_400_000);
      const stored: ClinicalFinding[] = [];
      let duplicates = 0;
      const modelId = outcome.agent?.modelId ?? 'detector';
      const promptVersion = outcome.agent?.promptVersion ?? CLINICAL_REVIEW_PROMPT_FALLBACK;
      for (const draft of outcome.findings) {
        const existing = await stores.clinicalFindings.findDuplicates(
          clinicId,
          patientId,
          draft.dedupKey,
          since,
        );
        if (existing.length > 0) {
          duplicates += 1;
          continue;
        }
        const mode = modeOf(flags, draft.category, draft.specialty) ?? 'shadow';
        const finding: ClinicalFinding = {
          id: deps.ids.next('clinical_finding'),
          clinicId,
          patientId,
          category: draft.category,
          severity: draft.severity,
          summary: draft.summary,
          rationale: draft.rationale,
          suggestion: draft.suggestion,
          citations: draft.citations,
          alreadyCovered: draft.alreadyCovered,
          coveredBy: draft.coveredBy,
          ...(draft.specialty === undefined ? {} : { specialty: draft.specialty }),
          mode,
          status: 'open',
          origin: draft.origin,
          dedupKey: draft.dedupKey,
          runId,
          modelId: draft.origin === 'fallback' ? 'detector' : modelId,
          promptVersion:
            draft.origin === 'fallback' ? CLINICAL_REVIEW_PROMPT_FALLBACK : promptVersion,
          createdAt: now,
          updatedAt: now,
        };
        await stores.clinicalFindings.create(clinicId, finding);
        if (mode === 'live') {
          await stores.outbox.add(clinicId, {
            id: deps.ids.next('domain_event'),
            type: 'clinical_finding.created',
            clinicId,
            occurredAt: now,
            payload: { findingId: finding.id, patientId, severity: finding.severity },
          });
        }
        stored.push(finding);
      }
      const discarded = discardList({
        ...outcome.discarded,
        ...(duplicates > 0 ? { duplicate: duplicates } : {}),
      });
      const run: ClinicalReviewRun = {
        id: runId,
        clinicId,
        patientId,
        trigger,
        status: outcome.status,
        signalsCount: outcome.signals.length,
        findingsCount: stored.length,
        discardedCount: Object.entries(outcome.discarded).reduce(
          (total, [reason, count]) => total + (reason === 'merged' ? 0 : count),
          0,
        ),
        duplicateCount: duplicates,
        discarded,
        steps: outcome.agent?.steps ?? 0,
        toolCalls: outcome.agent?.toolCalls ?? 0,
        trace: outcome.agent?.trace ?? [],
        inputTokens: outcome.agent?.inputTokens ?? 0,
        outputTokens: outcome.agent?.outputTokens ?? 0,
        costUsd: outcome.agent?.costUsd ?? 0,
        modelId,
        promptVersion,
        stopReason: outcome.stopReason,
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        startedAt,
        finishedAt: now,
      };
      await stores.reviewRuns.record(clinicId, run);
      return { run, findings: stored, outcome };
    });
  }

  async function scheduleStaleReviews(clinicId: ClinicId, now: Date): Promise<number> {
    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      if (!anyEnabled(await stores.findingFlags.list(clinicId))) return 0;
      const patients = new Set<PatientId>();
      let cursor: string | undefined;
      do {
        const page = await stores.cases.list(clinicId, {
          statuses: ACTIVE_CASE_STATUSES,
          releasedAsOf: now,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const item of page.items) {
          if (item.priority >= settings.highPriorityFrom) patients.add(item.patientId);
        }
        // Ordered by priority: past the first page below the threshold, nothing else qualifies.
        cursor =
          page.items.at(-1) !== undefined &&
          (page.items.at(-1)?.priority ?? 0) >= settings.highPriorityFrom
            ? page.nextCursor
            : undefined;
      } while (cursor !== undefined);
      const staleBefore = now.getTime() - settings.staleAfterDays * 86_400_000;
      let queued = 0;
      for (const patientId of [...patients].sort()) {
        if (queued >= settings.staleReviewsPerSweep) break;
        const last = await stores.reviewRuns.lastReviewedAt(clinicId, patientId);
        if (last !== undefined && last.getTime() > staleBefore) continue;
        const payload: ClinicalReviewJobPayload = { patientId, trigger: 'stale_high_priority' };
        await stores.jobs.enqueue(clinicId, {
          type: CLINICAL_REVIEW_JOB,
          payload: { ...payload },
          runAt: now,
          dedupKey: `${CLINICAL_REVIEW_JOB}:${patientId}`,
          maxAttempts: 3,
        });
        queued += 1;
      }
      return queued;
    });
  }

  function resolvedFlags(clinicId: ClinicId, flags: readonly FindingFlag[]): ResolvedFlag[] {
    const clinicWide = FLAG_CATEGORIES.map((category) => {
      const flag = resolveFlag(flags, category, undefined);
      return toResolved(
        flag ?? { clinicId, category, enabled: false, mode: 'shadow', updatedAt: new Date(0) },
        flag !== undefined,
      );
    });
    const bySpecialty = flags
      .filter((flag) => flag.specialty !== undefined)
      .map((flag) => toResolved(flag, true));
    return [...clinicWide, ...bySpecialty];
  }

  return {
    reviewPatient,
    async runReviewJob(clinicId, rawPayload) {
      const payload = parseJobPayload(rawPayload);
      const patientId = toPatientId(payload.patientId);
      if (payload.trigger === 'stale_high_priority') {
        const last = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
          stores.reviewRuns.lastReviewedAt(clinicId, patientId),
        );
        const due = deps.clock.now().getTime() - settings.staleAfterDays * 86_400_000;
        if (last !== undefined && last.getTime() > due) return undefined;
      }
      return reviewPatient(clinicId, patientId, payload.trigger);
    },
    scheduleStaleReviews,
    listFindings: (clinicId, query) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.clinicalFindings.list(clinicId, query),
      ),
    countFindings: (clinicId, query) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.clinicalFindings.counts(clinicId, query),
      ),
    getFinding: (clinicId, id) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.clinicalFindings.get(clinicId, id),
      ),
    async reviewFinding(clinicId, id, input) {
      const reason = input.reason?.trim();
      if (input.verdict === 'not_relevant' && (reason === undefined || reason === '')) {
        throw new ValidationError('reason', 'A reason is required when a finding is not relevant');
      }
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const current = await stores.clinicalFindings.get(clinicId, id);
        if (current === undefined) throw new NotFoundError('ClinicalFinding', id);
        return stores.clinicalFindings.review(clinicId, id, {
          verdict: input.verdict,
          ...(reason === undefined || reason === '' ? {} : { reason }),
          reviewedBy: input.userId,
          reviewedAt: deps.clock.now(),
        });
      });
    },
    getRun: (clinicId, id) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) => stores.reviewRuns.get(clinicId, id)),
    runStats: (clinicId, since) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.reviewRuns.stats(clinicId, since),
      ),
    async listFlags(clinicId) {
      const flags = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.findingFlags.list(clinicId),
      );
      return resolvedFlags(clinicId, flags);
    },
    async updateFlag(clinicId, update, userId) {
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const flags = await stores.findingFlags.list(clinicId);
        const current = flags.find(
          (flag) => flag.category === update.category && flag.specialty === update.specialty,
        );
        const next = applyFlagUpdate(clinicId, current, update, userId, deps.clock.now());
        await stores.findingFlags.upsert(clinicId, next);
        return toResolved(next, true);
      });
    },
  };
}

/** Every category, the reserved one included (shown, never enabled). */
const FLAG_CATEGORIES = FINDING_CATEGORIES;

function toResolved(flag: FindingFlag, configured: boolean): ResolvedFlag {
  return {
    category: flag.category,
    ...(flag.specialty === undefined ? {} : { specialty: flag.specialty }),
    enabled: flag.enabled,
    mode: flag.mode,
    ...(flag.validatedBy === undefined ? {} : { validatedBy: flag.validatedBy }),
    ...(flag.validatedAt === undefined ? {} : { validatedAt: flag.validatedAt }),
    ...(flag.updatedBy === undefined ? {} : { updatedBy: flag.updatedBy }),
    ...(configured ? { updatedAt: flag.updatedAt } : {}),
  };
}
