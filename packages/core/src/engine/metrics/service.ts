import { ValidationError } from '../../domain/errors.ts';
import type { ClinicId, ExpectationId } from '../../domain/ids.ts';
import type { Clock } from '../../ports/clock.ts';
import type { MetricsPeriod } from '../../ports/metrics-read-model.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import { type ClinicMetrics, computeClinicMetrics, noteOf } from './metrics.ts';

/** A period of at most this many days (two years and a bit: the backfill's reach). */
export const MAX_METRICS_PERIOD_DAYS = 800;
/** The period when the caller gives none: the last 30 days up to now. */
export const DEFAULT_METRICS_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The period asked for, defaulted and checked: `to` defaults to now
 * included (one millisecond after it: what the clock just did counts), and
 * `from` to 30 days before `to`.
 */
export function metricsPeriod(
  now: Date,
  requested: { readonly from?: Date; readonly to?: Date } = {},
): MetricsPeriod {
  const to = requested.to ?? new Date(now.getTime() + 1);
  const from = requested.from ?? new Date(to.getTime() - DEFAULT_METRICS_PERIOD_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) {
    throw new ValidationError('period', 'The period must start before it ends');
  }
  if (to.getTime() - from.getTime() > MAX_METRICS_PERIOD_DAYS * DAY_MS) {
    throw new ValidationError(
      'period',
      `The period cannot be longer than ${String(MAX_METRICS_PERIOD_DAYS)} days`,
    );
  }
  return { from, to };
}

/**
 * The clinic's metrics for a period: loads what the computation needs
 * through the `MetricsReadModel` (one read transaction, scoped to the
 * clinic) and computes them purely ({@link computeClinicMetrics}).
 */
export async function clinicMetrics(
  deps: {
    readonly unitOfWork: UnitOfWork;
    readonly clock: Clock;
    /** Test and QA accounts, left out of every number ({@link computeClinicMetrics}). */
    readonly isTestActor?: (actorId: string) => boolean;
  },
  clinicId: ClinicId,
  requested: { readonly from?: Date; readonly to?: Date } = {},
): Promise<ClinicMetrics> {
  const asOf = deps.clock.now();
  const period = metricsPeriod(asOf, requested);
  return deps.unitOfWork.withTransaction(clinicId, async ({ metrics }) => {
    const cases = await metrics.casesOpened(clinicId, period);
    const caseIds = cases.map((followUpCase) => followUpCase.id);
    const expectationIds: ExpectationId[] = cases.flatMap((followUpCase) =>
      followUpCase.reasons.map((reason) => reason.expectationId),
    );
    const [events, feedback, expectations, conditions, planItemReviews, llmUsage, reviewRuns] =
      await Promise.all([
        metrics.caseEvents(clinicId, caseIds),
        metrics.feedbackForCases(clinicId, caseIds),
        metrics.expectations(clinicId, expectationIds),
        metrics.engineConditions(clinicId),
        metrics.planItemReviews(clinicId, period),
        metrics.llmUsageByTask(clinicId, period),
        metrics.reviewRuns(clinicId, period),
      ]);
    const notes = [...new Set(expectations.flatMap((expectation) => noteOf(expectation) ?? []))];
    const noteCosts = await metrics.noteExtractionCosts(clinicId, notes);
    return computeClinicMetrics({
      clinicId,
      period,
      asOf,
      cases,
      events,
      feedback,
      expectations,
      noteCosts,
      conditions,
      planItemReviews,
      llmUsage,
      reviewRuns,
      ...(deps.isTestActor === undefined ? {} : { isTestActor: deps.isTestActor }),
    });
  });
}
