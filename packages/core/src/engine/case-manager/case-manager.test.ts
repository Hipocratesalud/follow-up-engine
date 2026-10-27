import { describe, expect, it } from 'vitest';
import { CASE_STATUSES } from '../../domain/case.ts';
import { InvalidCaseTransitionError } from '../../domain/errors.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { computeCasePriority, PRIORITY_WEIGHTS } from './priority.ts';
import {
  assertCaseTransition,
  canTransition,
  CASE_TRANSITIONS,
  isActiveCaseStatus,
} from './state-machine.ts';

describe('case state machine', () => {
  it('declares every status and keeps closed statuses terminal', () => {
    expect(Object.keys(CASE_TRANSITIONS).sort()).toEqual([...CASE_STATUSES].sort());
    for (const terminal of ['resolved', 'dismissed', 'lost_to_follow_up'] as const) {
      expect(CASE_TRANSITIONS[terminal]).toEqual([]);
      expect(isActiveCaseStatus(terminal)).toBe(false);
    }
  });

  it('allows the workflow transitions and rejects the rest', () => {
    expect(canTransition('open', 'notified')).toBe(true);
    expect(canTransition('snoozed', 'escalated')).toBe(true);
    expect(canTransition('escalated', 'notified')).toBe(false);
    expect(() => {
      assertCaseTransition('case-1', 'resolved', 'snoozed');
    }).toThrow(InvalidCaseTransitionError);
    expect(() => {
      assertCaseTransition('case-1', 'open', 'resolved');
    }).not.toThrow();
  });
});

describe('computeCasePriority', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');
  const expectation = (overrides: Partial<Expectation>): Expectation =>
    ({
      layer: 'universal',
      matchKey: 'visit',
      dueAt: now,
      ...overrides,
    }) as Expectation;

  it('adds bonuses for chronic patients, pending results, overdue days and extra reasons', () => {
    const base = computeCasePriority({
      reasons: [{ expectation: expectation({}), definition: undefined }],
      chronic: false,
      now,
    });
    expect(base).toBe(0);
    const rich = computeCasePriority({
      reasons: [
        {
          expectation: expectation({
            matchKey: 'loinc:4548-4',
            dueAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
          definition: undefined,
        },
        { expectation: expectation({ layer: 'protocol' }), definition: undefined },
      ],
      chronic: false,
      now,
    });
    expect(rich).toBe(
      PRIORITY_WEIGHTS.chronicCondition +
        PRIORITY_WEIGHTS.pendingResults +
        PRIORITY_WEIGHTS.maxOverdueDays +
        PRIORITY_WEIGHTS.perExtraReason,
    );
  });
});
