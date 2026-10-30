import {
  type ClinicId,
  type ExpectationEvent,
  type ExpectationEventLog,
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

/** A plan item's closure reclassified when the pregnancy ended. */
export function anExpectationEvent(
  clinic: ClinicId,
  overrides: Partial<ExpectationEvent> = {},
): ExpectationEvent {
  return {
    id: uniqueId('xev'),
    clinicId: clinic,
    patientId: patientId('pat-1'),
    expectationId: expectationId('exp-plan-1'),
    type: 'closed_reason_reclassified',
    actor: 'engine',
    at: at(1),
    fromReason: 'covered_by_order',
    toReason: 'pregnancy_ended',
    cause: 'episode_ended',
    causedBy: { resourceType: 'Condition', id: 'puerperal-dx-1' },
    relatedExpectationId: expectationId('exp-order-1'),
    ...overrides,
  };
}

/** Contract every {@link ExpectationEventLog} adapter must pass. */
export function describeExpectationEventLogContract(
  name: string,
  makeSubject: MakeSubject<ExpectationEventLog>,
): void {
  describe(`ExpectationEventLog contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const log = () => current().subject;

    it('appends events and reads them back per expectation and per patient, oldest first', async () => {
      const { a } = freshClinics();
      const item = expectationId(uniqueId('exp'));
      const patient = patientId(uniqueId('pat'));
      const later = anExpectationEvent(a, { expectationId: item, patientId: patient, at: at(3) });
      const earlier = anExpectationEvent(a, { expectationId: item, patientId: patient, at: at(1) });
      const other = anExpectationEvent(a, { patientId: patient, at: at(2) });
      const withoutRelated: { -readonly [K in keyof ExpectationEvent]: ExpectationEvent[K] } = {
        ...anExpectationEvent(a, { patientId: patient, at: at(4) }),
      };
      delete withoutRelated.relatedExpectationId;
      for (const event of [later, earlier, other, withoutRelated]) await log().append(a, event);
      expect(await log().listForExpectation(a, item)).toEqual([earlier, later]);
      expect(await log().listByPatient(a, patient)).toEqual([
        earlier,
        other,
        later,
        withoutRelated,
      ]);
    });

    it('keeps append order on the same instant', async () => {
      const { a } = freshClinics();
      const item = expectationId(uniqueId('exp'));
      const first = anExpectationEvent(a, { expectationId: item, at: at(5) });
      const second = anExpectationEvent(a, {
        expectationId: item,
        at: at(5),
        fromReason: 'pregnancy_ended',
        toReason: 'covered_by_order',
      });
      await log().append(a, first);
      await log().append(a, second);
      expect(await log().listForExpectation(a, item)).toEqual([first, second]);
    });

    it('rejects a duplicate id and another clinic’s entry; isolates clinics', async () => {
      const { a, b } = freshClinics();
      const event = anExpectationEvent(a);
      await log().append(a, event);
      await expectRejectsWithName(log().append(a, event), 'ConflictError');
      await expectRejectsWithName(log().append(a, anExpectationEvent(b)), 'TenantMismatchError');
      expect(await log().listForExpectation(b, event.expectationId)).toEqual([]);
      expect(await log().listByPatient(b, event.patientId)).toEqual([]);
    });
  });
}
