import type { AppointmentOriginType } from '../../domain/attribution.ts';
import {
  CASE_FEEDBACK_REASONS,
  type CaseEvent,
  type CaseFeedback,
  type CaseFeedbackReason,
  type CaseStatus,
  type FollowUpCase,
} from '../../domain/case.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { DISMISS_REASONS, type DismissReason } from '../../domain/contact.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import { PLAN_ITEM_REVIEW_TYPES, type PlanItemReviewType } from '../../domain/plan-item-review.ts';
import type {
  LlmTaskUsage,
  MetricsPeriod,
  NoteExtractionCost,
  PlanItemReviewEntry,
  ReviewRunTotals,
} from '../../ports/metrics-read-model.ts';
import { isActiveCaseStatus } from '../case-manager/state-machine.ts';

/*
 * Clinic metrics (HIP-141), computed purely from what the read model loads.
 * Every number is defined in docs/metrics.md; the definitions are repeated
 * on the fields below. Two kinds of numbers:
 *
 * - Cohort numbers follow the cases that reached the inbox in the period
 *   (opened there, or released there for a held backfill case) and count
 *   what happened to them up to `asOf`, whenever it happened.
 * - Activity numbers count what happened in the period itself: LLM calls
 *   and their cost, clinical review runs, clinicians' reviews of what the
 *   engine read from notes.
 */

/** A count split by where the booking came from. */
export interface OriginSplit {
  readonly total: number;
  readonly followUpCase: number;
  readonly patientContact: number;
  readonly organic: number;
}

/** Distribution of a duration over the cases that have one. */
export interface DurationDistribution {
  /** Cases with a first action. */
  readonly measured: number;
  /** Cases of the cohort still without one at `asOf`. */
  readonly pending: number;
  readonly medianHours?: number;
  readonly p75Hours?: number;
  readonly p90Hours?: number;
}

export interface CaseCohortMetrics {
  /** Cases that reached the inbox in the period. */
  readonly opened: number;
  readonly live: number;
  readonly backfill: number;
  /** Status at `asOf`. */
  readonly active: number;
  readonly resolved: number;
  readonly dismissed: number;
  readonly lostToFollowUp: number;
}

export interface BookingMetrics {
  /** Cohort cases with at least one booking recorded on them (`appointment_booked`). */
  readonly booked: OriginSplit;
  /** Cohort cases with at least one booking kept (`appointment_attended`). */
  readonly attended: OriginSplit;
  /** Cohort cases resolved (`fulfilled`) by a booking; an unattributed one is `organic`. */
  readonly resolvedByBooking: OriginSplit;
  /** `booked.total / opened`; absent without cases. */
  readonly bookedRate?: number;
  /** `attended.total / booked.total`; absent without bookings. */
  readonly attendedRate?: number;
  /** `(booked.followUpCase + booked.patientContact) / booked.total`. */
  readonly attributedShare?: number;
}

export interface FeedbackMetrics {
  /** Cohort cases with a verdict (the latest per case counts, as in the calibration report). */
  readonly casesWithFeedback: number;
  readonly useful: number;
  readonly notUseful: number;
  /** `useful / casesWithFeedback`. */
  readonly usefulRate?: number;
  readonly notUsefulReasons: Readonly<Record<CaseFeedbackReason, number>>;
}

export interface DismissalMetrics {
  /** Cohort cases dismissed by the team ("Descartar"). */
  readonly total: number;
  readonly byReason: Readonly<Record<DismissReason, number>>;
}

export interface ConditionReviewMetrics {
  /** Conditions read from notes that a clinician reviewed in the period. */
  readonly reviewed: number;
  readonly confirmed: number;
  readonly rejected: number;
  /** Read from notes and still waiting for a clinician (probable, unreviewed), at `asOf`. */
  readonly pendingReview: number;
  /** `confirmed / reviewed`. */
  readonly confirmRate?: number;
  /** `rejected / reviewed`: the extractions the doctor corrected. */
  readonly rejectRate?: number;
}

export interface PlanItemReviewMetrics {
  readonly total: number;
  readonly confirmed: number;
  readonly corrected: number;
  readonly rejected: number;
  /** `(corrected + rejected) / total`. */
  readonly correctionRate?: number;
}

