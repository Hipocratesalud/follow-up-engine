import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import { PLAN_ITEM_KINDS, type PlanItemKind } from '../../domain/clinical-event.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { Expectation } from '../../domain/expectation.ts';
import {
  type CaseId,
  type ClinicId,
  type ExpectationId,
  expectationId as toExpectationId,
} from '../../domain/ids.ts';
import {
  CORRECTED_BY_CLINICIAN,
  type PlanItemReading,
  type PlanItemReview,
  type PlanItemReviewType,
  REJECTED_BY_CLINICIAN,
} from '../../domain/plan-item-review.ts';
import type { Clock } from '../../ports/clock.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { currentFulfillment, recheckAtFor } from '../annotator/recheck.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { closeExpectation, resolveSatisfiedCases } from '../case-manager/reconcile.ts';
import { isActiveCaseStatus } from '../case-manager/state-machine.ts';
import type { Catalog } from '../catalog.ts';
import { fulfillmentReason, toCorrelationTarget } from '../matching/correlation.ts';
import { kindOfMatchKey, matchKeyFor, parseCodeMatchKey } from '../matching/match-key.ts';
import { PatientTimeline } from '../timeline.ts';
import type { EngineSettings } from '../settings.ts';

/**
 * Why a plan item cannot take a review: a clinician already corrected or
 * rejected it (`already_reviewed`), or the engine already closed it
 * (`closed`: fulfilled, superseded, cancelled) so there is nothing left to
 * correct or reject. HTTP 409.
 */
export class PlanItemReviewConflictError extends Error {
  override readonly name = 'PlanItemReviewConflictError';
  readonly expectationId: ExpectationId;
  readonly reason: 'already_reviewed' | 'closed';

  constructor(expectationId: ExpectationId, reason: 'already_reviewed' | 'closed') {
    super(`Plan item ${expectationId} cannot be reviewed: ${reason}`);
    this.expectationId = expectationId;
    this.reason = reason;
  }
}

/** What a clinician changes in a plan item: its date, its kind, or both. */
export interface PlanItemCorrection {
  readonly dueAt?: Date;
  readonly kind?: PlanItemKind;
}

export interface PlanItemReviewResult {
  /** The reviewed expectation, as stored after the command. */
  readonly expectation: Expectation;
  /** `correct` only: the corrected expectation that replaced it. */
  readonly replacement?: Expectation;
  /** The audit entry; absent when the item was already confirmed (a repeated confirm changes nothing). */
  readonly review?: PlanItemReview;
  /** Cases resolved because the item was their last unmet reason. */
  readonly casesResolved: readonly CaseId[];
}

/**
 * One-click review of what the AI read from a note (HIP-141): the clinician
 * confirms a plan item, corrects its date or kind, or rejects it. Only
 * `doctor_plan` expectations; each verdict is audited (`PlanItemReviewLog`,
 * plus the case's audit log when the item belongs to a case) in the same
 * transaction as its effect.
 */
export interface PlanItemCommands {
  /**
   * Marks the item `confirmedBy` the clinician. Any status (a fulfilled
   * item's reading can still be confirmed) except one a clinician already
   * corrected or rejected. Confirming again changes nothing.
   */
  confirm(
    clinicId: ClinicId,
    expectationId: ExpectationId,
    userId: string,
  ): Promise<PlanItemReviewResult>;
  /**
   * Supersedes a live (open or overdue) item with a corrected one
   * (`corrected_by_clinician`): same source and evidence, the clinician's
   * date and kind, confirmed by them. The correction is decided against the
   * record at once (a visit that already took place fulfills a corrected
   * "control visit"). Overdue in an active case, it takes the old item's
   * place in that case; otherwise the case resolves if nothing else is
   * pending, and the corrected item expires into a case when due.
   */
  correct(
    clinicId: ClinicId,
    expectationId: ExpectationId,
    correction: PlanItemCorrection,
    userId: string,
  ): Promise<PlanItemReviewResult>;
  /**
   * Cancels a live item (`rejected_by_clinician`): the note never asked for
   * it. A case left without unmet reasons resolves (`not_needed`).
   */
  reject(
    clinicId: ClinicId,
    expectationId: ExpectationId,
    userId: string,
  ): Promise<PlanItemReviewResult>;
}

export interface PlanItemCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

/** What the AI read: the kind (from the match key, as fulfillment reads it) and the date. */
export function planItemReading(expectation: Expectation): PlanItemReading {
  return { kind: kindOfMatchKey(expectation.matchKey), dueAt: expectation.dueAt };
}

