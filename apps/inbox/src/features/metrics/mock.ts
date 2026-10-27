import type { ClinicMetricsView } from './contract.ts';

/**
 * What the in-browser mock answers for `GET /api/inbox/metrics` (no API
 * running): a fixed, plausible clinic, scaled to the period asked for, so
 * the Metrics view can be developed and tested offline. The real numbers
 * come from the engine (docs/metrics.md).
 */
export function mockMetrics(now: Date, from?: string, to?: string): ClinicMetricsView {
  const end = to === undefined ? new Date(now.getTime() + 1) : new Date(to);
  const start = from === undefined ? new Date(end.getTime() - 30 * 86_400_000) : new Date(from);
  const scale = Math.max(0.25, Math.min(4, (end.getTime() - start.getTime()) / (30 * 86_400_000)));
  const n = (value: number): number => Math.round(value * scale);
  const opened = n(48);
  const booked = { followUpCase: n(9), patientContact: n(6), organic: n(4) };
  const attended = { followUpCase: n(6), patientContact: n(4), organic: n(3) };
  const bookedTotal = booked.followUpCase + booked.patientContact + booked.organic;
  const attendedTotal = attended.followUpCase + attended.patientContact + attended.organic;
  return {
    period: { from: start.toISOString(), to: end.toISOString() },
    asOf: now.toISOString(),
    cases: {
      opened,
      live: n(30),
      backfill: opened - n(30),
      active: n(22),
      resolved: n(17),
      dismissed: n(6),
      lostToFollowUp: n(3),
    },
    bookings: {
      booked: { total: bookedTotal, ...booked },
      attended: { total: attendedTotal, ...attended },
      resolvedByBooking: {
        total: n(8) + n(5) + n(3),
        followUpCase: n(8),
        patientContact: n(5),
        organic: n(3),
      },
      ...(opened === 0 ? {} : { bookedRate: bookedTotal / opened }),
      ...(bookedTotal === 0
        ? {}
        : {
            attendedRate: attendedTotal / bookedTotal,
            attributedShare: (booked.followUpCase + booked.patientContact) / bookedTotal,
          }),
    },
    timeToFirstAction: {
      measured: n(31),
      pending: opened - n(31),
      medianHours: 6.5,
      p75Hours: 22,
      p90Hours: 51.3,
    },
    feedback: {
      casesWithFeedback: n(14),
      useful: n(11),
      notUseful: n(14) - n(11),
      usefulRate: n(14) === 0 ? 0 : n(11) / n(14),
      notUsefulReasons: { wrong_interval: n(2), already_done: n(1) },
    },
    dismissals: {
      total: n(6),
      byReason: {
        handled_elsewhere: n(2),
        already_done: n(2),
        not_applicable_to_patient: n(1),
        wrong_diagnosis: 0,
        wrong_interval: n(1),
        other: 0,
      },
    },
    extractionReviews: {
      conditions: {
        reviewed: n(10),
        confirmed: n(8),
        rejected: n(2),
        pendingReview: n(5),
        confirmRate: 0.8,
        rejectRate: 0.2,
      },
      planItems: { total: 0, confirmed: 0, corrected: 0, rejected: 0 },
    },
    aiCost: {
      totalUsd: 0.42 * scale,
      calls: n(160),
      byTask: [
        {
          task: 'clinical_review',
          calls: n(40),
          successfulCalls: n(40),
          inputTokens: n(320_000),
          outputTokens: n(24_000),
          costUsd: 0.25 * scale,
        },
        {
          task: 'note_extraction',
          calls: n(120),
          successfulCalls: n(118),
          inputTokens: n(240_000),
          outputTokens: n(36_000),
          costUsd: 0.17 * scale,
        },
      ],
      attributedToCasesUsd: 0.05 * scale,
      casesWithAttributedCost: n(20),
      perCaseUsd: 0.0025,
      ...(opened === 0 ? {} : { allInPerCaseUsd: (0.42 * scale) / opened }),
      reviewRuns: n(12),
      reviewerUsd: 0.25 * scale,
      perReviewRunUsd: 0.25 / 12,
    },
    backfill: { cases: opened - n(30), recoveredPatients: n(5), recoveredCases: n(6) },
  };
}