export interface AiCostMetrics {
  /** Every LLM call of the clinic in the period. */
  readonly totalUsd: number;
  readonly calls: number;
  /** By gateway task, task ascending. */
  readonly byTask: readonly LlmTaskUsage[];
  /** Extraction cost of the notes behind the cohort's cases, split evenly among those cases. */
  readonly attributedToCasesUsd: number;
  /** Cohort cases with a reason read from a note. */
  readonly casesWithAttributedCost: number;
  /** `attributedToCasesUsd / casesWithAttributedCost`. */
  readonly perCaseUsd?: number;
  /** `totalUsd / opened`: every call of the period, loaded onto the cases it produced. */
  readonly allInPerCaseUsd?: number;
  readonly reviewRuns: number;
  readonly reviewerUsd: number;
  /** `reviewerUsd / reviewRuns`. */
  readonly perReviewRunUsd?: number;
}

export interface BackfillMetrics {
  /** Cohort cases from the initial backfill (released to the inbox in the period). */
  readonly cases: number;
  /** Patients with a backfill case that resolved `fulfilled`: they came back. */
  readonly recoveredPatients: number;
  readonly recoveredCases: number;
}

export interface ClinicMetrics {
  readonly clinicId: ClinicId;
  readonly period: MetricsPeriod;
  readonly asOf: Date;
  readonly cases: CaseCohortMetrics;
  readonly bookings: BookingMetrics;
  /** From the case reaching the inbox to the first user action or contact request. */
  readonly timeToFirstAction: DurationDistribution;
  readonly feedback: FeedbackMetrics;
  readonly dismissals: DismissalMetrics;
  readonly extractionReviews: {
    readonly conditions: ConditionReviewMetrics;
    readonly planItems: PlanItemReviewMetrics;
  };
  readonly aiCost: AiCostMetrics;
  readonly backfill: BackfillMetrics;
}

/** Everything the computation reads, loaded through the `MetricsReadModel`. */
export interface MetricsInput {
  readonly clinicId: ClinicId;
  readonly period: MetricsPeriod;
  readonly asOf: Date;
  readonly cases: readonly FollowUpCase[];
  readonly events: readonly CaseEvent[];
  readonly feedback: readonly CaseFeedback[];
  readonly expectations: readonly Expectation[];
  readonly noteCosts: readonly NoteExtractionCost[];
  readonly conditions: readonly PatientCondition[];
  readonly planItemReviews: readonly PlanItemReviewEntry[];
  readonly llmUsage: readonly LlmTaskUsage[];
  readonly reviewRuns: ReviewRunTotals;
}

const HOUR_MS = 3_600_000;

/** When a case reached the inbox: its release for a held backfill case, else its creation. */
export function caseOpenedAt(followUpCase: FollowUpCase): Date {
  const { releaseAt, createdAt } = followUpCase;
  return releaseAt !== undefined && releaseAt.getTime() > createdAt.getTime()
    ? releaseAt
    : createdAt;
}

/** Whether `at` is in `[from, to)`. */
export function inPeriod(at: Date, period: MetricsPeriod): boolean {
  return at.getTime() >= period.from.getTime() && at.getTime() < period.to.getTime();
}

/**
 * The `p` quantile (0..1) of ascending `sorted`, interpolated linearly
 * between the closest ranks (R type 7, numpy's default). `undefined` when
 * empty.
 */
export function quantile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const low = sorted[lower] ?? 0;
  const high = sorted[Math.min(lower + 1, sorted.length - 1)] ?? low;
  return low + (h - lower) * (high - low);
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function round(value: number | undefined, digits: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Every property of `T`, optional ones allowed to be `undefined`. */
type Loose<T> = { readonly [K in keyof T]-?: T[K] | undefined };

/** Drops `undefined` values, so optional numbers are absent rather than undefined. */
function defined<T extends object>(value: Loose<T>): T {
  return Object.fromEntries(Object.entries(value).filter(([, inner]) => inner !== undefined)) as T;
}

const ORIGIN_RANK: Readonly<Record<AppointmentOriginType, number>> = {
  patient_contact: 3,
  follow_up_case: 2,
  organic: 1,
};

function originOf(value: unknown): AppointmentOriginType {
  return value === 'follow_up_case' || value === 'patient_contact' ? value : 'organic';
}

/** The strongest origin among a case's bookings: attributed beats organic. */
function strongest(origins: readonly AppointmentOriginType[]): AppointmentOriginType | undefined {
  return [...origins].sort((left, right) => ORIGIN_RANK[right] - ORIGIN_RANK[left])[0];
}

class SplitCounter {
  #followUpCase = 0;
  #patientContact = 0;
  #organic = 0;

  add(origin: AppointmentOriginType | undefined): void {
    if (origin === 'follow_up_case') {
      this.#followUpCase += 1;
    } else if (origin === 'patient_contact') {
      this.#patientContact += 1;
    } else if (origin === 'organic') {
      this.#organic += 1;
    }
  }

  get split(): OriginSplit {
    return {
      total: this.#followUpCase + this.#patientContact + this.#organic,
      followUpCase: this.#followUpCase,
      patientContact: this.#patientContact,
      organic: this.#organic,
    };
  }
}

function zeroed<TKey extends string>(keys: readonly TKey[]): Record<TKey, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<TKey, number>;
}

