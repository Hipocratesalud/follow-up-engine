import {
  caseId,
  patientId,
  type SuppressionRepository,
  suppressionId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aSuppression } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

/** Contract every {@link SuppressionRepository} adapter must pass. */
export function describeSuppressionRepositoryContract(
  name: string,
  makeSubject: MakeSubject<SuppressionRepository>,
): void {
  describe(`SuppressionRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    it('creates a suppression and reads it back, every optional field included', async () => {
      const { a } = freshClinics();
      const full = aSuppression(a, {
        patientId: patientId(uniqueId('pat')),
        note: 'no aplica a este paciente',
        caseId: caseId('case-9'),
        createdBy: 'dr-mora',
      });
      const bare = aSuppression(a, { patientId: patientId(uniqueId('pat')) });
      await repo().create(a, full);
      await repo().create(a, bare);
      expect(await repo().get(a, full.id)).toEqual(full);
      expect(await repo().get(a, bare.id)).toEqual(bare);
      expect(await repo().get(a, suppressionId('sup-missing'))).toBeUndefined();
    });

    it('allows one active suppression per patient and rule; other patients and rules are free', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const first = aSuppression(a, { patientId: patient });
      await repo().create(a, first);
      await expectRejectsWithName(
        repo().create(a, aSuppression(a, { patientId: patient })),
        'ConflictError',
      );
      await repo().create(a, aSuppression(a, { patientId: patientId(uniqueId('pat')) }));
      await repo().create(
        a,
        aSuppression(a, { patientId: patient, ruleId: 'cadence_break', createdAt: at(1) }),
      );
      // Once revoked, the rule can be suppressed again.
      await repo().revoke(a, first.id, { revokedAt: at(2) });
      await repo().create(a, aSuppression(a, { patientId: patient, createdAt: at(3) }));
    });

    it('revokes an active suppression once', async () => {
      const { a } = freshClinics();
      const suppression = aSuppression(a, { patientId: patientId(uniqueId('pat')) });
      await repo().create(a, suppression);
      const revoked = await repo().revoke(a, suppression.id, {
        revokedAt: at(5),
        revokedBy: 'dr-mora',
      });
      expect(revoked).toEqual({ ...suppression, revokedAt: at(5), revokedBy: 'dr-mora' });
      expect(await repo().get(a, suppression.id)).toEqual(revoked);
      expect(await repo().revoke(a, suppression.id, { revokedAt: at(6) })).toBeUndefined();
      expect(await repo().revoke(a, suppressionId('sup-missing'), { revokedAt: at(6) })).toBe(
        undefined,
      );
    });

    it('lists a patient’s suppressions newest first, revoked ones unless activeOnly', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const old = aSuppression(a, { patientId: patient, ruleId: 'rule_a', createdAt: at(1) });
      const recent = aSuppression(a, { patientId: patient, ruleId: 'rule_b', createdAt: at(3) });
      const middle = aSuppression(a, { patientId: patient, ruleId: 'rule_c', createdAt: at(2) });
      for (const item of [old, recent, middle]) await repo().create(a, item);
      await repo().create(a, aSuppression(a, { patientId: patientId(uniqueId('pat')) }));
      await repo().revoke(a, middle.id, { revokedAt: at(4) });
      expect((await repo().listForPatient(a, patient)).map((s) => s.id)).toEqual([
        recent.id,
        middle.id,
        old.id,
      ]);
      expect(
        (await repo().listForPatient(a, patient, { activeOnly: true })).map((s) => s.id),
      ).toEqual([recent.id, old.id]);
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const suppression = aSuppression(a, { patientId: patientId(uniqueId('pat')) });
      await repo().create(a, suppression);
      expect(await repo().get(b, suppression.id)).toBeUndefined();
      expect(await repo().listForPatient(b, suppression.patientId)).toEqual([]);
      expect(await repo().revoke(b, suppression.id, { revokedAt: at(1) })).toBeUndefined();
      expect((await repo().get(a, suppression.id))?.revokedAt).toBeUndefined();
      // The same patient and rule in another clinic is independent.
      await repo().create(b, aSuppression(b, { patientId: suppression.patientId }));
      await expectRejectsWithName(repo().create(a, aSuppression(b)), 'TenantMismatchError');
    });
  });
}
