import {
  type Adjudication,
  ADJUDICATION_REASON_CODES,
  type AdjudicationDecision,
  type AdjudicationOverrideDecision,
  type AdjudicationReasonCode,
  type AdjudicatorSettings,
  DISCARDED_BY_ADJUDICATOR,
  isAmbiguousConfidence,
  resolveAdjudicatorSettings,
  type ResolvedAdjudicatorSettings,
} from '../../domain/adjudication.ts';
import type { CaseEventActor, CaseEventType, FollowUpCase } from '../../domain/case.ts';
import type {
  NoteReceivedEvent,
  PlanExtractedEvent,
  PlanItem,
} from '../../domain/clinical-event.ts';
import type { Evidence } from '../../domain/common.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { Expectation } from '../../domain/expectation.ts';
import {
  type CaseId,
  type ClinicId,
  type ExpectationId,
  expectationId as toExpectationId,
  type PatientId,
} from '../../domain/ids.ts';
import { REJECTED_BY_CLINICIAN, type PlanItemReviewType } from '../../domain/plan-item-review.ts';
import type { FhirResourceJson } from '../../domain/resource.ts';
import type { AdjudicationListQuery } from '../../ports/adjudication-repository.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { Clock } from '../../ports/clock.ts';
import type {
  AdjudicationInput,
  AdjudicationProviderResult,
  ExpectationAdjudicator,
} from '../../ports/expectation-adjudicator.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { JsonObject } from '../../shared/json.ts';
import { planItemReading } from '../application/plan-item-commands.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, reopened, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import { isActiveCaseStatus } from '../case-manager/state-machine.ts';
import { kindOfMatchKey } from '../matching/match-key.ts';
import { locateVerbatim } from '../reviewer/text.ts';
import { dateKey } from '../support/time.ts';

/** Job that adjudicates one ambiguous expectation (queued in the transaction that created it). */
export const ADJUDICATION_JOB = 'adjudication.run';
/** Retries of an adjudication job: a provider outage only delays it; the item is followed up meanwhile. */
export const ADJUDICATION_MAX_ATTEMPTS = 3;

/** Most quotes kept per decision. */
const MAX_QUOTES = 3;
/** Letters or digits a quote needs to count as evidence. */
const MIN_QUOTE_SIGNIFICANT_CHARS = 4;
const MAX_RATIONALE_CHARS = 400;
const MS_PER_DAY = 86_400_000;

export interface AdjudicationJobPayload {
  readonly expectationId: string;
}

/**
 * Whether the adjudicator looks at this expectation under these settings: a
 * live (open or overdue) doctor's plan item, read with an ambiguous
 * confidence, with its quote, that no clinician reviewed yet. Clear items
 * (above the band) and items a doctor already confirmed never go through it.
 */
export function isAdjudicationCandidate(
  expectation: Expectation,
  settings: ResolvedAdjudicatorSettings,
): boolean {
  return (
    settings.mode !== 'off' &&
    expectation.layer === 'doctor_plan' &&
    (expectation.status === 'open' || expectation.status === 'expired') &&
    expectation.evidence !== undefined &&
    expectation.confirmedBy === undefined &&
    expectation.correctionOf === undefined &&
    isAmbiguousConfidence(expectation.confidence, settings)
  );
}

/**
 * Queues one adjudication per ambiguous expectation just created, in the
 * caller's transaction (ingest), so a committed plan item is never left
 * without its decision. Nothing is queued while the clinic's adjudicator is
 * off. Returns how many were queued.
 */
export async function scheduleAdjudications(
  stores: TransactionalStores,
  input: {
    readonly clinicId: ClinicId;
    readonly settings: AdjudicatorSettings | undefined;
    readonly expectations: readonly Expectation[];
  },
): Promise<number> {
  const settings = resolveAdjudicatorSettings(input.settings);
  if (settings.mode === 'off') return 0;
  let queued = 0;
  for (const expectation of input.expectations) {
    if (!isAdjudicationCandidate(expectation, settings)) continue;
    const payload: AdjudicationJobPayload = { expectationId: expectation.id };
    await stores.jobs.enqueue(input.clinicId, {
      type: ADJUDICATION_JOB,
      payload: { ...payload },
      dedupKey: `${ADJUDICATION_JOB}:${expectation.id}`,
      maxAttempts: ADJUDICATION_MAX_ATTEMPTS,
    });
    queued += 1;
  }
  return queued;
}

