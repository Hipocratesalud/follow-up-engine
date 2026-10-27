import {
  type AuditLog,
  caseId,
  type ConditionRepository,
  type FeedbackRepository,
  feedbackId,
  ICD10_SYSTEM,
  patientId,
  type QualityFindingRepository,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aCaseEvent, aCondition, aFeedback, aQualityFinding } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  useSubject,
} from './harness.ts';

/** Contract every {@link FeedbackRepository} adapter must pass. */
export function describeFeedbackRepositoryContract(
  name: string,
  makeSubject: MakeSubject<FeedbackRepository>,
): void {
  describe(`FeedbackRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('records feedback and lists it per case, oldest first', async () => {
      const { a } = freshClinics();
      const c = caseId('case-fb');
      const second = aFeedback(a, {
        caseId: c,
        createdAt: at(2),
        useful: false,
        reason: 'wrong_interval',
        comment: 'muy pronto',
      });
      const first = aFeedback(a, { caseId: c, createdAt: at(1), authorId: 'dr-1' });
      const other = aFeedback(a, { caseId: caseId('case-other') });
      for (const f of [second, first, other]) await repo().record(a, f);
      expect(await repo().listForCase(a, c)).toEqual([first, second]);
    });

    it('keeps recording order for feedback with the same instant (a fake clock)', async () => {
      const { a } = freshClinics();
      const c = caseId('case-fb-tie');
      // Ids sort opposite to recording order, so an id tiebreaker would fail.
      const verdicts = ['fb-z', 'fb-m', 'fb-a', 'fb-y', 'fb-b'].map((id, index) =>
        aFeedback(a, {
          id: feedbackId(id),
          caseId: c,
          createdAt: at(1),
          useful: index % 2 === 0,
        }),
      );
      for (const f of verdicts) await repo().record(a, f);
      expect((await repo().listForCase(a, c)).map((f) => f.id)).toEqual(verdicts.map((f) => f.id));
      expect((await repo().listSince(a, at(1), 10)).map((f) => f.id)).toEqual(
        verdicts.map((f) => f.id),
      );
    });

    it('rejects a duplicate id with ConflictError', async () => {
      const { a } = freshClinics();
      const f = aFeedback(a);
      await repo().record(a, f);
      await expectRejectsWithName(repo().record(a, f), 'ConflictError');
    });

    it('lists feedback since an instant, oldest first, with a limit', async () => {
      const { a } = freshClinics();
      const f = [3, 1, 2, 0].map((day) => aFeedback(a, { createdAt: at(day) }));
      for (const item of f) await repo().record(a, item);
      const since = await repo().listSince(a, at(1), 10);
      expect(since.map((x) => x.createdAt)).toEqual([at(1), at(2), at(3)]);
      expect(await repo().listSince(a, at(1), 2)).toHaveLength(2);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const f = aFeedback(a);
      await repo().record(a, f);
      expect(await repo().listForCase(b, f.caseId)).toEqual([]);
      expect(await repo().listSince(b, at(-100), 100)).toEqual([]);
      await expectRejectsWithName(repo().record(a, aFeedback(b)), 'TenantMismatchError');
    });
  });
}

/** Contract every {@link ConditionRepository} adapter must pass. */
export function describeConditionRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ConditionRepository>,
): void {
  describe(`ConditionRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;
    const patient = patientId('pat-1');

    it('upserts by patient + system + code', async () => {
      const { a } = freshClinics();
      const probable = aCondition(a, {
        status: 'probable',
        confidence: 0.7,
        sourceType: 'inferred_from_medication',
      });
      await repo().upsert(a, probable);
      const confirmed = {
        ...probable,
        status: 'confirmed' as const,
        confidence: 1,
        confirmedBy: 'dr-1',
        updatedAt: at(2),
      };
      await repo().upsert(a, confirmed);
      expect(await repo().listByPatient(a, patient)).toEqual([confirmed]);
    });

    it('round-trips a condition read from a note, with its evidence', async () => {
      const { a } = freshClinics();
      const extracted = aCondition(a, {
        status: 'probable',
        confidence: 0.82,
        sourceType: 'extracted_from_note',
        source: { resourceType: 'DocumentReference', id: 'doc-1' },
        evidence: { quote: 'DM2 en tratamiento', sourceDocumentId: 'doc-1' },
      });
      await repo().upsert(a, extracted);
      expect(await repo().listByPatient(a, patient)).toEqual([extracted]);
    });

    it('keeps different codes apart and filters by status', async () => {
      const { a } = freshClinics();
      const dm = aCondition(a);
      const htn = aCondition(a, {
        code: { system: ICD10_SYSTEM, code: 'I10' },
        status: 'probable',
        confidence: 0.6,
      });
      const otherPatient = aCondition(a, { patientId: patientId('pat-2') });
      for (const c of [dm, htn, otherPatient]) await repo().upsert(a, c);
      const all = await repo().listByPatient(a, patient);
      expect(new Set(all.map((c) => c.code.code))).toEqual(new Set(['E11.9', 'I10']));
      expect(await repo().listByPatient(a, patient, ['probable'])).toEqual([htn]);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      await repo().upsert(a, aCondition(a));
      expect(await repo().listByPatient(b, patient)).toEqual([]);
      await repo().upsert(b, aCondition(b, { status: 'probable', confidence: 0.5 }));
      expect((await repo().listByPatient(a, patient))[0]?.status).toBe('confirmed');
      await expectRejectsWithName(repo().upsert(a, aCondition(b)), 'TenantMismatchError');
    });
  });
}

