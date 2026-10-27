import { describe, expect, it } from 'vitest';
import type { ContactCommunication, ContactOutcome, ContactRequest } from '../../domain/contact.ts';
import type { CaseId, ClinicId, ContactRequestId, PatientId } from '../../domain/ids.ts';
import { summarizeAttempt } from './history.ts';

const DAY = 86_400_000;
const at = (day: number) => new Date(Date.UTC(2026, 0, 1) + day * DAY);

function request(overrides: Partial<ContactRequest> = {}): ContactRequest {
  return {
    id: 'cr-1' as ContactRequestId,
    clinicId: 'c' as ClinicId,
    patientId: 'p' as PatientId,
    caseId: 'case-1' as CaseId,
    channel: 'whatsapp',
    purpose: 'schedule_follow_up',
    trigger: 'policy',
    attempt: 1,
    requestedAt: at(0),
    dueBy: at(7),
    ...overrides,
  };
}

function communication(
  outcome: ContactOutcome | undefined,
  day: number,
  overrides: Partial<ContactCommunication> = {},
): ContactCommunication {
  return {
    id: `comm-${String(outcome)}-${String(day)}`,
    clinicId: 'c' as ClinicId,
    patientId: 'p' as PatientId,
    caseId: 'case-1' as CaseId,
    requestId: 'cr-1' as ContactRequestId,
    status: 'completed',
    ...(outcome === undefined ? {} : { outcome }),
    sender: { type: 'host' },
    recordedAt: at(day),
    ...overrides,
  };
}

describe('summarizeAttempt', () => {
  it('a message with no report is made and waits for its whole window', () => {
    expect(summarizeAttempt(request(), [])).toMatchObject({
      made: true,
      answered: false,
      windowEndsAt: at(7),
    });
    expect(summarizeAttempt(request(), []).outcome).toBeUndefined();
  });

  it('the strongest outcome wins, whatever order the reports came in', () => {
    const summary = summarizeAttempt(request(), [
      communication('replied', 2),
      communication('delivered', 3),
      communication('read', 4),
    ]);
    expect(summary).toMatchObject({ outcome: 'replied', answered: true, outcomeAt: at(2) });
    // Answered: the window ends with the answer.
    expect(summary.windowEndsAt).toEqual(at(2));
  });

  it('no answer and a wrong number end the window at once; delivered does not', () => {
    expect(summarizeAttempt(request(), [communication('no_answer', 1)]).windowEndsAt).toEqual(
      at(1),
    );
    expect(summarizeAttempt(request(), [communication('wrong_number', 2)])).toMatchObject({
      answered: false,
      windowEndsAt: at(2),
    });
    expect(summarizeAttempt(request(), [communication('delivered', 1)]).windowEndsAt).toEqual(
      at(7),
    );
  });

  it('a report after the window keeps the window end', () => {
    expect(summarizeAttempt(request(), [communication('no_answer', 9)]).windowEndsAt).toEqual(
      at(7),
    );
  });

  it('a call is made only once the team recorded what came of it', () => {
    const call = request({ channel: 'phone_call', dueBy: at(3) });
    expect(summarizeAttempt(call, []).made).toBe(false);
    expect(summarizeAttempt(call, [communication('no_answer', 1)]).made).toBe(true);
  });

  it('ignores reports entered in error, status-only reports and other attempts', () => {
    const summary = summarizeAttempt(request(), [
      communication('declined', 1, { status: 'entered-in-error' }),
      communication(undefined, 1, { status: 'in-progress' }),
      communication('treated_elsewhere', 1, { requestId: 'cr-2' as ContactRequestId }),
    ]);
    expect(summary.outcome).toBeUndefined();
    expect(summary.answered).toBe(false);
    expect(summary.communications).toHaveLength(2);
  });
});