function eventsByCase(events: readonly CaseEvent[]): Map<CaseId, CaseEvent[]> {
  const byCase = new Map<CaseId, CaseEvent[]>();
  for (const event of events) {
    const list = byCase.get(event.caseId) ?? [];
    list.push(event);
    byCase.set(event.caseId, list);
  }
  for (const list of byCase.values()) {
    // Stable: events of the same instant keep the trail's order.
    list.sort((left, right) => left.at.getTime() - right.at.getTime());
  }
  return byCase;
}

/**
 * Whether an event is a first action on a case: anything a clinic user did
 * (assign, notify, snooze, call, resolve, dismiss, a verdict), or a request
 * to contact the patient, whoever asked for it (the escalation policy too).
 */
export function isFirstAction(event: CaseEvent): boolean {
  return event.actor.type === 'user' || event.type === 'patient_contact_requested';
}

function bookingMetrics(
  cases: readonly FollowUpCase[],
  byCase: ReadonlyMap<CaseId, readonly CaseEvent[]>,
): BookingMetrics {
  const booked = new SplitCounter();
  const attended = new SplitCounter();
  const resolvedByBooking = new SplitCounter();
  for (const followUpCase of cases) {
    const trail = byCase.get(followUpCase.id) ?? [];
    const bookings = trail.filter((event) => event.type === 'appointment_booked');
    booked.add(strongest(bookings.map((event) => originOf(event.payload['originType']))));
    attended.add(
      strongest(
        trail
          .filter((event) => event.type === 'appointment_attended')
          .map((event) => originOf(event.payload['originType'])),
      ),
    );
    if (followUpCase.status === 'resolved' && followUpCase.resolution?.kind === 'fulfilled') {
      // The booking the resolution names; else one that fulfilled a reason.
      const resolved = trail.findLast((event) => event.type === 'resolved');
      const named = resolved?.payload['appointmentOrigin'];
      const fulfilling = bookings.filter(
        (event) =>
          typeof event.payload['fulfilledReasons'] === 'number' &&
          event.payload['fulfilledReasons'] > 0,
      );
      resolvedByBooking.add(
        named === undefined
          ? strongest(fulfilling.map((event) => originOf(event.payload['originType'])))
          : originOf(named),
      );
    }
  }
  const bookedSplit = booked.split;
  const attendedSplit = attended.split;
  return defined<BookingMetrics>({
    booked: bookedSplit,
    attended: attendedSplit,
    resolvedByBooking: resolvedByBooking.split,
    bookedRate: ratio(bookedSplit.total, cases.length),
    attendedRate: ratio(attendedSplit.total, bookedSplit.total),
    attributedShare: ratio(
      bookedSplit.followUpCase + bookedSplit.patientContact,
      bookedSplit.total,
    ),
  });
}

function timeToFirstAction(
  cases: readonly FollowUpCase[],
  byCase: ReadonlyMap<CaseId, readonly CaseEvent[]>,
): DurationDistribution {
  const hours: number[] = [];
  let pending = 0;
  for (const followUpCase of cases) {
    const openedAt = caseOpenedAt(followUpCase).getTime();
    const first = (byCase.get(followUpCase.id) ?? []).find(isFirstAction);
    if (first === undefined) {
      pending += 1;
      continue;
    }
    hours.push(Math.max(0, first.at.getTime() - openedAt) / HOUR_MS);
  }
  hours.sort((left, right) => left - right);
  return defined<DurationDistribution>({
    measured: hours.length,
    pending,
    medianHours: round(quantile(hours, 0.5), 1),
    p75Hours: round(quantile(hours, 0.75), 1),
    p90Hours: round(quantile(hours, 0.9), 1),
  });
}

