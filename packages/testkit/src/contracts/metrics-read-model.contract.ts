import {
  type ClinicalEvent,
  expectationId,
  type LlmUsageLog,
  type MetricsReadModel,
  type PlanExtractedEvent,
  patientId,
  type TransactionalStores,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aReviewRun } from './clinical-finding.contract.ts';
import { aCase, aCaseEvent, aCondition, aFeedback, anExpectation } from './builders.ts';
import { at, freshClinics, type MakeSubject, uniqueId, useSubject } from './harness.ts';
import { aPlanItemReview } from './plan-item-review-log.contract.ts';

/** The stores the read model reads, sharing one database, plus the LLM accounting. */
export interface MetricsReadModelSubject {
  readonly stores: TransactionalStores;
  readonly llmUsage: LlmUsageLog;
}

const PERIOD = { from: at(0), to: at(30) };

function planExtracted(
  clinic: ReturnType<typeof freshClinics>['a'],
  documentId: string,
  costUsd: number | undefined,
  version = '1',
): PlanExtractedEvent {
  return {
    type: 'plan.extracted',
    clinicId: clinic,
    patientId: patientId('pat-1'),
    source: { resourceType: 'DocumentReference', id: documentId },
    occurredAt: at(1),
    idempotencyKey: `DocumentReference/${documentId}/${version}#plan.extracted`,
    sourceDocumentId: documentId,
    items: [],
    extractor: {
      model: 'fake-extractor',
      promptVersion: 'p@1',
      ...(costUsd === undefined ? {} : { costUsd }),
    },
  };
}

/**
 * Contract of {@link MetricsReadModel} (HIP-141): every adapter answers the
 * metrics queries the same way, scoped to the clinic.
 */
