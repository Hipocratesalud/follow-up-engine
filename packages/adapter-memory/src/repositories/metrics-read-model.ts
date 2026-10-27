import {
  type CaseEvent,
  type CaseFeedback,
  type CaseId,
  caseOpenedAt,
  type ClinicId,
  type Expectation,
  type ExpectationId,
  type FollowUpCase,
  inPeriod,
  type LlmTaskUsage,
  type MetricsPeriod,
  type MetricsReadModel,
  type NoteExtractionCost,
  type PatientCondition,
  type PlanItemReviewEntry,
  type ReviewRunTotals,
} from '@follow-up-engine/core';
import { type MemoryDatabase, tenantKey } from '../memory-database.ts';

/** In-memory {@link MetricsReadModel}: the same answers as the Postgres one, over the memory state. */
export class MemoryMetricsReadModel implements MetricsReadModel {
  readonly #db: MemoryDatabase;

  constructor(db: MemoryDatabase) {
    this.#db = db;
  }

  casesOpened(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly FollowUpCase[]> {
    return Promise.resolve(
      [...this.#db.state.cases.values()]
        .filter(
          (followUpCase) =>
            followUpCase.clinicId === clinicId && inPeriod(caseOpenedAt(followUpCase), period),
        )
        .sort(
          (left, right) =>
            caseOpenedAt(left).getTime() - caseOpenedAt(right).getTime() ||
            left.id.localeCompare(right.id),
        ),
    );
  }

  caseEvents(clinicId: ClinicId, caseIds: readonly CaseId[]): Promise<readonly CaseEvent[]> {
    const wanted = new Set<string>(caseIds);
    return Promise.resolve(
      this.#db.state.audit
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.clinicId === clinicId && wanted.has(event.caseId))
        .sort(
          (left, right) =>
            left.event.caseId.localeCompare(right.event.caseId) ||
            left.event.at.getTime() - right.event.at.getTime() ||
            left.index - right.index,
        )
        .map(({ event }) => event),
    );
  }

  feedbackForCases(
    clinicId: ClinicId,
    caseIds: readonly CaseId[],
  ): Promise<readonly CaseFeedback[]> {
    const wanted = new Set<string>(caseIds);
    return Promise.resolve(
      this.#db.state.feedback
        .map((feedback, index) => ({ feedback, index }))
        .filter(({ feedback }) => feedback.clinicId === clinicId && wanted.has(feedback.caseId))
        .sort(
          (left, right) =>
            left.feedback.createdAt.getTime() - right.feedback.createdAt.getTime() ||
            left.index - right.index,
        )
        .map(({ feedback }) => feedback),
    );
  }

  expectations(clinicId: ClinicId, ids: readonly ExpectationId[]): Promise<readonly Expectation[]> {
    return Promise.resolve(
      [...new Set(ids)].flatMap((id) => {
        const expectation = this.#db.state.expectations.get(tenantKey(clinicId, id));
        return expectation === undefined ? [] : [expectation];
      }),
    );
  }

  noteExtractionCosts(
    clinicId: ClinicId,
    documentIds: readonly string[],
  ): Promise<readonly NoteExtractionCost[]> {
    const wanted = new Set(documentIds);
    const costs = new Map<string, number>();
    for (const event of this.#db.state.events.get(clinicId) ?? []) {
      if (event.type === 'plan.extracted' && wanted.has(event.sourceDocumentId)) {
        costs.set(
          event.sourceDocumentId,
          (costs.get(event.sourceDocumentId) ?? 0) + (event.extractor.costUsd ?? 0),
        );
      }
    }
    return Promise.resolve(
      [...costs.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([documentId, costUsd]) => ({ documentId, costUsd })),
    );
  }

  engineConditions(clinicId: ClinicId): Promise<readonly PatientCondition[]> {
    return Promise.resolve(
      [...this.#db.state.conditions.values()].filter(
        (condition) => condition.clinicId === clinicId && condition.sourceType !== 'recorded',
      ),
    );
  }

  planItemReviews(
    clinicId: ClinicId,
    period: MetricsPeriod,
  ): Promise<readonly PlanItemReviewEntry[]> {
    // The review log, not the case trail: it also holds items reviewed before
    // they became a case. The stable sort keeps append order on one instant.
    return Promise.resolve(
      this.#db.state.planItemReviews
        .filter((review) => review.clinicId === clinicId && inPeriod(review.at, period))
        .sort((left, right) => left.at.getTime() - right.at.getTime())
        .map((review) => ({ type: review.type, at: review.at })),
    );
  }

  llmUsageByTask(clinicId: ClinicId, period: MetricsPeriod): Promise<readonly LlmTaskUsage[]> {
    const byTask = new Map<string, { -readonly [K in keyof LlmTaskUsage]: LlmTaskUsage[K] }>();
    for (const call of this.#db.state.llmCalls) {
      if (call.clinicId !== clinicId || !inPeriod(call.at, period)) {
        continue;
      }
      const usage = byTask.get(call.task) ?? {
        task: call.task,
        calls: 0,
        successfulCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      usage.calls += 1;
      usage.successfulCalls += call.ok ? 1 : 0;
      usage.inputTokens += call.inputTokens;
      usage.outputTokens += call.outputTokens;
      usage.costUsd += call.costUsd;
      byTask.set(call.task, usage);
    }
    return Promise.resolve(
      [...byTask.values()].sort((left, right) => left.task.localeCompare(right.task)),
    );
  }

  reviewRuns(clinicId: ClinicId, period: MetricsPeriod): Promise<ReviewRunTotals> {
    const runs = [...this.#db.state.reviewRuns.values()].filter(
      (run) => run.clinicId === clinicId && inPeriod(run.startedAt, period),
    );
    return Promise.resolve({
      runs: runs.length,
      costUsd: runs.reduce((total, run) => total + run.costUsd, 0),
    });
  }
}
