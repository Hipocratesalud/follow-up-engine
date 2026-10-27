import { describe, expect, it } from 'vitest';
import { nextActionAfter } from './schedule.ts';

describe('nextActionAfter', () => {
  const policy = {
    steps: [
      { afterDays: 0, action: 'notify_clinic' as const },
      { afterDays: 14, action: 'raise_priority' as const },
      { afterDays: 14, action: 'request_patient_contact' as const },
      { afterDays: 21, action: 'escalate_to_coordinator' as const },
    ],
  };
  const from = new Date('2026-01-01T00:00:00.000Z');

  it('waits the gap between consecutive steps', () => {
    expect(nextActionAfter(policy, 0, from)).toEqual(from);
    expect(nextActionAfter(policy, 1, from)).toEqual(new Date('2026-01-15T00:00:00.000Z'));
    expect(nextActionAfter(policy, 2, from)).toEqual(from);
    expect(nextActionAfter(policy, 3, from)).toEqual(new Date('2026-01-08T00:00:00.000Z'));
    expect(nextActionAfter(policy, 4, from)).toBeUndefined();
  });
});
