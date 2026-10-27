import { describe, expect, it } from 'vitest';
import { EscalationPolicySchema } from './common.ts';
import { ConfigValidationError, loadEscalationPoliciesFromJson } from './loader.ts';

/** `config/rules/escalation/default_v2.json`, inline (core reads no files). */
const DEFAULT_V2 = {
  id: 'default_v2',
  steps: [
    { afterDays: 0, action: 'notify_clinic' },
    { afterDays: 14, action: 'raise_priority', priorityDelta: 20 },
    {
      afterDays: 14,
      action: 'request_patient_contact',
      channel: 'whatsapp',
      answerWindowDays: 7,
    },
    {
      afterDays: 21,
      action: 'request_patient_contact',
      channel: 'phone_call',
      answerWindowDays: 3,
      skipIfAnswered: true,
    },
    { afterDays: 21, action: 'escalate_to_coordinator' },
    {
      afterDays: 28,
      action: 'request_patient_contact',
      channel: 'whatsapp',
      answerWindowDays: 7,
      skipIfAnswered: true,
    },
    { afterDays: 35, action: 'mark_lost_to_follow_up' },
  ],
};

function issuesOf(document: unknown): readonly string[] {
  try {
    loadEscalationPoliciesFromJson([document]);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues;
    }
    throw error;
  }
  return [];
}

describe('escalation policy schema', () => {
  it('loads multi-attempt, multi-channel policies (default_v2)', () => {
    const [policy] = loadEscalationPoliciesFromJson([DEFAULT_V2]);
    expect(policy?.steps.filter((step) => step.action === 'request_patient_contact')).toEqual([
      expect.objectContaining({ channel: 'whatsapp', answerWindowDays: 7 }),
      expect.objectContaining({ channel: 'phone_call', skipIfAnswered: true }),
      expect.objectContaining({ channel: 'whatsapp', skipIfAnswered: true }),
    ]);
  });

  it('keeps policies without channels valid (default_v1)', () => {
    expect(
      EscalationPolicySchema.safeParse({
        id: 'default_v1',
        steps: [
          { afterDays: 0, action: 'notify_clinic' },
          { afterDays: 14, action: 'request_patient_contact' },
          { afterDays: 35, action: 'mark_lost_to_follow_up' },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a channel, a window or skipIfAnswered only on a contact step', () => {
    const issues = issuesOf({
      id: 'broken',
      steps: [
        { afterDays: 0, action: 'notify_clinic', channel: 'whatsapp' },
        { afterDays: 7, action: 'escalate_to_coordinator', answerWindowDays: 3 },
        { afterDays: 9, action: 'raise_priority', skipIfAnswered: true },
      ],
    });
    expect(issues).toEqual([
      'document[0].steps.0.channel: only a request_patient_contact step takes channel',
      'document[0].steps.1.answerWindowDays: only a request_patient_contact step takes answerWindowDays',
      'document[0].steps.2.skipIfAnswered: only a request_patient_contact step takes skipIfAnswered',
    ]);
  });

  it('rejects unknown channels and negative windows', () => {
    const steps = (step: object) => ({ id: 'x', steps: [{ afterDays: 0, ...step }] });
    expect(
      issuesOf(steps({ action: 'request_patient_contact', channel: 'carrier_pigeon' })),
    ).toHaveLength(1);
    expect(
      issuesOf(steps({ action: 'request_patient_contact', answerWindowDays: -1 })),
    ).toHaveLength(1);
  });
});
