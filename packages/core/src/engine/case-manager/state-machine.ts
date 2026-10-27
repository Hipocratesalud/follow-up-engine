import { ACTIVE_CASE_STATUSES, type ActiveCaseStatus, type CaseStatus } from '../../domain/case.ts';
import { InvalidCaseTransitionError } from '../../domain/errors.ts';

/**
 * Allowed case transitions (diagram in packages/core/README.md).
 * `resolved`, `dismissed` and `lost_to_follow_up` are terminal; a snoozed
 * case wakes up to the status it had before.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  open: ['notified', 'snoozed', 'escalated', 'resolved', 'dismissed', 'lost_to_follow_up'],
  notified: ['snoozed', 'escalated', 'resolved', 'dismissed', 'lost_to_follow_up'],
  snoozed: [
    'open',
    'notified',
    'escalated',
    'snoozed',
    'resolved',
    'dismissed',
    'lost_to_follow_up',
  ],
  escalated: ['snoozed', 'resolved', 'dismissed', 'lost_to_follow_up'],
  resolved: [],
  dismissed: [],
  lost_to_follow_up: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

/** @throws {InvalidCaseTransitionError} */
export function assertCaseTransition(caseId: string, from: CaseStatus, to: CaseStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidCaseTransitionError(caseId, from, to);
  }
}

export function isActiveCaseStatus(status: CaseStatus): status is ActiveCaseStatus {
  return (ACTIVE_CASE_STATUSES as readonly CaseStatus[]).includes(status);
}
