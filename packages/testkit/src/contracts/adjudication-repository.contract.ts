import {
  type Adjudication,
  type AdjudicationRepository,
  caseId,
  type ClinicId,
  expectationId,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

/** An adjudicator decision on a fresh expectation. */
export function anAdjudication(
  clinic: ClinicId,
  overrides: Partial<Adjudication> = {},
): Adjudication {
  return {
    id: uniqueId('adj'),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    expectationId: expectationId(uniqueId('exp')),
    decision: 'needs_human',
    modelDecision: 'open',
    probability: 0.55,
    reasonCodes: ['conditional_plan', 'low_probability'],
    rationale: { en: 'Only if the pain persists.', es: 'Solo si persiste el dolor.' },
    quotes: [{ quote: 'Si persiste el dolor, solicitar ecografía', sourceDocumentId: 'doc-1' }],
    inputConfidence: 0.5,
    mode: 'shadow',
    applied: false,
    provider: 'meta',
    model: 'muse-spark-1.3',
    promptVersion: 'adjudicator@1',
    costUsd: 0.003774,
    inputTokens: 1200,
    outputTokens: 400,
    latencyMs: 2500,
    createdAt: at(1),
    ...overrides,
  };
}

/** Contract every {@link AdjudicationRepository} adapter must pass (PRD V2). */
export function describeAdjudicationRepositoryContract(
  name: string,
  makeSubject: MakeSubject<AdjudicationRepository>,
): void {
  describe(`AdjudicationRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('stores a decision and reads it back by id, expectation, patient and decision', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const first = anAdjudication(a, { patientId: patient, createdAt: at(1) });
      const second = anAdjudication(a, {
        patientId: patient,
        decision: 'discard',
        modelDecision: 'discard',
        probability: 0.1,
        reasonCodes: ['negated'],
        caseId: caseId('case-1'),
        createdAt: at(2),
      });
      await repo().create(a, first);
      await repo().create(a, second);
      expect(await repo().get(a, first.id)).toEqual(first);
      expect(await repo().forExpectation(a, second.expectationId)).toEqual(second);
      expect(await repo().list(a, { patientId: patient })).toEqual([second, first]);
      expect(await repo().list(a, { patientId: patient, decisions: ['discard'] })).toEqual([
        second,
      ]);
      expect(await repo().list(a, { expectationIds: [first.expectationId] })).toEqual([first]);
      expect(await repo().list(a, { patientId: patient, limit: 1 })).toEqual([second]);
    });

    it('records the override', async () => {
      const { a } = freshClinics();
      const decision = anAdjudication(a);
      await repo().create(a, decision);
      const overridden = await repo().setOverride(a, decision.id, {
        decision: 'open',
        userId: 'dra-mora',
        at: at(3),
        note: 'The note asks for it',
      });
      expect(overridden.override).toEqual({
        decision: 'open',
        userId: 'dra-mora',
        at: at(3),
        note: 'The note asks for it',
      });
      expect(await repo().get(a, decision.id)).toEqual(overridden);
      await expectRejectsWithName(
        repo().setOverride(a, uniqueId('adj'), { decision: 'open', userId: 'x', at: at(3) }),
        'NotFoundError',
      );
    });

    it('one decision per expectation; isolates clinics', async () => {
      const { a, b } = freshClinics();
      const decision = anAdjudication(a);
      await repo().create(a, decision);
      await expectRejectsWithName(
        repo().create(a, { ...decision, id: uniqueId('adj') }),
        'ConflictError',
      );
      await expectRejectsWithName(repo().create(a, anAdjudication(b)), 'TenantMismatchError');
      expect(await repo().get(b, decision.id)).toBeUndefined();
      expect(await repo().forExpectation(b, decision.expectationId)).toBeUndefined();
      expect(await repo().list(b)).toEqual([]);
    });
  });
}
