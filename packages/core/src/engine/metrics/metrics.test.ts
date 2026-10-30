import { describe, expect, it } from 'vitest';
import type { CaseEvent, CaseFeedback, FollowUpCase } from '../../domain/case.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { caseId, clinicId, expectationId, feedbackId, patientId } from '../../domain/ids.ts';
import { FakeClock } from '../../clock/fake-clock.ts';
import { ValidationError } from '../../domain/errors.ts';
import {
  caseOpenedAt,
  computeClinicMetrics,
  type MetricsInput,
  noteOf,
  quantile,
} from './metrics.ts';
import { metricsPeriod } from './service.ts';

/*
 * HIP-141 metric math on a fixed fake clock: every expected number is
 * worked out by hand from the fixtures below.
 */

const CLINIC = clinicId('clinic-metrics');
const OTHER_CLINIC = clinicId('clinic-other');
const clock = new FakeClock(new Date('2026-03-01T00:00:00.000Z'));
const NOW = clock.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD = { from: new Date(NOW.getTime() - 30 * DAY), to: new Date(NOW.getTime() + 1) };

const at = (daysAgo: number, hours = 0): Date =>
  new Date(NOW.getTime() - daysAgo * DAY + hours * HOUR);

function aCase(
  id: string,
  options: Partial<FollowUpCase> & { readonly opened: Date },
): FollowUpCase {
  const { opened, ...rest } = options;
  return {
    id: caseId(id),
    clinicId: CLINIC,
    patientId: patientId(`p-${id}`),
    dedupKey: `p-${id}:follow_up`,
    reasons: [{ expectationId: expectationId(`exp-${id}`), reasonCode: 'doctor_plan_followup' }],
    status: 'open',
    priority: 50,
    escalationStep: 0,
    origin: 'live',
    createdAt: opened,
    updatedAt: opened,
    ...rest,
  };
}

function event(
  id: string,
  type: CaseEvent['type'],
  when: Date,
  options: { readonly actor?: CaseEvent['actor']; readonly payload?: CaseEvent['payload'] } = {},
): CaseEvent {
  return {
    clinicId: CLINIC,
    caseId: caseId(id),
    type,
    actor: options.actor ?? { type: 'system' },
    payload: options.payload ?? {},
    at: when,
  };
}

function planExpectation(id: string, note: string): Expectation {
  return {
    id: expectationId(`exp-${id}`),
    clinicId: CLINIC,
    patientId: patientId(`p-${id}`),
    idempotencyKey: `DocumentReference/${note}#doctor_plan_followup#0`,
    ruleId: 'doctor_plan_followup',
    ruleVersion: '1.0.0',
    layer: 'doctor_plan',
    source: { resourceType: 'DocumentReference', id: note },
    matchKey: 'visit',
    dueAt: at(40),
    status: 'expired',
    caseId: caseId(id),
    origin: 'live',
    reason: { code: 'doctor_plan_followup', label: 'Control' },
    evidence: { quote: 'control en 1 mes', sourceDocumentId: note },
    createdAt: at(70),
    updatedAt: at(40),
  };
}

const USER = { type: 'user', id: 'recepcion' } as const;

function feedback(id: string, caseRef: string, useful: boolean, when: Date): CaseFeedback {
  return {
    id: feedbackId(id),
    clinicId: CLINIC,
    caseId: caseId(caseRef),
    useful,
    ...(useful ? {} : { reason: 'wrong_interval' as const }),
    createdAt: when,
  };
}

function condition(
  code: string,
  status: PatientCondition['status'],
  options: Partial<PatientCondition> = {},
): PatientCondition {
  return {
    clinicId: CLINIC,
    patientId: patientId(`p-${code}`),
    code: { system: 'http://hl7.org/fhir/sid/icd-10', code },
    status,
    confidence: 0.8,
    sourceType: 'extracted_from_note',
    source: { resourceType: 'DocumentReference', id: `note-${code}` },
    updatedAt: at(5),
    ...options,
  };
}

/**
 * Six cases in the period and two outside it:
 *
 * - `a` booked from the case (team), attended, resolved by the booking.
 * - `b` booked after a contact request (patient), not attended yet.
 * - `c` booked on its own (organic), resolved by that booking.
 * - `d` dismissed (`wrong_interval`), never booked.
 * - `e` backfill, held until 10 days ago, resolved `fulfilled` by a visit.
 * - `f` lost to follow-up, no first action at all.
 * - `old` opened before the period; `foreign` of another clinic.
 */
