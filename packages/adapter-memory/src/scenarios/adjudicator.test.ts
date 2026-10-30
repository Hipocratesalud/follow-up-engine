import {
  ADJUDICATION_JOB,
  type AdjudicationProviderResult,
  type AdjudicationRequest,
  type AdjudicatorSettings,
  checkDecision,
  createExpectationAdjudication,
  DEFAULT_ADJUDICATOR_SETTINGS,
  DISCARDED_BY_ADJUDICATOR,
  type ExpectationAdjudicator,
  isAmbiguousConfidence,
  REJECTED_BY_CLINICIAN,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { FakeNoteExtractor } from '../fake-note-extractor.ts';
import { scenario, type ScenarioWorld } from '../testing/index.ts';

const NOTE_TEXT =
  'Paciente Ana Prueba con HTA. Plan: no requiere control por ahora; volver si presenta cefalea.';
const QUOTE = 'no requiere control por ahora';

function extractor(confidence: number): FakeNoteExtractor {
  return new FakeNoteExtractor().setExtraction('doc-1', {
    hasPlan: true,
    planItems: [
      {
        kind: 'follow_up_visit',
        description: 'control visit',
        dueAt: new Date('2026-02-05T12:00:00.000Z'),
        evidenceQuote: QUOTE,
        confidence,
      },
    ],
  });
}

/** A provider that answers what it is told and records what it saw. */
class StubAdjudicator implements ExpectationAdjudicator {
  readonly requests: AdjudicationRequest[] = [];
  answer: Pick<AdjudicationProviderResult, 'decision' | 'probability' | 'quotes' | 'reasonCodes'> =
    {
      decision: 'discard',
      probability: 0.1,
      quotes: [QUOTE],
      reasonCodes: ['negated'],
    };

  decide(_clinicId: unknown, request: AdjudicationRequest): Promise<AdjudicationProviderResult> {
    this.requests.push(request);
    return Promise.resolve({
      ...this.answer,
      rationale: { en: 'The note says it is not needed.', es: 'La nota dice que no hace falta.' },
      provider: 'stub',
      model: 'stub-1',
      promptVersion: 'adjudicator@test',
      costUsd: 0.0021,
      inputTokens: 900,
      outputTokens: 300,
      latencyMs: 1200,
    });
  }
}

async function world(
  settings: AdjudicatorSettings | undefined,
  confidence = 0.6,
): Promise<ScenarioWorld> {
  return scenario({
    extractor: extractor(confidence),
    ...(settings === undefined ? {} : { clinicSettings: { adjudicator: settings } }),
  })
    .at(0)
    .consult({ encounterId: 'enc-1', note: { id: 'doc-1', text: NOTE_TEXT } })
    .run();
}

function service(w: ScenarioWorld, stub: StubAdjudicator) {
  return createExpectationAdjudication({
    unitOfWork: w.harness.unitOfWork,
    clinics: w.harness.clinics,
    clock: w.clock,
    ids: w.harness.ids,
    adjudicator: stub,
    redactTermsOf: () => ['Ana Prueba'],
  });
}

function planItem(w: ScenarioWorld) {
  const item = w.expectations().find((expectation) => expectation.layer === 'doctor_plan');
  if (item === undefined) throw new Error('no plan item');
  return item;
}

function adjudicationJobs(w: ScenarioWorld) {
  return w.harness.stores.jobs.list(w.clinicId).filter((job) => job.type === ADJUDICATION_JOB);
}

describe('adjudicator of ambiguous plan items (PRD V2, workstream E)', () => {
  it('keeps the extraction confidence and checks the band [min, max)', async () => {
    const w = await world(undefined);
    expect(planItem(w).confidence).toBe(0.6);
    expect(isAmbiguousConfidence(0.4, DEFAULT_ADJUDICATOR_SETTINGS)).toBe(true);
    expect(isAmbiguousConfidence(0.75, DEFAULT_ADJUDICATOR_SETTINGS)).toBe(false);
    expect(isAmbiguousConfidence(undefined, DEFAULT_ADJUDICATOR_SETTINGS)).toBe(false);
  });

  it('queues nothing while the clinic has it off (the default)', async () => {
    const w = await world(undefined);
    expect(adjudicationJobs(w)).toEqual([]);
    const outcome = await service(w, new StubAdjudicator()).adjudicate(w.clinicId, planItem(w).id);
    expect(outcome).toEqual({ status: 'skipped', reason: 'off' });
  });

  it('never looks at a clear item (confidence above the band)', async () => {
    const w = await world({ mode: 'shadow' }, 0.85);
    expect(adjudicationJobs(w)).toEqual([]);
  });

  it('shadow: records the decision with provenance, changes nothing, masks the patient', async () => {
    const w = await world({ mode: 'shadow' });
    const [job] = adjudicationJobs(w);
    expect(job?.payload).toEqual({ expectationId: planItem(w).id });
    const stub = new StubAdjudicator();
    const adjudicator = service(w, stub);
    const outcome = await adjudicator.runJob(w.clinicId, job?.payload ?? {});
    expect(outcome.status).toBe('decided');
    if (outcome.status !== 'decided') return;
    expect(outcome.adjudication).toMatchObject({
      decision: 'discard',
      modelDecision: 'discard',
      probability: 0.1,
      reasonCodes: ['negated'],
      quotes: [{ quote: QUOTE, sourceDocumentId: 'doc-1' }],
      mode: 'shadow',
      applied: false,
      provider: 'stub',
      model: 'stub-1',
      promptVersion: 'adjudicator@test',
      costUsd: 0.0021,
      inputConfidence: 0.6,
    });
    // Nothing changed: the item is still followed up.
    expect(planItem(w).status).toBe('open');
    // No identifiers in what the provider received besides the note (masked by the adapter).
    const [request] = stub.requests;
    expect(JSON.stringify({ ...request?.input, noteText: '' })).not.toMatch(
      /clinic-demo|pat-1|enc-1|exp-/u,
    );
    expect(request?.input).toMatchObject({ kind: 'follow_up_visit', evidenceQuote: QUOTE });
    // Idempotent: a second run returns the stored decision without calling the model.
    const again = await adjudicator.adjudicate(w.clinicId, planItem(w).id);
    expect(again).toMatchObject({ status: 'decided', created: false });
    expect(stub.requests).toHaveLength(1);
  });

  it('active: discard suppresses the item; the doctor can bring it back', async () => {
    const w = await world({ mode: 'active' });
    const adjudicator = service(w, new StubAdjudicator());
    const outcome = await adjudicator.adjudicate(w.clinicId, planItem(w).id);
    if (outcome.status !== 'decided') throw new Error('not decided');
    expect(outcome.adjudication).toMatchObject({ mode: 'active', applied: true });
    expect(planItem(w)).toMatchObject({
      status: 'cancelled',
      closedReason: DISCARDED_BY_ADJUDICATOR,
    });

    const overridden = await adjudicator.override(w.clinicId, outcome.adjudication.id, {
      decision: 'open',
      userId: 'dr-house',
      note: 'The note asks for it',
    });
    expect(overridden.adjudication.override).toMatchObject({
      decision: 'open',
      userId: 'dr-house',
      note: 'The note asks for it',
    });
    expect(planItem(w)).toMatchObject({ status: 'open', confirmedBy: 'dr-house' });
    await expect(
      adjudicator.override(w.clinicId, outcome.adjudication.id, {
        decision: 'discard',
        userId: 'dr-house',
      }),
    ).rejects.toThrow(/AdjudicationOverride/u);
    const reviews = await w.harness.stores.planItemReviews.listForExpectation(
      w.clinicId,
      planItem(w).id,
    );
    expect(reviews.map((review) => review.type)).toEqual(['plan_item_confirmed']);
  });

  it('no quote found in the note: needs_human, whatever the model said', async () => {
    const w = await world({ mode: 'active' });
    const stub = new StubAdjudicator();
    stub.answer = {
      decision: 'discard',
      probability: 0.05,
      quotes: ['the doctor never wrote this'],
      reasonCodes: ['negated'],
    };
    const outcome = await service(w, stub).adjudicate(w.clinicId, planItem(w).id);
    if (outcome.status !== 'decided') throw new Error('not decided');
    expect(outcome.adjudication).toMatchObject({
      decision: 'needs_human',
      modelDecision: 'discard',
      applied: false,
      quotes: [],
    });
    expect(outcome.adjudication.reasonCodes).toContain('no_verifiable_quote');
    expect(planItem(w).status).toBe('open');
  });

  it('a decision on an overdue item is a case event with actor adjudicator; discard override rejects it', async () => {
    const w = await scenario({
      extractor: extractor(0.6),
      clinicSettings: { adjudicator: { mode: 'shadow' } },
    })
      .at(0)
      .consult({ encounterId: 'enc-1', note: { id: 'doc-1', text: NOTE_TEXT } })
      .at(40)
      .runWatcher()
      .run();
    const item = planItem(w);
    expect(item.status).toBe('expired');
    const caseId = item.caseId;
    if (caseId === undefined) throw new Error('no case');
    const adjudicator = service(w, new StubAdjudicator());
    const outcome = await adjudicator.adjudicate(w.clinicId, item.id);
    if (outcome.status !== 'decided') throw new Error('not decided');
    expect(outcome.adjudication.caseId).toBe(caseId);
    expect((await adjudicator.forCase(w.clinicId, caseId)).map((each) => each.id)).toEqual([
      outcome.adjudication.id,
    ]);
    const events = await w.audit(caseId);
    expect(events.find((event) => event.type === 'adjudicated')).toMatchObject({
      actor: { type: 'adjudicator', id: 'stub:stub-1' },
      payload: {
        decision: 'discard',
        mode: 'shadow',
        applied: false,
        promptVersion: 'adjudicator@test',
        costUsd: 0.0021,
      },
    });

    const result = await adjudicator.override(w.clinicId, outcome.adjudication.id, {
      decision: 'discard',
      userId: 'dr-house',
    });
    expect(planItem(w)).toMatchObject({ status: 'cancelled', closedReason: REJECTED_BY_CLINICIAN });
    expect(result.casesResolved).toEqual([caseId]);
    const after = await w.audit(caseId);
    expect(after.find((event) => event.type === 'adjudication_overridden')).toMatchObject({
      actor: { type: 'user', id: 'dr-house' },
      payload: { decision: 'discard', override: 'discard' },
    });
  });

  it('checkDecision: a probability that does not back the decision is needs_human', () => {
    const base = { quotes: [QUOTE], reasonCodes: ['explicit_instruction' as const] };
    expect(
      checkDecision({ ...base, decision: 'open', probability: 0.6 }, NOTE_TEXT, 'doc-1', {
        minOpenProbability: 0.7,
        maxDiscardProbability: 0.3,
      }),
    ).toMatchObject({
      decision: 'needs_human',
      reasonCodes: ['explicit_instruction', 'low_probability'],
    });
    expect(
      checkDecision({ ...base, decision: 'open', probability: 0.9 }, NOTE_TEXT, 'doc-1', {
        minOpenProbability: 0.7,
        maxDiscardProbability: 0.3,
      }).decision,
    ).toBe('open');
  });
});