/** Whether a clinician already closed the item by correcting or rejecting it. */
export function isClosedByClinician(expectation: Expectation): boolean {
  return (
    expectation.closedReason === CORRECTED_BY_CLINICIAN ||
    expectation.closedReason === REJECTED_BY_CLINICIAN
  );
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function createPlanItemCommands(deps: PlanItemCommandDeps): PlanItemCommands {
  function requireUser(userId: string): void {
    if (userId.trim().length === 0) {
      throw new ValidationError('userId', 'A clinician id is required to review a plan item');
    }
  }

  /**
   * The plan item and its active case, the case locked first (the order
   * every case command takes): a concurrent command on the case waits.
   */
  async function load(
    stores: TransactionalStores,
    clinicId: ClinicId,
    id: ExpectationId,
  ): Promise<{ expectation: Expectation; activeCase?: FollowUpCase }> {
    const first = await stores.expectations.get(clinicId, id);
    if (first === undefined) {
      throw new NotFoundError('Expectation', id);
    }
    if (first.layer !== 'doctor_plan') {
      throw new ValidationError(
        'layer',
        'Only a plan item the AI read from a note can be confirmed, corrected or rejected',
      );
    }
    const followUpCase =
      first.caseId === undefined
        ? undefined
        : await stores.cases.get(clinicId, first.caseId, { forUpdate: true });
    // Read again under the case lock: another command may have changed it.
    const expectation = (await stores.expectations.get(clinicId, id)) ?? first;
    return {
      expectation,
      ...(followUpCase !== undefined && isActiveCaseStatus(followUpCase.status)
        ? { activeCase: followUpCase }
        : {}),
    };
  }

  async function audit(
    stores: TransactionalStores,
    input: {
      readonly clinicId: ClinicId;
      readonly type: PlanItemReviewType;
      readonly expectation: Expectation;
      readonly userId: string;
      readonly now: Date;
      readonly activeCase?: FollowUpCase;
      readonly replacement?: Expectation;
    },
  ): Promise<PlanItemReview> {
    const { expectation, replacement, activeCase } = input;
    const review: PlanItemReview = {
      id: deps.ids.next('plan_item_review'),
      clinicId: input.clinicId,
      patientId: expectation.patientId,
      expectationId: expectation.id,
      type: input.type,
      userId: input.userId,
      at: input.now,
      ...(expectation.caseId === undefined ? {} : { caseId: expectation.caseId }),
      before: planItemReading(expectation),
      ...(replacement === undefined
        ? {}
        : { after: planItemReading(replacement), replacementId: replacement.id }),
    };
    await stores.planItemReviews.append(input.clinicId, review);
    if (activeCase !== undefined) {
      const actor: CaseEventActor = { type: 'user', id: input.userId };
      await new CaseWriter(stores, deps.ids, input.clinicId).audit(
        activeCase,
        input.type,
        actor,
        input.now,
        {
          expectationId: expectation.id,
          ruleId: expectation.ruleId,
          kind: review.before.kind,
          dueAt: review.before.dueAt.toISOString(),
          ...(review.after === undefined || replacement === undefined
            ? {}
            : {
                replacementId: replacement.id,
                correctedKind: review.after.kind,
                correctedDueAt: review.after.dueAt.toISOString(),
              }),
        },
      );
    }
    return review;
  }

  function requireLive(expectation: Expectation): void {
    if (isClosedByClinician(expectation)) {
      throw new PlanItemReviewConflictError(expectation.id, 'already_reviewed');
    }
    if (expectation.status !== 'open' && expectation.status !== 'expired') {
      throw new PlanItemReviewConflictError(expectation.id, 'closed');
    }
  }

  /** The corrected item, before deciding it against the record. */
  function corrected(
    expectation: Expectation,
    reading: PlanItemReading,
    userId: string,
    now: Date,
  ): Mutable<Expectation> {
    const unchangedKind = reading.kind === kindOfMatchKey(expectation.matchKey);
    const next: Mutable<Expectation> = {
      ...expectation,
      id: toExpectationId(deps.ids.next('expectation')),
      // Unique per corrected item: correcting a correction chains the keys.
      idempotencyKey: `${expectation.idempotencyKey}#corrected:${expectation.id}`,
      matchKey: unchangedKind
        ? expectation.matchKey
        : matchKeyFor(reading.kind, parseCodeMatchKey(expectation.matchKey)),
      dueAt: reading.dueAt,
      status: 'open',
      confirmedBy: userId,
      confirmedAt: now,
      correctionOf: expectation.id,
      createdAt: now,
      updatedAt: now,
    };
    delete next.caseId;
    delete next.closedReason;
    delete next.closedAt;
    delete next.closedBy;
    delete next.recheckAt;
    return next;
  }

  return {
    async confirm(clinicId, id, userId) {
      requireUser(userId);
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const { expectation, activeCase } = await load(stores, clinicId, id);
        if (isClosedByClinician(expectation)) {
          throw new PlanItemReviewConflictError(expectation.id, 'already_reviewed');
        }
        if (expectation.confirmedBy !== undefined) {
          return { expectation, casesResolved: [] };
        }
        const confirmed: Expectation = {
          ...expectation,
          confirmedBy: userId,
          confirmedAt: now,
          updatedAt: now,
        };
        await stores.expectations.update(clinicId, confirmed);
        const review = await audit(stores, {
          clinicId,
          type: 'plan_item_confirmed',
          expectation,
          userId,
          now,
          ...(activeCase === undefined ? {} : { activeCase }),
        });
        return { expectation: confirmed, review, casesResolved: [] };
      });
    },

    async correct(clinicId, id, correction, userId) {
      requireUser(userId);
      if (correction.kind !== undefined && !PLAN_ITEM_KINDS.includes(correction.kind)) {
        throw new ValidationError('kind', `Unknown plan item kind ${correction.kind}`);
      }
      if (correction.dueAt !== undefined && Number.isNaN(correction.dueAt.getTime())) {
        throw new ValidationError('dueAt', 'The corrected due date is not a valid date');
      }
      const catalog = await deps.loadCatalog(clinicId);
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const { expectation, activeCase } = await load(stores, clinicId, id);
        requireLive(expectation);
        const before = planItemReading(expectation);
        const reading: PlanItemReading = {
          kind: correction.kind ?? before.kind,
          dueAt: correction.dueAt ?? before.dueAt,
        };
        if (reading.kind === before.kind && reading.dueAt.getTime() === before.dueAt.getTime()) {
          throw new ValidationError(
            'correction',
            'A correction must change the due date or the kind of the plan item',
          );
        }
        const superseded = await closeExpectation(
          stores,
          expectation,
          'superseded',
          CORRECTED_BY_CLINICIAN,
          now,
        );
        let replacement = corrected(expectation, reading, userId, now);
        // Decided against the record at once, as an annotation would: a visit
        // (or result) that already took place after the note fulfills it.
        const definition = catalog.definition(replacement.ruleId);
        if (definition !== undefined) {
          const timeline = new PatientTimeline(
            await stores.clinicalRecords.listEventsForPatient(clinicId, expectation.patientId),
          );
          const event = currentFulfillment(
            toCorrelationTarget(replacement, definition, timeline, {
              now,
              bookingGraceDays: deps.settings.bookingVisitGraceDays,
            }),
            timeline,
          );
          if (event !== undefined) {
            const recheckAt = recheckAtFor(event, deps.settings.bookingVisitGraceDays);
            replacement = {
              ...replacement,
              status: 'fulfilled',
              closedReason: fulfillmentReason(event),
              closedAt: now,
              closedBy: event.source,
              ...(recheckAt === undefined ? {} : { recheckAt }),
            };
          }
        }
        // Still overdue in an active case: it takes the old item's place there.
        const joinsCase =
          activeCase !== undefined &&
          replacement.status === 'open' &&
          reading.dueAt.getTime() <= now.getTime();
        if (joinsCase) {
          replacement = { ...replacement, status: 'expired', caseId: activeCase.id };
        }
        await stores.expectations.upsertByIdempotencyKey(clinicId, replacement);
        let current = activeCase;
        if (joinsCase) {
          current = {
            ...activeCase,
            reasons: [
              ...activeCase.reasons,
              { expectationId: replacement.id, reasonCode: replacement.reason.code },
            ],
            updatedAt: now,
          };
          await stores.cases.update(clinicId, current);
        }
        const review = await audit(stores, {
          clinicId,
          type: 'plan_item_corrected',
          expectation,
          userId,
          now,
          replacement,
          ...(current === undefined ? {} : { activeCase: current }),
        });
        const casesResolved =
          activeCase === undefined || joinsCase
            ? []
            : await resolveSatisfiedCases({
                stores,
                writer: new CaseWriter(stores, deps.ids, clinicId),
                clinicId,
                caseIds: [activeCase.id],
                actor: { type: 'user', id: userId },
                now,
              });
        return { expectation: superseded, replacement, review, casesResolved };
      });
    },

    async reject(clinicId, id, userId) {
      requireUser(userId);
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const { expectation, activeCase } = await load(stores, clinicId, id);
        requireLive(expectation);
        const cancelled = await closeExpectation(
          stores,
          expectation,
          'cancelled',
          REJECTED_BY_CLINICIAN,
          now,
        );
        const review = await audit(stores, {
          clinicId,
          type: 'plan_item_rejected',
          expectation,
          userId,
          now,
          ...(activeCase === undefined ? {} : { activeCase }),
        });
        const casesResolved =
          activeCase === undefined
            ? []
            : await resolveSatisfiedCases({
                stores,
                writer: new CaseWriter(stores, deps.ids, clinicId),
                clinicId,
                caseIds: [activeCase.id],
                actor: { type: 'user', id: userId },
                now,
              });
        return { expectation: cancelled, review, casesResolved };
      });
    },
  };
}