function input(): MetricsInput {
  const cases: FollowUpCase[] = [
    aCase('a', {
      opened: at(20),
      status: 'resolved',
      resolution: { kind: 'fulfilled', resolvedAt: at(17) },
    }),
    aCase('b', { opened: at(15), status: 'notified' }),
    aCase('c', {
      opened: at(12),
      status: 'resolved',
      resolution: { kind: 'fulfilled', resolvedAt: at(10) },
    }),
    aCase('d', {
      opened: at(8),
      status: 'dismissed',
      resolution: { kind: 'not_needed', resolvedAt: at(7), dismissReason: 'wrong_interval' },
    }),
    aCase('e', {
      opened: at(200),
      releaseAt: at(10),
      origin: 'backfill',
      status: 'resolved',
      resolution: { kind: 'fulfilled', resolvedAt: at(3) },
    }),
    aCase('f', { opened: at(5), status: 'lost_to_follow_up' }),
    aCase('old', { opened: at(45) }),
    { ...aCase('foreign', { opened: at(4) }), clinicId: OTHER_CLINIC },
  ];
  const events: CaseEvent[] = [
    event('a', 'opened', at(20)),
    // First action 2 h after opening.
    event('a', 'assigned', at(20, 2), { actor: USER }),
    event('a', 'appointment_booked', at(19), {
      payload: { originType: 'follow_up_case', fulfilledReasons: 1, appointmentId: 'appt-a' },
    }),
    event('a', 'resolved', at(19), {
      payload: { kind: 'fulfilled', appointmentId: 'appt-a', appointmentOrigin: 'follow_up_case' },
    }),
    event('a', 'appointment_attended', at(17), {
      actor: { type: 'patient' },
      payload: { originType: 'follow_up_case', appointmentId: 'appt-a' },
    }),
    event('b', 'opened', at(15)),
    // First action: the policy's contact request, 10 h after opening.
    event('b', 'patient_contact_requested', at(15, 10), { payload: { trigger: 'policy' } }),
    event('b', 'appointment_booked', at(14), {
      actor: { type: 'patient' },
      payload: { originType: 'patient_contact', fulfilledReasons: 1, appointmentId: 'appt-b' },
    }),
    event('c', 'opened', at(12)),
    // A system event is not a first action.
    event('c', 'notified', at(12, 1)),
    event('c', 'appointment_booked', at(10), {
      payload: { originType: 'organic', fulfilledReasons: 1, appointmentId: 'appt-c' },
    }),
    // No `appointmentOrigin` on the resolution: the fulfilling booking decides.
    event('c', 'resolved', at(10), { payload: { kind: 'fulfilled' } }),
    event('d', 'opened', at(8)),
    // First action 30 h after opening.
    event('d', 'dismissed', at(8, 30), { actor: USER, payload: { reason: 'wrong_interval' } }),
    event('e', 'opened', at(200)),
    event('e', 'released', at(10)),
    // First action 4 h after the release (not after the creation).
    event('e', 'notified', at(10, 4), { actor: USER }),
    event('f', 'opened', at(5)),
    event('old', 'assigned', at(44), { actor: USER }),
    // After `asOf`: ignored.
    event('f', 'assigned', new Date(NOW.getTime() + DAY), { actor: USER }),
  ];
  return {
    clinicId: CLINIC,
    period: PERIOD,
    asOf: NOW,
    cases,
    events,
    feedback: [
      feedback('fb-1', 'a', false, at(18)),
      // The latest verdict on `a` wins.
      feedback('fb-2', 'a', true, at(17)),
      feedback('fb-3', 'd', false, at(7)),
      feedback('fb-4', 'old', true, at(40)),
    ],
    expectations: [
      planExpectation('a', 'note-1'),
      planExpectation('b', 'note-1'),
      planExpectation('c', 'note-2'),
    ],
    noteCosts: [
      { documentId: 'note-1', costUsd: 0.004 },
      { documentId: 'note-2', costUsd: 0.001 },
      // An amended version of note-2, read again.
      { documentId: 'note-2', costUsd: 0.001 },
    ],
    conditions: [
      condition('E11', 'confirmed', { confirmedBy: 'dr-a' }),
      condition('I10', 'confirmed', { confirmedBy: 'dr-a' }),
      condition('E78', 'rejected', { confirmedBy: 'dr-b' }),
      condition('E03', 'probable'),
      // Reviewed before the period: not counted as reviewed.
      condition('N18', 'confirmed', { confirmedBy: 'dr-a', updatedAt: at(60) }),
      // Inferred from a medication: not an extraction.
      condition('E66', 'probable', { sourceType: 'inferred_from_medication' }),
    ],
    planItemReviews: [
      { type: 'plan_item_confirmed', at: at(3), userId: 'dr-a' },
      { type: 'plan_item_corrected', at: at(2), userId: 'dr-a' },
      { type: 'plan_item_rejected', at: at(1), userId: 'dr-a' },
      { type: 'plan_item_confirmed', at: at(50), userId: 'dr-a' },
    ],
    llmUsage: [
      {
        task: 'note_extraction',
        calls: 10,
        successfulCalls: 9,
        inputTokens: 5000,
        outputTokens: 1000,
        costUsd: 0.012,
      },
      {
        task: 'clinical_review',
        calls: 4,
        successfulCalls: 4,
        inputTokens: 8000,
        outputTokens: 800,
        costUsd: 0.018,
      },
    ],
    reviewRuns: { runs: 3, costUsd: 0.018 },
  };
}

