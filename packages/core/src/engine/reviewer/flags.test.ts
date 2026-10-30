import { describe, expect, it } from 'vitest';
import type { FindingFlag } from '../../domain/clinical-finding.ts';
import { clinicId } from '../../domain/ids.ts';
import { inboxCategories, inInbox } from './flags.ts';

const CLINIC = clinicId('clinic-flags-test');
const AT = new Date('2026-01-05T12:00:00.000Z');

function flag(overrides: Partial<FindingFlag> & Pick<FindingFlag, 'category'>): FindingFlag {
  return {
    clinicId: CLINIC,
    enabled: true,
    mode: 'shadow',
    updatedAt: AT,
    ...overrides,
  };
}

/*
 * PRD V3 "Inbox cards per validated category": only findings of a live,
 * signed-off category reach the doctor's inbox, under the flag in force now.
 */
describe('inbox gate of the clinical reviewer flags', () => {
  it('lets nothing through while every category is in shadow', () => {
    const flags = [flag({ category: 'lab_trend' }), flag({ category: 'drug_interaction' })];
    expect(inboxCategories(flags)).toEqual([]);
    expect(inInbox(flags, { category: 'lab_trend', status: 'open' })).toBe(false);
  });

  it('lets an open finding of a live, signed-off category through, and no other', () => {
    const flags = [
      flag({ category: 'lab_trend', mode: 'live', validatedBy: 'dr.lead@example.com' }),
      flag({ category: 'drug_interaction' }),
    ];
    expect(inboxCategories(flags)).toEqual(['lab_trend']);
    expect(inInbox(flags, { category: 'lab_trend', status: 'open' })).toBe(true);
    expect(inInbox(flags, { category: 'drug_interaction', status: 'open' })).toBe(false);
    // Rated findings leave the queue.
    for (const status of ['relevant', 'already_known', 'not_relevant', 'expired']) {
      expect(inInbox(flags, { category: 'lab_trend', status })).toBe(false);
    }
  });

  it('treats a live flag without a sign-off, or switched off, as not live', () => {
    const unsigned = [flag({ category: 'lab_trend', mode: 'live' })];
    expect(inboxCategories(unsigned)).toEqual([]);
    expect(inInbox(unsigned, { category: 'lab_trend', status: 'open' })).toBe(false);
    const off = [flag({ category: 'lab_trend', mode: 'live', validatedBy: 'x', enabled: false })];
    expect(inInbox(off, { category: 'lab_trend', status: 'open' })).toBe(false);
  });

  it('honors a per-specialty shadow flag over a clinic-wide live one', () => {
    const flags = [
      flag({ category: 'lab_trend', mode: 'live', validatedBy: 'dr.lead@example.com' }),
      flag({ category: 'lab_trend', specialty: 'cardiology' }),
    ];
    expect(inInbox(flags, { category: 'lab_trend', status: 'open' })).toBe(true);
    expect(inInbox(flags, { category: 'lab_trend', specialty: 'cardiology', status: 'open' })).toBe(
      false,
    );
  });

  it('keeps pre-visit questions out of the inbox even when live (they go to "Before the visit")', () => {
    const flags = [
      flag({ category: 'pre_visit_question', mode: 'live', validatedBy: 'dr.lead@example.com' }),
    ];
    expect(inboxCategories(flags)).toEqual([]);
    expect(inInbox(flags, { category: 'pre_visit_question', status: 'open' })).toBe(false);
  });
});
