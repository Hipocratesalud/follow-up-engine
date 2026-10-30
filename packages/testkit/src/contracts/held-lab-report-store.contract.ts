import {
  type ClinicId,
  type HeldLabReport,
  type HeldLabReportStore,
  patientId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { at, freshClinics, type MakeSubject, uniqueId, useSubject } from './harness.ts';

function report(clinicId: ClinicId, overrides: Partial<HeldLabReport> = {}): HeldLabReport {
  return {
    id: uniqueId('held'),
    clinicId,
    patientId: patientId('pat-held'),
    documentKey: uniqueId('key'),
    filename: 'informe.pdf',
    documentDate: at(1),
    effectiveAt: at(0),
    printedDate: at(0),
    printedName: 'Laura Beatriz Ortega',
    recordName: 'Rafael Antonio Méndez',
    reason: 'name_mismatch',
    source: 'text',
    model: 'fake:fake-vision',
    results: [
      {
        name: 'Hemoglobina glicosilada (HbA1c)',
        groupId: 'hba1c',
        test: 'HbA1c',
        code: { system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' },
        value: 6.1,
        unit: '%',
        referenceLow: 4,
        referenceHigh: 5.6,
        interpretation: 'H',
      },
    ],
    status: 'pending',
    createdAt: at(2),
    ...overrides,
  };
}

/** Contract of every {@link HeldLabReportStore} adapter (memory, Postgres). */
export function describeHeldLabReportStoreContract(
  adapter: string,
  makeSubject: MakeSubject<HeldLabReportStore>,
): void {
  describe(`HeldLabReportStore contract (${adapter})`, () => {
    const subject = useSubject(async () => {
      const made = await makeSubject();
      return { store: made.subject, cleanup: made.cleanup };
    });

    it('holds a report and reads it back as stored (by id, by document key, listed)', async () => {
      const { a } = freshClinics();
      const held = report(a);
      expect(await subject().store.hold(held)).toEqual(held);
      expect(await subject().store.get(a, held.id)).toEqual(held);
      expect(await subject().store.findByDocumentKey(a, held.documentKey)).toEqual(held);
      expect(await subject().store.list(a, { status: 'pending' })).toEqual([held]);
    });

    it('holds one report per document key: a repeat returns the stored one', async () => {
      const { a } = freshClinics();
      const first = report(a);
      const repeat = report(a, { documentKey: first.documentKey });
      await subject().store.hold(first);
      expect((await subject().store.hold(repeat)).id).toBe(first.id);
      expect(await subject().store.list(a)).toHaveLength(1);
    });

    it('records one decision with who and when; a second decision changes nothing', async () => {
      const { a } = freshClinics();
      const held = report(a);
      await subject().store.hold(held);
      const decided = await subject().store.decide(a, held.id, {
        status: 'confirmed',
        by: 'doctor@example.com',
        at: at(3),
      });
      expect(decided).toMatchObject({ status: 'confirmed', decidedBy: 'doctor@example.com' });
      expect(decided?.decidedAt?.getTime()).toBe(at(3).getTime());
      expect(
        await subject().store.decide(a, held.id, { status: 'discarded', by: 'x', at: at(4) }),
      ).toBeUndefined();
      expect(await subject().store.list(a, { status: 'pending' })).toEqual([]);
      expect((await subject().store.get(a, held.id))?.status).toBe('confirmed');
    });

    it('filters by patient and never shows another clinic’s reports', async () => {
      const { a, b } = freshClinics();
      await subject().store.hold(report(a));
      await subject().store.hold(report(a, { patientId: patientId('pat-other') }));
      expect(await subject().store.list(a, { patientId: patientId('pat-held') })).toHaveLength(1);
      expect(await subject().store.list(b)).toEqual([]);
      const held = report(a);
      await subject().store.hold(held);
      expect(await subject().store.get(b, held.id)).toBeUndefined();
      expect(
        await subject().store.decide(b, held.id, { status: 'discarded', by: 'x', at: at(5) }),
      ).toBeUndefined();
    });
  });
}
