import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ClinicalEventType } from '../domain/clinical-event.ts';
import { ProtocolSchema } from './protocol.ts';
import { type Rule, RuleSchema } from './rule.ts';

const imagingResultRule = {
  id: 'imaging.result_pending',
  version: '1.0.0',
  layer: 'universal',
  description: 'An imaging order should have a result within 30 days.',
  reason: { code: 'imaging_result_pending', label: 'Resultado de imagen pendiente' },
  trigger: { event: 'service_request.created', filter: { category: 'imaging' } },
  dueInDays: 30,
  fulfilledBy: [{ event: 'result.received', match: 'same_order' }],
  notFulfilledBy: [{ event: 'appointment.cancelled' }],
  priority: 50,
  escalationPolicy: {
    steps: [
      { afterDays: 0, action: 'notify_clinic' },
      { afterDays: 7, action: 'request_patient_contact' },
      { afterDays: 30, action: 'mark_lost_to_follow_up' },
    ],
  },
  suggestedAction: {
    code: 'contact_patient',
    label: 'Contactar al paciente para completar el estudio',
    patientContactPurpose: 'complete_pending_test',
  },
};

describe('RuleSchema', () => {
  it('accepts a valid rule', () => {
    const rule: Rule = RuleSchema.parse(imagingResultRule);
    expect(rule.fulfilledBy[0]?.match).toBe('same_order');
  });

  it('rejects unknown event types, unknown keys and unsorted escalation steps', () => {
    expect(
      RuleSchema.safeParse({ ...imagingResultRule, trigger: { event: 'order.created' } }).success,
    ).toBe(false);
    expect(RuleSchema.safeParse({ ...imagingResultRule, extra: true }).success).toBe(false);
    expect(
      RuleSchema.safeParse({
        ...imagingResultRule,
        escalationPolicy: {
          steps: [
            { afterDays: 7, action: 'notify_clinic' },
            { afterDays: 0, action: 'notify_clinic' },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('types the trigger with the clinical event union', () => {
    expectTypeOf<Rule['trigger']['event']>().toEqualTypeOf<ClinicalEventType>();
  });
});

describe('ProtocolSchema', () => {
  it('accepts a valid protocol', () => {
    const protocol = ProtocolSchema.parse({
      id: 'diabetes.type2',
      version: '1.0.0',
      status: 'draft',
      sources: [
        { title: 'Standards of Care', organization: 'ADA', year: 2025, url: 'https://example.org' },
      ],
      description: 'Type 2 diabetes control cadence.',
      reason: { code: 'diabetes_control', label: 'Control de diabetes' },
      enrollment: { conditionCodes: ['E11'], minimumStatus: 'confirmed' },
      items: [
        {
          key: 'hba1c',
          kind: 'lab',
          reason: { code: 'hba1c_due', label: 'HbA1c pendiente' },
          everyDays: 90,
          fulfilledBy: [
            {
              event: 'result.received',
              filter: { 'code.code': '4548-4' },
              match: 'any',
            },
          ],
          priority: 40,
          suggestedAction: { code: 'order_lab', label: 'Indicar HbA1c' },
        },
      ],
      escalationPolicy: { steps: [{ afterDays: 0, action: 'notify_clinic' }] },
    });
    expect(protocol.items).toHaveLength(1);
  });
});