function feedbackMetrics(feedback: readonly CaseFeedback[]): FeedbackMetrics {
  // The latest verdict per case, like the calibration report and the inbox stats.
  const latest = new Map<CaseId, CaseFeedback>();
  for (const verdict of feedback) {
    latest.set(verdict.caseId, verdict);
  }
  const notUsefulReasons = zeroed(CASE_FEEDBACK_REASONS);
  let useful = 0;
  for (const verdict of latest.values()) {
    if (verdict.useful) {
      useful += 1;
    } else if (verdict.reason !== undefined) {
      notUsefulReasons[verdict.reason] += 1;
    }
  }
  return defined<FeedbackMetrics>({
    casesWithFeedback: latest.size,
    useful,
    notUseful: latest.size - useful,
    usefulRate: ratio(useful, latest.size),
    notUsefulReasons,
  });
}

function dismissalMetrics(cases: readonly FollowUpCase[]): DismissalMetrics {
  const byReason = zeroed(DISMISS_REASONS);
  let total = 0;
  for (const followUpCase of cases) {
    if (followUpCase.status === 'dismissed') {
      total += 1;
      byReason[followUpCase.resolution?.dismissReason ?? 'other'] += 1;
    }
  }
  return { total, byReason };
}

function conditionReviews(
  conditions: readonly PatientCondition[],
  period: MetricsPeriod,
): ConditionReviewMetrics {
  let confirmed = 0;
  let rejected = 0;
  let pendingReview = 0;
  for (const condition of conditions) {
    if (condition.sourceType !== 'extracted_from_note') {
      continue;
    }
    if (condition.confirmedBy === undefined) {
      pendingReview += condition.status === 'probable' ? 1 : 0;
    } else if (inPeriod(condition.updatedAt, period)) {
      confirmed += condition.status === 'confirmed' ? 1 : 0;
      rejected += condition.status === 'rejected' ? 1 : 0;
    }
  }
  const reviewed = confirmed + rejected;
  return defined<ConditionReviewMetrics>({
    reviewed,
    confirmed,
    rejected,
    pendingReview,
    confirmRate: ratio(confirmed, reviewed),
    rejectRate: ratio(rejected, reviewed),
  });
}

function planItemReviews(reviews: readonly PlanItemReviewEntry[]): PlanItemReviewMetrics {
  const counts = zeroed<PlanItemReviewType>(PLAN_ITEM_REVIEW_TYPES);
  for (const review of reviews) {
    counts[review.type] += 1;
  }
  const total = counts.plan_item_confirmed + counts.plan_item_corrected + counts.plan_item_rejected;
  return defined<PlanItemReviewMetrics>({
    total,
    confirmed: counts.plan_item_confirmed,
    corrected: counts.plan_item_corrected,
    rejected: counts.plan_item_rejected,
    correctionRate: ratio(counts.plan_item_corrected + counts.plan_item_rejected, total),
  });
}

/**
 * The note behind a reason, if it was read from one: the doctor's plan
 * (its evidence), or any expectation triggered by a note.
 */
export function noteOf(expectation: Expectation): string | undefined {
  return (
    expectation.evidence?.sourceDocumentId ??
    (expectation.source.resourceType === 'DocumentReference' ? expectation.source.id : undefined)
  );
}