/** Contract every {@link QualityFindingRepository} adapter must pass. */
export function describeQualityFindingRepositoryContract(
  name: string,
  makeSubject: MakeSubject<QualityFindingRepository>,
): void {
  describe(`QualityFindingRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;
    const patient = patientId('pat-1');

    it('saves findings idempotently by id and lists them per patient', async () => {
      const { a } = freshClinics();
      const finding = aQualityFinding(a);
      await repo().save(a, finding);
      await repo().save(a, finding);
      await repo().save(a, aQualityFinding(a, { patientId: patientId('pat-2') }));
      expect(await repo().listByPatient(a, patient)).toEqual([finding]);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const finding = aQualityFinding(a);
      await repo().save(a, finding);
      expect(await repo().listByPatient(b, patient)).toEqual([]);
      await expectRejectsWithName(repo().save(a, aQualityFinding(b)), 'TenantMismatchError');
    });
  });
}

/** Contract every {@link AuditLog} adapter must pass. */
export function describeAuditLogContract(name: string, makeSubject: MakeSubject<AuditLog>): void {
  describe(`AuditLog contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const log = () => current().subject;
    const c = caseId('case-audit');

    it('appends entries and lists them chronologically per case', async () => {
      const { a } = freshClinics();
      const opened = aCaseEvent(a, { caseId: c, type: 'opened', at: at(0) });
      const escalated = aCaseEvent(a, {
        caseId: c,
        type: 'escalated',
        at: at(7),
        payload: { step: 1 },
      });
      const notified = aCaseEvent(a, {
        caseId: c,
        type: 'notified',
        actor: { type: 'user', id: 'u-1' },
        at: at(1),
      });
      for (const entry of [opened, escalated, notified]) await log().append(a, entry);
      await log().append(a, aCaseEvent(a, { caseId: caseId('case-other') }));
      expect(await log().listForCase(a, c)).toEqual([opened, notified, escalated]);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      await log().append(a, aCaseEvent(a, { caseId: c }));
      expect(await log().listForCase(b, c)).toEqual([]);
      await expectRejectsWithName(
        log().append(a, aCaseEvent(b, { caseId: c })),
        'TenantMismatchError',
      );
    });
  });
}