describe('clinic metrics (HIP-141)', () => {
  const metrics = computeClinicMetrics(input());

  it('follows the cases that reached the inbox in the period, of the clinic only', () => {
    expect(metrics.cases).toEqual({
      opened: 6,
      live: 5,
      backfill: 1,
      active: 1,
      resolved: 3,
      dismissed: 1,
      lostToFollowUp: 1,
    });
  });

  it('splits bookings and attendance by origin, attributed beating organic', () => {
    expect(metrics.bookings).toEqual({
      booked: { total: 3, followUpCase: 1, patientContact: 1, organic: 1 },
      attended: { total: 1, followUpCase: 1, patientContact: 0, organic: 0 },
      resolvedByBooking: { total: 2, followUpCase: 1, patientContact: 0, organic: 1 },
      bookedRate: 3 / 6,
      attendedRate: 1 / 3,
      attributedShare: 2 / 3,
    });
  });

  it('measures the time to the first user action or contact request from the release', () => {
    // a 2 h, b 10 h, d 30 h, e 4 h; c and f have none.
    expect(metrics.timeToFirstAction).toEqual({
      measured: 4,
      pending: 2,
      medianHours: 7,
      p75Hours: 15,
      p90Hours: 24,
    });
  });

  it('counts the latest verdict per case, like the calibration report', () => {
    expect(metrics.feedback).toMatchObject({
      casesWithFeedback: 2,
      useful: 1,
      notUseful: 1,
      usefulRate: 0.5,
      notUsefulReasons: { wrong_interval: 1, other: 0 },
    });
  });

  it('counts dismissals by the reason the team gave', () => {
    expect(metrics.dismissals.total).toBe(1);
    expect(metrics.dismissals.byReason).toMatchObject({ wrong_interval: 1, other: 0 });
  });

  it('rates the extracted conditions a clinician reviewed in the period', () => {
    expect(metrics.extractionReviews.conditions).toEqual({
      reviewed: 3,
      confirmed: 2,
      rejected: 1,
      pendingReview: 1,
      confirmRate: 2 / 3,
      rejectRate: 1 / 3,
    });
  });

  it('counts plan-item corrections when a feature records them', () => {
    expect(metrics.extractionReviews.planItems).toEqual({
      total: 3,
      confirmed: 1,
      corrected: 1,
      rejected: 1,
      correctionRate: 2 / 3,
    });
  });

  it('charges note reading to the cases it produced and reviewer cost per run', () => {
    expect(metrics.aiCost).toEqual({
      totalUsd: 0.03,
      calls: 14,
      byTask: [
        expect.objectContaining({ task: 'clinical_review', costUsd: 0.018 }),
        expect.objectContaining({ task: 'note_extraction', costUsd: 0.012 }),
      ],
      // note-1 (0.004, cases a and b) + note-2 (0.002, case c).
      attributedToCasesUsd: 0.006,
      casesWithAttributedCost: 3,
      perCaseUsd: 0.002,
      allInPerCaseUsd: 0.005,
      reviewRuns: 3,
      reviewerUsd: 0.018,
      perReviewRunUsd: 0.006,
    });
  });

  it('counts the patients the backfill brought back', () => {
    expect(metrics.backfill).toEqual({ cases: 1, recoveredPatients: 1, recoveredCases: 1 });
  });

  it('leaves rates out instead of dividing by zero', () => {
    const empty = computeClinicMetrics({
      ...input(),
      cases: [],
      events: [],
      feedback: [],
      conditions: [],
      planItemReviews: [],
      llmUsage: [],
      reviewRuns: { runs: 0, costUsd: 0 },
    });
    expect(empty.bookings).toEqual({
      booked: { total: 0, followUpCase: 0, patientContact: 0, organic: 0 },
      attended: { total: 0, followUpCase: 0, patientContact: 0, organic: 0 },
      resolvedByBooking: { total: 0, followUpCase: 0, patientContact: 0, organic: 0 },
    });
    expect(empty.timeToFirstAction).toEqual({ measured: 0, pending: 0 });
    expect(empty.feedback.usefulRate).toBeUndefined();
    expect(empty.aiCost.perCaseUsd).toBeUndefined();
    expect(empty.aiCost.allInPerCaseUsd).toBeUndefined();
    expect(empty.aiCost.perReviewRunUsd).toBeUndefined();
  });

  it('is pure: the same input gives the same output', () => {
    expect(computeClinicMetrics(input())).toEqual(metrics);
  });

  it("leaves test and QA accounts out of every number: the physicians' metrics are unchanged", () => {
    const QA = 'qa@example.com';
    const base = input();
    const withQa: MetricsInput = {
      ...base,
      // QA resolved the active case b, and acted first on b and on f.
      cases: base.cases.map((followUpCase) =>
        followUpCase.id === caseId('b')
          ? {
              ...followUpCase,
              status: 'resolved',
              resolution: { kind: 'not_needed', resolvedAt: at(14), resolvedBy: QA },
            }
          : followUpCase,
      ),
      events: [
        ...base.events,
        event('b', 'resolved', at(15, 1), { actor: { type: 'user', id: QA } }),
        event('f', 'assigned', at(5, 1), { actor: { type: 'user', id: QA } }),
      ],
      // QA's later verdicts would override the team's (latest per case wins).
      feedback: [
        ...base.feedback,
        { ...feedback('fb-qa-1', 'd', true, at(6)), authorId: QA },
        { ...feedback('fb-qa-2', 'c', true, at(9)), authorId: QA },
      ],
      planItemReviews: [
        ...base.planItemReviews,
        { type: 'plan_item_confirmed', at: at(2), userId: QA },
        { type: 'plan_item_confirmed', at: at(1), userId: 'evidence-orchestrator@example.com' },
      ],
      isTestActor: (actorId) => actorId.endsWith('@example.com'),
    };
    const filtered = computeClinicMetrics(withQa);
    expect(filtered.cases).toEqual(metrics.cases);
    expect(filtered.feedback).toEqual(metrics.feedback);
    expect(filtered.extractionReviews.planItems).toEqual(metrics.extractionReviews.planItems);
    expect(filtered.timeToFirstAction).toEqual(metrics.timeToFirstAction);
    expect(filtered.dismissals).toEqual(metrics.dismissals);
    expect(filtered.bookings).toEqual(metrics.bookings);

    // Without the predicate the QA rows count: the guard above is not vacuous.
    const counted = computeClinicMetrics({ ...withQa, isTestActor: () => false });
    expect(counted.cases.resolved).toBe(metrics.cases.resolved + 1);
    expect(counted.feedback.useful).toBe(metrics.feedback.useful + 2);
    expect(counted.extractionReviews.planItems.confirmed).toBe(
      metrics.extractionReviews.planItems.confirmed + 2,
    );
    expect(counted.timeToFirstAction.measured).toBe(metrics.timeToFirstAction.measured + 1);
  });
});