function aiCost(input: MetricsInput): AiCostMetrics {
  const expectations = new Map(
    input.expectations.map((expectation) => [expectation.id, expectation]),
  );
  // Which cohort cases each note produced.
  const casesOfNote = new Map<string, Set<CaseId>>();
  for (const followUpCase of input.cases) {
    for (const reason of followUpCase.reasons) {
      const expectation = expectations.get(reason.expectationId);
      const note = expectation === undefined ? undefined : noteOf(expectation);
      if (note !== undefined) {
        const cases = casesOfNote.get(note) ?? new Set<CaseId>();
        cases.add(followUpCase.id);
        casesOfNote.set(note, cases);
      }
    }
  }
  const costOfNote = new Map<string, number>();
  for (const { documentId, costUsd } of input.noteCosts) {
    costOfNote.set(documentId, (costOfNote.get(documentId) ?? 0) + costUsd);
  }
  const casesWithCost = new Set<CaseId>();
  let attributed = 0;
  for (const [note, cases] of casesOfNote) {
    attributed += costOfNote.get(note) ?? 0;
    for (const caseId of cases) {
      casesWithCost.add(caseId);
    }
  }
  const totalUsd = input.llmUsage.reduce((total, usage) => total + usage.costUsd, 0);
  const calls = input.llmUsage.reduce((total, usage) => total + usage.calls, 0);
  return defined<AiCostMetrics>({
    totalUsd: round(totalUsd, 6) ?? 0,
    calls,
    byTask: [...input.llmUsage]
      .sort((left, right) => left.task.localeCompare(right.task))
      .map((usage) => ({ ...usage, costUsd: round(usage.costUsd, 6) ?? 0 })),
    attributedToCasesUsd: round(attributed, 6) ?? 0,
    casesWithAttributedCost: casesWithCost.size,
    perCaseUsd: round(ratio(attributed, casesWithCost.size), 6),
    allInPerCaseUsd: round(ratio(totalUsd, input.cases.length), 6),
    reviewRuns: input.reviewRuns.runs,
    reviewerUsd: round(input.reviewRuns.costUsd, 6) ?? 0,
    perReviewRunUsd: round(ratio(input.reviewRuns.costUsd, input.reviewRuns.runs), 6),
  });
}

function backfillMetrics(cases: readonly FollowUpCase[]): BackfillMetrics {
  const backfill = cases.filter((followUpCase) => followUpCase.origin === 'backfill');
  const recovered = backfill.filter(
    (followUpCase) =>
      followUpCase.status === 'resolved' && followUpCase.resolution?.kind === 'fulfilled',
  );
  return {
    cases: backfill.length,
    recoveredPatients: new Set(recovered.map((followUpCase) => followUpCase.patientId)).size,
    recoveredCases: recovered.length,
  };
}

function cohort(cases: readonly FollowUpCase[]): CaseCohortMetrics {
  const count = (predicate: (status: CaseStatus) => boolean): number =>
    cases.filter((followUpCase) => predicate(followUpCase.status)).length;
  return {
    opened: cases.length,
    live: cases.filter((followUpCase) => followUpCase.origin === 'live').length,
    backfill: cases.filter((followUpCase) => followUpCase.origin === 'backfill').length,
    active: count(isActiveCaseStatus),
    resolved: count((status) => status === 'resolved'),
    dismissed: count((status) => status === 'dismissed'),
    lostToFollowUp: count((status) => status === 'lost_to_follow_up'),
  };
}

/**
 * The clinic's metrics for a period. Pure: the same input always gives the
 * same output (no clock, no I/O). Cases outside the period and events after
 * `asOf` are ignored, so a caller may pass a superset.
 */
export function computeClinicMetrics(input: MetricsInput): ClinicMetrics {
  const cases = input.cases.filter(
    (followUpCase) =>
      followUpCase.clinicId === input.clinicId &&
      inPeriod(caseOpenedAt(followUpCase), input.period),
  );
  const ids = new Set(cases.map((followUpCase) => followUpCase.id));
  const asOf = input.asOf.getTime();
  const byCase = eventsByCase(
    input.events.filter((event) => ids.has(event.caseId) && event.at.getTime() <= asOf),
  );
  return {
    clinicId: input.clinicId,
    period: input.period,
    asOf: input.asOf,
    cases: cohort(cases),
    bookings: bookingMetrics(cases, byCase),
    timeToFirstAction: timeToFirstAction(cases, byCase),
    feedback: feedbackMetrics(
      input.feedback.filter(
        (verdict) => ids.has(verdict.caseId) && verdict.createdAt.getTime() <= asOf,
      ),
    ),
    dismissals: dismissalMetrics(cases),
    extractionReviews: {
      conditions: conditionReviews(input.conditions, input.period),
      planItems: planItemReviews(
        input.planItemReviews.filter((review) => inPeriod(review.at, input.period)),
      ),
    },
    aiCost: aiCost({ ...input, cases }),
    backfill: backfillMetrics(cases),
  };
}