export function describeMetricsReadModelContract(
  adapterName: string,
  makeSubject: MakeSubject<MetricsReadModelSubject>,
): void {
  describe(`MetricsReadModel contract (${adapterName})`, () => {
    const current = useSubject(async () => {
      const made = await makeSubject();
      return { ...made.subject, cleanup: made.cleanup };
    });
    const stores = (): TransactionalStores => current().stores;
    const metrics = (): MetricsReadModel => current().stores.metrics;

    it('lists the cases that reached the inbox in the period, a held backfill case by its release', async () => {
      const { a, b } = freshClinics();
      const inside = aCase(a, { createdAt: at(5), updatedAt: at(5) });
      const before = aCase(a, { createdAt: at(-1), updatedAt: at(-1) });
      const released = aCase(a, {
        origin: 'backfill',
        createdAt: at(-200),
        releaseAt: at(10),
        updatedAt: at(10),
      });
      const heldLater = aCase(a, {
        origin: 'backfill',
        createdAt: at(1),
        releaseAt: at(40),
        updatedAt: at(1),
      });
      const foreign = aCase(b, { createdAt: at(5), updatedAt: at(5) });
      for (const followUpCase of [inside, before, released, heldLater]) {
        await stores().cases.create(a, followUpCase);
      }
      await stores().cases.create(b, foreign);
      const ids = (await metrics().casesOpened(a, PERIOD)).map((followUpCase) => followUpCase.id);
      expect(ids).toEqual([inside.id, released.id]);
      expect(await metrics().casesOpened(a, PERIOD)).toContainEqual(released);
    });

    it('reads the trail, the verdicts and the reasons of the given cases only', async () => {
      const { a, b } = freshClinics();
      const first = aCase(a);
      const second = aCase(a);
      const opened = aCaseEvent(a, { caseId: first.id, at: at(1) });
      const booked = aCaseEvent(a, {
        caseId: first.id,
        type: 'appointment_booked',
        actor: { type: 'patient' },
        payload: { originType: 'patient_contact', fulfilledReasons: 1, appointmentId: 'appt-1' },
        at: at(2),
      });
      await stores().audit.append(a, booked);
      await stores().audit.append(a, opened);
      await stores().audit.append(a, aCaseEvent(a, { caseId: second.id, at: at(1) }));
      await stores().audit.append(b, aCaseEvent(b, { caseId: first.id, at: at(1) }));
      expect(await metrics().caseEvents(a, [first.id])).toEqual([opened, booked]);
      expect(await metrics().caseEvents(a, [])).toEqual([]);

      const verdict = aFeedback(a, { caseId: first.id, createdAt: at(3) });
      const later = aFeedback(a, {
        caseId: first.id,
        useful: false,
        reason: 'other',
        createdAt: at(4),
      });
      await stores().feedback.record(a, later);
      await stores().feedback.record(a, verdict);
      await stores().feedback.record(a, aFeedback(a, { caseId: second.id }));
      expect(await metrics().feedbackForCases(a, [first.id])).toEqual([verdict, later]);
      expect(await metrics().feedbackForCases(b, [first.id])).toEqual([]);

      const expectation = anExpectation(a);
      await stores().expectations.upsertByIdempotencyKey(a, expectation);
      await stores().expectations.upsertByIdempotencyKey(
        b,
        anExpectation(b, { id: expectation.id }),
      );
      expect(await metrics().expectations(a, [expectation.id, expectation.id])).toEqual([
        expectation,
      ]);
      expect(await metrics().expectations(a, [])).toEqual([]);
    });

    it('sums what reading each note cost, every version included', async () => {
      const { a, b } = freshClinics();
      const note = uniqueId('note');
      const other = uniqueId('note');
      const events: ClinicalEvent[] = [
        planExtracted(a, note, 0.002, '1'),
        planExtracted(a, note, 0.003, '2'),
        planExtracted(a, other, undefined),
      ];
      await stores().clinicalRecords.appendEvents(a, events);
      await stores().clinicalRecords.appendEvents(b, [planExtracted(b, note, 5)]);
      const costs = await metrics().noteExtractionCosts(a, [note, other, 'never-read']);
      expect(costs.map((cost) => cost.documentId).sort()).toEqual([note, other].sort());
      expect(costs.find((cost) => cost.documentId === note)?.costUsd).toBeCloseTo(0.005, 9);
      expect(costs.find((cost) => cost.documentId === other)?.costUsd).toBe(0);
      expect(await metrics().noteExtractionCosts(a, [])).toEqual([]);
    });

    it('lists the conditions the engine read or inferred, not the coded ones', async () => {
      const { a, b } = freshClinics();
      const extracted = aCondition(a, {
        status: 'probable',
        confidence: 0.8,
        sourceType: 'extracted_from_note',
      });
      const recorded = aCondition(a, { patientId: patientId('pat-2') });
      await stores().conditions.upsert(a, extracted);
      await stores().conditions.upsert(a, recorded);
      await stores().conditions.upsert(b, { ...extracted, clinicId: b });
      expect(await metrics().engineConditions(a)).toEqual([extracted]);
    });

    it('counts the plan-item reviews of the review log in the period, a case or not', async () => {
      const { a, b } = freshClinics();
      const followUpCase = aCase(a);
      for (const [type, day, caseId] of [
        ['plan_item_confirmed', 1, undefined],
        ['plan_item_corrected', 2, followUpCase.id],
        ['plan_item_rejected', 40, followUpCase.id],
      ] as const) {
        await stores().planItemReviews.append(
          a,
          aPlanItemReview(a, {
            type,
            at: at(day),
            ...(caseId === undefined ? {} : { caseId }),
            ...(type === 'plan_item_corrected'
              ? {
                  after: { kind: 'lab', dueAt: at(60) },
                  replacementId: expectationId(uniqueId('exp')),
                }
              : {}),
          }),
        );
      }
      await stores().planItemReviews.append(b, aPlanItemReview(b, { at: at(1) }));
      // A plan-item type on the case trail alone is not counted: the log is the source.
      await stores().audit.append(
        a,
        aCaseEvent(a, { caseId: followUpCase.id, type: 'plan_item_rejected', at: at(3) }),
      );
      expect(await metrics().planItemReviews(a, PERIOD)).toEqual([
        { type: 'plan_item_confirmed', at: at(1) },
        { type: 'plan_item_corrected', at: at(2) },
      ]);
    });

    it('sums LLM usage by task and review runs in the period', async () => {
      const { a, b } = freshClinics();
      const call = (task: string, day: number, costUsd: number, ok = true) => ({
        callId: uniqueId('call'),
        clinicId: a,
        task,
        promptVersion: 'p@1',
        provider: 'fake',
        model: 'fake-extractor',
        inputTokens: 100,
        outputTokens: 10,
        costUsd,
        latencyMs: 5,
        ok,
        at: at(day),
      });
      await current().llmUsage.record(call('note_extraction', 1, 0.001));
      await current().llmUsage.record(call('note_extraction', 2, 0.002, false));
      await current().llmUsage.record(call('clinical_review', 3, 0.01));
      await current().llmUsage.record(call('note_extraction', 31, 1));
      await current().llmUsage.record({ ...call('note_extraction', 1, 1), clinicId: b });
      const usage = await metrics().llmUsageByTask(a, PERIOD);
      expect(usage.map((task) => task.task)).toEqual(['clinical_review', 'note_extraction']);
      expect(usage[1]).toMatchObject({
        calls: 2,
        successfulCalls: 1,
        inputTokens: 200,
        outputTokens: 20,
      });
      expect(usage[1]?.costUsd).toBeCloseTo(0.003, 9);
      expect(await metrics().llmUsageByTask(b, { from: at(10), to: at(20) })).toEqual([]);

      await stores().reviewRuns.record(a, aReviewRun(a, { startedAt: at(1), costUsd: 0.004 }));
      await stores().reviewRuns.record(a, aReviewRun(a, { startedAt: at(2), costUsd: 0.006 }));
      await stores().reviewRuns.record(a, aReviewRun(a, { startedAt: at(45), costUsd: 1 }));
      const runs = await metrics().reviewRuns(a, PERIOD);
      expect(runs.runs).toBe(2);
      expect(runs.costUsd).toBeCloseTo(0.01, 9);
      expect(await metrics().reviewRuns(b, PERIOD)).toEqual({ runs: 0, costUsd: 0 });
    });
  });
}
