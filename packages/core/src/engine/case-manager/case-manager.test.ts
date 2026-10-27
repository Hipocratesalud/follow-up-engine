import { describe, expect, it } from 'vitest';
import { CASE_STATUSES } from '../../domain/case.ts';
import { InvalidCaseTransitionError } from '../../domain/errors.ts';
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
