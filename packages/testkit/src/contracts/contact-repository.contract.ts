import {
  caseId,
  type ContactRepository,
  contactRequestId,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { aCommunication, aContactRequest } from './builders.ts';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  uniqueId,
  useSubject,
} from './harness.ts';

/** Contract every {@link ContactRepository} adapter must pass. */
export function describeContactRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ContactRepository>,
): void {
  describe(`ContactRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;

    describe('requests', () => {
      it('creates an attempt and reads it back, every optional field included', async () => {
        const { a } = freshClinics();
        const full = aContactRequest(a, { requestedBy: 'nurse-ana', trigger: 'user' });
        const withOptionals = aContactRequest(a, { attempt: 2 });
        const withoutOptionals = { ...withOptionals };
        delete withoutOptionals.channel;
        delete withoutOptionals.policyStep;
        await repo().createRequest(a, full);
        await repo().createRequest(a, withoutOptionals);
        expect(await repo().getRequest(a, full.id)).toEqual(full);
        expect(await repo().getRequest(a, full.id, { forUpdate: true })).toEqual(full);
        expect(await repo().getRequest(a, withOptionals.id)).toEqual(withoutOptionals);
        expect(await repo().getRequest(a, contactRequestId('cr-missing'))).toBeUndefined();
      });

      it('rejects a duplicate id with ConflictError', async () => {
        const { a } = freshClinics();
        const request = aContactRequest(a);
        await repo().createRequest(a, request);
        await expectRejectsWithName(repo().createRequest(a, request), 'ConflictError');
      });

      it('lists a patient’s attempts across cases and a case’s attempts, by requestedAt', async () => {
        const { a } = freshClinics();
        const patient = patientId(uniqueId('pat'));
        const case1 = caseId(uniqueId('case'));
        const case2 = caseId(uniqueId('case'));
        const third = aContactRequest(a, {
          patientId: patient,
          caseId: case1,
          requestedAt: at(28),
        });
        const first = aContactRequest(a, {
          patientId: patient,
          caseId: case1,
          requestedAt: at(14),
        });
        const second = aContactRequest(a, {
          patientId: patient,
          caseId: case2,
          channel: 'phone_call',
          requestedAt: at(21),
        });
        const otherPatient = aContactRequest(a, { requestedAt: at(1) });
        for (const request of [third, first, second, otherPatient]) {
          await repo().createRequest(a, request);
        }
        expect((await repo().listRequestsForPatient(a, patient)).map((r) => r.id)).toEqual([
          first.id,
          second.id,
          third.id,
        ]);
        expect((await repo().listRequestsForCase(a, case1)).map((r) => r.id)).toEqual([
          first.id,
          third.id,
        ]);
      });

      it('isolates clinics and rejects another clinic’s attempt', async () => {
        const { a, b } = freshClinics();
        const request = aContactRequest(a);
        await repo().createRequest(a, request);
        expect(await repo().getRequest(b, request.id)).toBeUndefined();
        expect(await repo().listRequestsForPatient(b, request.patientId)).toEqual([]);
        expect(await repo().listRequestsForCase(b, request.caseId)).toEqual([]);
        await expectRejectsWithName(
          repo().createRequest(a, aContactRequest(b)),
          'TenantMismatchError',
        );
      });
    });

    describe('communications', () => {
      it('stores a new communication and reads it back', async () => {
        const { a } = freshClinics();
        const communication = aCommunication(a, {
          versionId: '1',
          lastUpdated: at(14),
          receivedAt: at(15),
          sender: { type: 'user', id: 'nurse-ana' },
        });
        const result = await repo().saveCommunication(a, communication);
        expect(result).toEqual({ communication, changed: true, stale: false });
        expect(await repo().getCommunication(a, communication.id)).toEqual(communication);
        expect(await repo().getCommunication(a, 'comm-missing')).toBeUndefined();
      });

      it('a re-delivered version changes nothing', async () => {
        const { a } = freshClinics();
        const communication = aCommunication(a, { versionId: '2' });
        await repo().saveCommunication(a, communication);
        const again = await repo().saveCommunication(a, { ...communication, recordedAt: at(20) });
        expect(again).toEqual({
          communication,
          changed: false,
          stale: false,
          previous: communication,
        });
        expect(await repo().getCommunication(a, communication.id)).toEqual(communication);
      });

      it('an older numeric version is stale and not stored; a newer one replaces it', async () => {
        const { a } = freshClinics();
        const v2 = aCommunication(a, { versionId: '2', outcome: 'read' });
        await repo().saveCommunication(a, v2);
        const older = await repo().saveCommunication(a, {
          ...v2,
          versionId: '1',
          outcome: 'delivered',
        });
        expect(older).toMatchObject({ changed: false, stale: true, communication: v2 });
        // Numeric, not lexical: 10 is newer than 2.
        const v10 = { ...v2, versionId: '10', outcome: 'replied' as const, recordedAt: at(16) };
        const newer = await repo().saveCommunication(a, v10);
        expect(newer).toEqual({ communication: v10, changed: true, stale: false, previous: v2 });
        expect(await repo().getCommunication(a, v2.id)).toEqual(v10);
      });

      it('orders versions by lastUpdated when they carry no numeric versionId', async () => {
        const { a } = freshClinics();
        const later = aCommunication(a, { lastUpdated: at(16), outcome: 'replied' });
        await repo().saveCommunication(a, later);
        const earlier = await repo().saveCommunication(a, {
          ...later,
          lastUpdated: at(15),
          outcome: 'delivered',
        });
        expect(earlier).toMatchObject({ changed: false, stale: true });
        const newest = { ...later, lastUpdated: at(17), outcome: 'booked' as const };
        expect(await repo().saveCommunication(a, newest)).toMatchObject({
          changed: true,
          stale: false,
          previous: later,
        });
      });

      it('without versions, a different content is newer and the same content a re-delivery', async () => {
        const { a } = freshClinics();
        const first = aCommunication(a, { outcome: 'delivered' });
        await repo().saveCommunication(a, first);
        expect(await repo().saveCommunication(a, { ...first })).toMatchObject({
          changed: false,
          stale: false,
        });
        const changed = { ...first, status: 'not-done' as const, outcome: 'no_answer' as const };
        expect(await repo().saveCommunication(a, changed)).toMatchObject({
          changed: true,
          previous: first,
        });
        expect(await repo().getCommunication(a, first.id)).toEqual(changed);
      });

      it('lists communications by patient and by case, by recordedAt', async () => {
        const { a } = freshClinics();
        const patient = patientId(uniqueId('pat'));
        const case1 = caseId(uniqueId('case'));
        const late = aCommunication(a, { patientId: patient, caseId: case1, recordedAt: at(20) });
        const early = aCommunication(a, { patientId: patient, caseId: case1, recordedAt: at(15) });
        const otherCase = aCommunication(a, {
          patientId: patient,
          caseId: caseId(uniqueId('case')),
          recordedAt: at(18),
        });
        for (const item of [late, early, otherCase]) await repo().saveCommunication(a, item);
        expect((await repo().listCommunicationsForPatient(a, patient)).map((c) => c.id)).toEqual([
          early.id,
          otherCase.id,
          late.id,
        ]);
        expect((await repo().listCommunicationsForCase(a, case1)).map((c) => c.id)).toEqual([
          early.id,
          late.id,
        ]);
      });

      it('isolates clinics and rejects another clinic’s communication', async () => {
        const { a, b } = freshClinics();
        const communication = aCommunication(a);
        await repo().saveCommunication(a, communication);
        expect(await repo().getCommunication(b, communication.id)).toBeUndefined();
        expect(await repo().listCommunicationsForPatient(b, communication.patientId)).toEqual([]);
        expect(await repo().listCommunicationsForCase(b, communication.caseId)).toEqual([]);
        // The same id in another clinic is another communication.
        const theirs = aCommunication(b, { id: communication.id, outcome: 'replied' });
        expect(await repo().saveCommunication(b, theirs)).toMatchObject({ changed: true });
        expect(await repo().getCommunication(a, communication.id)).toEqual(communication);
        await expectRejectsWithName(
          repo().saveCommunication(a, aCommunication(b)),
          'TenantMismatchError',
        );
      });
    });

    describe('flags', () => {
      it('raises, replaces and clears a flag; one per patient and issue', async () => {
        const { a, b } = freshClinics();
        const patient = patientId(uniqueId('pat'));
        const raised = {
          clinicId: a,
          patientId: patient,
          issue: 'wrong_number' as const,
          raisedAt: at(15),
          communicationId: 'comm-1',
          channel: 'whatsapp' as const,
        };
        await repo().saveFlag(a, raised);
        expect(await repo().listFlags(a, patient)).toEqual([raised]);
        const cleared = { ...raised, clearedAt: at(20) };
        await repo().saveFlag(a, cleared);
        expect(await repo().listFlags(a, patient)).toEqual([cleared]);
        const again = {
          clinicId: a,
          patientId: patient,
          issue: 'wrong_number' as const,
          raisedAt: at(30),
          communicationId: 'comm-2',
        };
        await repo().saveFlag(a, again);
        expect(await repo().listFlags(a, patient)).toEqual([again]);
        expect(await repo().listFlags(b, patient)).toEqual([]);
        expect(await repo().listFlags(a, patientId(uniqueId('pat')))).toEqual([]);
        await expectRejectsWithName(
          repo().saveFlag(a, { ...raised, clinicId: b }),
          'TenantMismatchError',
        );
      });
    });
  });
}
