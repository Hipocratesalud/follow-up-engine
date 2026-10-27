import type { RuleOverrideStore } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  at,
  expectRejectsWithName,
  freshClinics,
  type MakeSubject,
  useSubject,
} from './harness.ts';

const LAB = 'lab_order_result_pending';
const IMAGING = 'imaging_order_result_pending';

/** Contract every {@link RuleOverrideStore} adapter must pass (HIP-141). */
export function describeRuleOverrideStoreContract(
  name: string,
  makeSubject: MakeSubject<RuleOverrideStore>,
): void {
  describe(`RuleOverrideStore contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const store = () => current().subject;

    it('writes an override, keeps it with who, when and why, and versions it', async () => {
      const { a } = freshClinics();
      expect(await store().list(a)).toEqual([]);
      expect(await store().revision(a)).toBe(0);
      const change = await store().write(a, {
        ruleId: LAB,
        override: { dueInDays: 10 },
        actor: 'dr-ruiz',
        reason: 'Lab turnaround is 7 days here',
        at: at(1),
      });
      expect(change).toEqual({
        clinicId: a,
        ruleId: LAB,
        version: 1,
        action: 'set',
        next: { dueInDays: 10 },
        actor: 'dr-ruiz',
        reason: 'Lab turnaround is 7 days here',
        at: at(1),
      });
      const record = {
        clinicId: a,
        ruleId: LAB,
        override: { dueInDays: 10 },
        version: 1,
        updatedAt: at(1),
        updatedBy: 'dr-ruiz',
        reason: 'Lab turnaround is 7 days here',
      };
      expect(await store().get(a, LAB)).toEqual(record);
      expect(await store().list(a)).toEqual([record]);
      expect(await store().revision(a)).toBe(1);
    });

    it('records old → new on every change; a reset removes the override and still counts', async () => {
      const { a } = freshClinics();
      const meta = { actor: 'ops', reason: 'tuning' };
      await store().write(a, { ruleId: LAB, override: { dueInDays: 10 }, ...meta, at: at(1) });
      const disabled = await store().write(a, {
        ruleId: LAB,
        override: { dueInDays: 10, enabled: false },
        ...meta,
        at: at(2),
      });
      expect(disabled).toMatchObject({
        version: 2,
        action: 'set',
        previous: { dueInDays: 10 },
        next: { dueInDays: 10, enabled: false },
      });
      const reset = await store().write(a, { ruleId: LAB, ...meta, at: at(3) });
      expect(reset).toMatchObject({
        version: 3,
        action: 'reset',
        previous: { dueInDays: 10, enabled: false },
      });
      expect(reset.next).toBeUndefined();
      expect(await store().get(a, LAB)).toBeUndefined();
      // Versions keep counting after a reset.
      const again = await store().write(a, {
        ruleId: LAB,
        override: { dueInDays: 20 },
        ...meta,
        at: at(4),
      });
      expect(again).toMatchObject({ version: 4 });
      expect(again.previous).toBeUndefined();
      expect((await store().get(a, LAB))?.version).toBe(4);
      expect((await store().history(a)).map((change) => change.version)).toEqual([4, 3, 2, 1]);
      expect(await store().history(a, { ruleId: LAB, limit: 2 })).toHaveLength(2);
      expect(await store().revision(a)).toBe(4);
    });

    it('versions each rule on its own and lists them by rule id', async () => {
      const { a } = freshClinics();
      const meta = { actor: 'ops', reason: 'tuning', at: at(1) };
      await store().write(a, { ruleId: LAB, override: { dueInDays: 10 }, ...meta });
      await store().write(a, { ruleId: IMAGING, override: { enabled: false }, ...meta });
      expect((await store().get(a, IMAGING))?.version).toBe(1);
      expect((await store().list(a)).map((record) => record.ruleId)).toEqual([IMAGING, LAB]);
      expect((await store().history(a, { ruleId: IMAGING })).map((c) => c.ruleId)).toEqual([
        IMAGING,
      ]);
    });

    it('refuses a change based on a stale version, and writes nothing', async () => {
      const { a } = freshClinics();
      const meta = { actor: 'ops', reason: 'tuning', at: at(1) };
      await store().write(a, {
        ruleId: LAB,
        override: { dueInDays: 10 },
        ...meta,
        expectedVersion: 0,
      });
      await expectRejectsWithName(
        store().write(a, { ruleId: LAB, override: { dueInDays: 5 }, ...meta, expectedVersion: 0 }),
        'ConflictError',
      );
      expect((await store().get(a, LAB))?.override).toEqual({ dueInDays: 10 });
      expect(await store().revision(a)).toBe(1);
      await store().write(a, {
        ruleId: LAB,
        override: { dueInDays: 5 },
        ...meta,
        expectedVersion: 1,
      });
      expect((await store().get(a, LAB))?.override).toEqual({ dueInDays: 5 });
    });

    it('isolates clinics', async () => {
      const { a, b } = freshClinics();
      const meta = { actor: 'ops', reason: 'tuning', at: at(1) };
      await store().write(a, { ruleId: LAB, override: { dueInDays: 10 }, ...meta });
      expect(await store().list(b)).toEqual([]);
      expect(await store().get(b, LAB)).toBeUndefined();
      expect(await store().history(b)).toEqual([]);
      expect(await store().revision(b)).toBe(0);
      // Same rule, independent versions per clinic.
      expect(
        (await store().write(b, { ruleId: LAB, override: { enabled: false }, ...meta })).version,
      ).toBe(1);
      expect((await store().get(a, LAB))?.override).toEqual({ dueInDays: 10 });
    });
  });
}