/** Why an expectation was not adjudicated. */
export type AdjudicationSkipReason =
  'off' | 'no_provider' | 'not_found' | 'not_candidate' | 'note_missing';

export type AdjudicationOutcome =
  | { readonly status: 'decided'; readonly adjudication: Adjudication; readonly created: boolean }
  | { readonly status: 'skipped'; readonly reason: AdjudicationSkipReason };

export interface AdjudicationOverrideResult {
  readonly adjudication: Adjudication;
  readonly expectation: Expectation;
  readonly casesResolved: readonly CaseId[];
}

export interface ExpectationAdjudication {
  /** Handler of {@link ADJUDICATION_JOB}. Throws on a provider failure (the job retries). */
  runJob(
    clinicId: ClinicId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<AdjudicationOutcome>;
  /** Decides one expectation now (idempotent: a stored decision is returned as is). */
  adjudicate(clinicId: ClinicId, expectationId: ExpectationId): Promise<AdjudicationOutcome>;
  /**
   * Decides up to `limit` undecided candidates of the clinic, patient by
   * patient (seeds, a clinic switching the adjudicator on over its history).
   */
  adjudicatePending(
    clinicId: ClinicId,
    options?: { readonly limit?: number; readonly patientIds?: readonly PatientId[] },
  ): Promise<readonly Adjudication[]>;
  list(clinicId: ClinicId, query?: AdjudicationListQuery): Promise<readonly Adjudication[]>;
  /** The decisions on a case's reasons. Throws `NotFoundError` for an unknown case. */
  forCase(clinicId: ClinicId, caseId: CaseId): Promise<readonly Adjudication[]>;
  get(clinicId: ClinicId, id: string): Promise<Adjudication | undefined>;
  /**
   * The doctor's word over the adjudicator's: `open` keeps (or restores) the
   * item and confirms it, `discard` rejects it (cancelled, its case resolved
   * when nothing else is pending). Applies in any mode. Throws
   * `ConflictError` when the decision was already overridden.
   */
  override(
    clinicId: ClinicId,
    id: string,
    input: {
      readonly decision: AdjudicationOverrideDecision;
      readonly userId: string;
      readonly note?: string;
    },
  ): Promise<AdjudicationOverrideResult>;
  /** The clinic's adjudicator settings with defaults filled in. */
  settings(clinicId: ClinicId): Promise<ResolvedAdjudicatorSettings>;
}

export interface ExpectationAdjudicationDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clinics: ClinicDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Absent: nothing is decided (the items keep being followed up as they are). */
  readonly adjudicator?: ExpectationAdjudicator;
  /** The patient's names and identifiers to mask before anything reaches a model. */
  readonly redactTermsOf?: (patient: FhirResourceJson) => readonly string[];
}

interface Context {
  /** The decision's id, minted before the call (its tail is the item's pseudonym). */
  readonly id: string;
  readonly expectation: Expectation;
  readonly input: AdjudicationInput;
  readonly redactTerms: readonly string[];
  readonly noteText: string;
}

function significantChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function parsePayload(payload: Readonly<Record<string, unknown>>): AdjudicationJobPayload {
  const { expectationId } = payload;
  if (typeof expectationId !== 'string' || expectationId === '') {
    throw new ValidationError('payload', `Invalid ${ADJUDICATION_JOB} payload`);
  }
  return { expectationId };
}