describe('metric helpers', () => {
  it('interpolates quantiles between the closest ranks', () => {
    expect(quantile([], 0.5)).toBeUndefined();
    expect(quantile([4], 0.9)).toBe(4);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([2, 4, 10, 30], 0.75)).toBe(15);
    expect(quantile([2, 4, 10, 30], 0.9)).toBeCloseTo(24);
  });

  it('opens a held backfill case when it is released', () => {
    expect(caseOpenedAt(aCase('x', { opened: at(30), releaseAt: at(2) }))).toEqual(at(2));
    expect(caseOpenedAt(aCase('y', { opened: at(3) }))).toEqual(at(3));
  });

  it('reads the note behind a plan reason', () => {
    expect(noteOf(planExpectation('z', 'note-9'))).toBe('note-9');
  });

  it('defaults the period to the last 30 days, now included, and refuses a bad one', () => {
    expect(metricsPeriod(NOW)).toEqual({
      from: new Date(NOW.getTime() + 1 - 30 * DAY),
      to: new Date(NOW.getTime() + 1),
    });
    expect(() => metricsPeriod(NOW, { from: NOW, to: NOW })).toThrow(ValidationError);
    expect(() => metricsPeriod(NOW, { from: at(900) })).toThrow(ValidationError);
  });
});