/** The plan item an expectation was read from: same quote, else same kind. */
function sourceItem(
  expectation: Expectation,
  plan: PlanExtractedEvent | undefined,
): PlanItem | undefined {
  const quote = expectation.evidence?.quote;
  const items = plan?.items ?? [];
  return (
    items.find((item) => item.evidenceQuote === quote) ??
    items.find((item) => item.kind === kindOfMatchKey(expectation.matchKey))
  );
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function trimRationale(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_RATIONALE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_RATIONALE_CHARS - 1)}…`;
}

/**
 * The engine's checks over the model's answer: quotes must be in the note
 * verbatim (none left: `needs_human`, `no_verifiable_quote`), and the
 * probability must back the decision (`open` at or above
 * `minOpenProbability`, `discard` at or below `maxDiscardProbability`, else
 * `needs_human`, `low_probability`). Unknown reason codes are dropped.
 */
export function checkDecision(
  result: Pick<AdjudicationProviderResult, 'decision' | 'probability' | 'reasonCodes' | 'quotes'>,
  noteText: string,
  sourceDocumentId: string,
  settings: Pick<ResolvedAdjudicatorSettings, 'minOpenProbability' | 'maxDiscardProbability'>,
): {
  readonly decision: AdjudicationDecision;
  readonly probability: number;
  readonly reasonCodes: readonly AdjudicationReasonCode[];
  readonly quotes: readonly Evidence[];
} {
  const probability = clampProbability(result.probability);
  const quotes: Evidence[] = [];
  for (const quote of result.quotes) {
    if (significantChars(quote) < MIN_QUOTE_SIGNIFICANT_CHARS) continue;
    const located = locateVerbatim(noteText, quote);
    if (located === undefined || quotes.some((item) => item.quote === located)) continue;
    quotes.push({ quote: located, sourceDocumentId });
    if (quotes.length >= MAX_QUOTES) break;
  }
  const codes = new Set<AdjudicationReasonCode>(
    result.reasonCodes.filter((code): code is AdjudicationReasonCode =>
      (ADJUDICATION_REASON_CODES as readonly string[]).includes(code),
    ),
  );
  let decision = result.decision;
  if (quotes.length === 0) {
    decision = 'needs_human';
    codes.add('no_verifiable_quote');
  } else if (decision === 'open' && probability < settings.minOpenProbability) {
    decision = 'needs_human';
    codes.add('low_probability');
  } else if (decision === 'discard' && probability > settings.maxDiscardProbability) {
    decision = 'needs_human';
    codes.add('low_probability');
  }
  if (codes.size === 0) codes.add('insufficient_context');
  return { decision, probability, reasonCodes: [...codes], quotes };
}

/**
 * The adjudicator (PRD V2, workstream E): decides ambiguous plan items, one
 * expectation at a time, behind the clinic's flag (`ClinicSettings.adjudicator`).
 * The model is called outside any transaction; the decision, its effect and
 * its audit (the case event, actor `adjudicator`, with model, prompt version
 * and cost) commit together. In `shadow` mode nothing changes; in `active`
 * mode `discard` suppresses the expectation. A doctor can override any
 * decision. Decisions are suggestions to the clinical team only: nothing
 * here reaches the patient.
 */
export function createExpectationAdjudication(
  deps: ExpectationAdjudicationDeps,
): ExpectationAdjudication {
  async function settingsOf(clinicId: ClinicId): Promise<ResolvedAdjudicatorSettings> {
    return resolveAdjudicatorSettings((await deps.clinics.get(clinicId))?.settings.adjudicator);
  }

  async function caseOf(
    stores: TransactionalStores,
    clinicId: ClinicId,
    caseId: CaseId | undefined,
  ): Promise<FollowUpCase | undefined> {
    if (caseId === undefined) return undefined;
    const found = await stores.cases.get(clinicId, caseId, { forUpdate: true });
    return found !== undefined && isActiveCaseStatus(found.status) ? found : undefined;
  }

  async function auditCase(
    stores: TransactionalStores,
    clinicId: ClinicId,
    followUpCase: FollowUpCase | undefined,
    type: CaseEventType,
    actor: CaseEventActor,
    at: Date,
    payload: JsonObject,
  ): Promise<void> {
    if (followUpCase === undefined) return;
    await new CaseWriter(stores, deps.ids, clinicId).audit(followUpCase, type, actor, at, payload);
  }

  /** What the model reads: the item, its note and the plan around it. */
  async function contextOf(
    stores: TransactionalStores,
    clinicId: ClinicId,
    expectation: Expectation,
  ): Promise<Context | undefined> {
    const documentId = expectation.evidence?.sourceDocumentId;
    if (documentId === undefined) return undefined;
    const events = await stores.clinicalRecords.listEventsForPatient(
      clinicId,
      expectation.patientId,
      { types: ['note.received', 'plan.extracted'] },
    );
    const note = events
      .filter(
        (event): event is NoteReceivedEvent =>
          event.type === 'note.received' && event.documentId === documentId,
      )
      .at(-1);
    if (note === undefined) return undefined;
    const plan = events
      .filter(
        (event): event is PlanExtractedEvent =>
          event.type === 'plan.extracted' && event.sourceDocumentId === documentId,
      )
      .at(-1);
    const item = sourceItem(expectation, plan);
    const patient = await stores.clinicalRecords.getResource(clinicId, {
      resourceType: 'Patient',
      id: expectation.patientId,
    });
    const id = deps.ids.next('adjudication');
    const input: AdjudicationInput = {
      itemRef: `ITEM-${id.replace(/[^a-z0-9]/gi, '').slice(-8)}`,
      kind: kindOfMatchKey(expectation.matchKey),
      ...(item === undefined ? {} : { description: item.description }),
      evidenceQuote: expectation.evidence?.quote ?? '',
      extractionConfidence: expectation.confidence ?? 0,
      noteDate: dateKey(note.authoredAt),
      dueInDays: Math.round((expectation.dueAt.getTime() - note.authoredAt.getTime()) / MS_PER_DAY),
      ...(note.specialty === undefined ? {} : { specialty: note.specialty }),
      otherPlanItems: (plan?.items ?? [])
        .filter((other) => other !== item)
        .slice(0, 8)
        .map((other) => ({ kind: other.kind, description: other.description.slice(0, 120) })),
      noteText: note.text,
    };
    return {
      id,
      expectation,
      input,
      redactTerms: patient === undefined ? [] : (deps.redactTermsOf?.(patient.resource) ?? []),
      noteText: note.text,
    };
  }

  async function adjudicate(
    clinicId: ClinicId,
    expectationId: ExpectationId,
  ): Promise<AdjudicationOutcome> {
    const settings = await settingsOf(clinicId);
    if (settings.mode === 'off') return { status: 'skipped', reason: 'off' };
    if (deps.adjudicator === undefined) return { status: 'skipped', reason: 'no_provider' };
    const prepared = await deps.unitOfWork.withTransaction(
      clinicId,
      async (stores): Promise<AdjudicationOutcome | Context> => {
        const existing = await stores.adjudications.forExpectation(clinicId, expectationId);
        if (existing !== undefined) {
          return { status: 'decided', adjudication: existing, created: false };
        }
        const expectation = await stores.expectations.get(clinicId, expectationId);
        if (expectation === undefined) return { status: 'skipped', reason: 'not_found' };
        if (!isAdjudicationCandidate(expectation, settings)) {
          return { status: 'skipped', reason: 'not_candidate' };
        }
        return (
          (await contextOf(stores, clinicId, expectation)) ?? {
            status: 'skipped',
            reason: 'note_missing',
          }
        );
      },
    );
    if ('status' in prepared) return prepared;

    // The model is called outside any transaction: no lock is held while it thinks.
    const result = await deps.adjudicator.decide(clinicId, {
      input: prepared.input,
      redactTerms: prepared.redactTerms,
    });
    const sourceDocumentId = prepared.expectation.evidence?.sourceDocumentId ?? '';
    const checked = checkDecision(result, prepared.noteText, sourceDocumentId, settings);

    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const now = deps.clock.now();
      const existing = await stores.adjudications.forExpectation(clinicId, expectationId);
      if (existing !== undefined) {
        return { status: 'decided', adjudication: existing, created: false };
      }
      const first = await stores.expectations.get(clinicId, expectationId);
      if (first === undefined) return { status: 'skipped', reason: 'not_found' };
      const followUpCase = await caseOf(stores, clinicId, first.caseId);
      // Read again under the case lock: a doctor may have reviewed it meanwhile.
      const expectation = (await stores.expectations.get(clinicId, expectationId)) ?? first;
      const stillCandidate = isAdjudicationCandidate(expectation, settings);
      const apply = settings.mode === 'active' && checked.decision === 'discard' && stillCandidate;
      const actor: CaseEventActor = {
        type: 'adjudicator',
        id: `${result.provider}:${result.model}`,
      };
      if (apply) {
        await closeExpectation(stores, expectation, 'cancelled', DISCARDED_BY_ADJUDICATOR, now);
      }
      const adjudication: Adjudication = {
        id: prepared.id,
        clinicId,
        patientId: expectation.patientId,
        expectationId: expectation.id,
        ...(expectation.caseId === undefined ? {} : { caseId: expectation.caseId }),
        decision: checked.decision,
        modelDecision: result.decision,
        probability: checked.probability,
        reasonCodes: checked.reasonCodes,
        rationale: {
          en: trimRationale(result.rationale.en),
          es: trimRationale(result.rationale.es),
        },
        quotes: checked.quotes,
        inputConfidence: expectation.confidence ?? 0,
        mode: settings.mode === 'active' ? 'active' : 'shadow',
        applied: apply,
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        createdAt: now,
      };
      await stores.adjudications.create(clinicId, adjudication);
      await auditCase(stores, clinicId, followUpCase, 'adjudicated', actor, now, {
        adjudicationId: adjudication.id,
        expectationId: expectation.id,
        decision: adjudication.decision,
        modelDecision: adjudication.modelDecision,
        probability: adjudication.probability,
        reasonCodes: [...adjudication.reasonCodes],
        mode: adjudication.mode,
        applied: adjudication.applied,
        model: actor.id ?? '',
        promptVersion: adjudication.promptVersion,
        costUsd: adjudication.costUsd,
      });
      if (apply && followUpCase !== undefined) {
        await resolveSatisfiedCases({
          stores,
          writer: new CaseWriter(stores, deps.ids, clinicId),
          clinicId,
          caseIds: [followUpCase.id],
          actor,
          now,
        });
      }
      return { status: 'decided', adjudication, created: true };
    });
  }

  async function reviewEntry(
    stores: TransactionalStores,
    input: {
      readonly clinicId: ClinicId;
      readonly type: PlanItemReviewType;
      readonly expectation: Expectation;
      readonly userId: string;
      readonly now: Date;
    },
  ): Promise<void> {
    await stores.planItemReviews.append(input.clinicId, {
      id: deps.ids.next('plan_item_review'),
      clinicId: input.clinicId,
      patientId: input.expectation.patientId,
      expectationId: input.expectation.id,
      type: input.type,
      userId: input.userId,
      at: input.now,
      ...(input.expectation.caseId === undefined ? {} : { caseId: input.expectation.caseId }),
      before: planItemReading(input.expectation),
    });
  }

  return {
    async runJob(clinicId, payload) {
      const { expectationId } = parsePayload(payload);
      return adjudicate(clinicId, toExpectationId(expectationId));
    },

    adjudicate,

    async adjudicatePending(clinicId, options = {}) {
      const limit = options.limit ?? 20;
      const settings = await settingsOf(clinicId);
      if (settings.mode === 'off' || deps.adjudicator === undefined) return [];
      const decided: Adjudication[] = [];
      const patients: PatientId[] = [...(options.patientIds ?? [])];
      if (options.patientIds === undefined) {
        let after: PatientId | undefined;
        do {
          const page = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
            stores.clinicalRecords.listPatientIds(clinicId, {
              limit: 500,
              ...(after === undefined ? {} : { after }),
            }),
          );
          patients.push(...page.patientIds);
          after = page.next;
        } while (after !== undefined);
      }
      for (const patientId of patients) {
        if (decided.length >= limit) break;
        const candidates = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
          const live = await stores.expectations.listByPatient(clinicId, patientId, [
            'open',
            'expired',
          ]);
          const undecided: Expectation[] = [];
          for (const expectation of live) {
            if (!isAdjudicationCandidate(expectation, settings)) continue;
            if ((await stores.adjudications.forExpectation(clinicId, expectation.id)) !== undefined)
              continue;
            undecided.push(expectation);
          }
          return undecided;
        });
        for (const expectation of candidates) {
          if (decided.length >= limit) break;
          const outcome = await adjudicate(clinicId, expectation.id);
          if (outcome.status === 'decided' && outcome.created) decided.push(outcome.adjudication);
        }
      }
      return decided;
    },

    list: (clinicId, query) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.adjudications.list(clinicId, query),
      ),

    forCase: (clinicId, caseId) =>
      deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const followUpCase = await stores.cases.get(clinicId, caseId);
        if (followUpCase === undefined) throw new NotFoundError('FollowUpCase', caseId);
        const ids = followUpCase.reasons.map((reason) => reason.expectationId);
        // Decided while the expectation was still open (before its case existed) count too.
        return stores.adjudications.list(clinicId, { expectationIds: ids, limit: 200 });
      }),

    get: (clinicId, id) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) => stores.adjudications.get(clinicId, id)),

    async override(clinicId, id, input) {
      const userId = input.userId.trim();
      if (userId === '') {
        throw new ValidationError('userId', 'A clinician id is required to override a decision');
      }
      const note = input.note?.trim();
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const adjudication = await stores.adjudications.get(clinicId, id);
        if (adjudication === undefined) throw new NotFoundError('Adjudication', id);
        if (adjudication.override !== undefined)
          throw new ConflictError('AdjudicationOverride', id);
        const first = await stores.expectations.get(clinicId, adjudication.expectationId);
        if (first === undefined) throw new NotFoundError('Expectation', adjudication.expectationId);
        const followUpCase = await caseOf(stores, clinicId, first.caseId);
        let expectation = (await stores.expectations.get(clinicId, first.id)) ?? first;
        const userActor: CaseEventActor = { type: 'user', id: userId };
        let casesResolved: CaseId[] = [];
        const live = expectation.status === 'open' || expectation.status === 'expired';
        if (input.decision === 'open') {
          if (
            expectation.status === 'cancelled' &&
            expectation.closedReason === DISCARDED_BY_ADJUDICATOR
          ) {
            // Back in play; if already due, the next watcher sweep opens its case.
            expectation = { ...reopened(expectation, now), confirmedBy: userId, confirmedAt: now };
            await stores.expectations.update(clinicId, expectation);
            await reviewEntry(stores, {
              clinicId,
              type: 'plan_item_confirmed',
              expectation,
              userId,
              now,
            });
          } else if (live && expectation.confirmedBy === undefined) {
            expectation = { ...expectation, confirmedBy: userId, confirmedAt: now, updatedAt: now };
            await stores.expectations.update(clinicId, expectation);
            await reviewEntry(stores, {
              clinicId,
              type: 'plan_item_confirmed',
              expectation,
              userId,
              now,
            });
          }
        } else if (live) {
          expectation = await closeExpectation(
            stores,
            expectation,
            'cancelled',
            REJECTED_BY_CLINICIAN,
            now,
          );
          await reviewEntry(stores, {
            clinicId,
            type: 'plan_item_rejected',
            expectation,
            userId,
            now,
          });
        }
        const updated = await stores.adjudications.setOverride(clinicId, id, {
          decision: input.decision,
          userId,
          at: now,
          ...(note === undefined || note === '' ? {} : { note }),
        });
        await auditCase(stores, clinicId, followUpCase, 'adjudication_overridden', userActor, now, {
          adjudicationId: id,
          expectationId: expectation.id,
          decision: adjudication.decision,
          override: input.decision,
          ...(note === undefined || note === '' ? {} : { note }),
        });
        if (input.decision === 'discard' && followUpCase !== undefined) {
          casesResolved = await resolveSatisfiedCases({
            stores,
            writer: new CaseWriter(stores, deps.ids, clinicId),
            clinicId,
            caseIds: [followUpCase.id],
            actor: userActor,
            now,
          });
        }
        return { adjudication: updated, expectation, casesResolved };
      });
    },

    settings: settingsOf,
  };
}
