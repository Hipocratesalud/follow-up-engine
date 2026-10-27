import { describe, expect, it } from 'vitest';
import { caseToTask, ENGINE_EXTENSIONS, mapBundleToBatches } from '../src/index.ts';
import { escalatedCase, expiredPlanExpectation, openExpectation } from './domain-fixtures.ts';
import { clone, loadBundle } from './helpers.ts';

/**
 * HIP-141: the origin a host claims on a FHIR Appointment, and the rule and
 * protocol versions on a case Task. R4 validity of both shapes is checked in
 * fhir-schema.test.ts.
 */

const OPTIONS = { clinicId: 'clinic-demo', receivedAt: new Date('2026-01-20T13:00:00Z') };

interface AppointmentJson {
  extension?: unknown[];
  basedOn?: unknown[];
  supportingInformation?: unknown[];
}

function appointmentOf(bundle: Record<string, unknown>): AppointmentJson {
  const entries = bundle['entry'] as { resource: AppointmentJson }[];
  const first = entries[0];
  if (first === undefined) throw new Error('fixture without entries');
  return first.resource;
}

function bookedEvent(bundle: unknown) {
  const mapped = mapBundleToBatches(bundle, OPTIONS);
  const event = mapped.batches.flatMap((batch) => batch.events)[0];
  return { event, issues: mapped.issues?.issue ?? [] };
}

describe('Appointment attribution (inbound)', () => {
  it('reads the case Task and the CommunicationRequest the booking answers', () => {
    const { event, issues } = bookedEvent(loadBundle('appointment-attributed'));
    expect(issues.filter((issue) => issue.severity !== 'information')).toEqual([]);
    expect(event).toMatchObject({
      type: 'appointment.booked',
      // The contact attempt is the more specific claim: the engine verifies it first.
      origin: { type: 'patient_contact', caseId: 'case-0001', contactRequestId: 'cr-0001' },
    });
  });

  it('a case Task alone is a follow_up_case claim, from basedOn too', () => {
    const bundle = clone(loadBundle('appointment-attributed'));
    const appointment = appointmentOf(bundle);
    delete appointment.extension;
    delete appointment.supportingInformation;
    appointment.basedOn = [{ reference: 'ServiceRequest/sr-1' }, { reference: 'Task/case-0009' }];
    expect(bookedEvent(bundle).event).toMatchObject({
      origin: { type: 'follow_up_case', caseId: 'case-0009' },
    });
  });

  it('an Appointment that names nothing is organic (no origin)', () => {
    const { event } = bookedEvent(loadBundle('appointment-booked'));
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty('origin');
  });

  it('warns about an origin extension that points elsewhere, and ignores it', () => {
    const bundle = clone(loadBundle('appointment-attributed'));
    const appointment = appointmentOf(bundle);
    delete appointment.supportingInformation;
    appointment.basedOn = [];
    appointment.extension = [
      { url: ENGINE_EXTENSIONS.followUpOriginCase, valueReference: { reference: 'Patient/p-1' } },
    ];
    const { event, issues } = bookedEvent(bundle);
    expect(event).not.toHaveProperty('origin');
    expect(issues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'value' }));
  });
});

describe('case Task: rule and protocol version per reason (outbound)', () => {
  it('puts the versioned rule behind each reason on its input', () => {
    const task = caseToTask(escalatedCase, {
      reasons: [expiredPlanExpectation, openExpectation],
    });
    expect(task.input?.map((input) => input.extension)).toEqual([
      [
        {
          url: ENGINE_EXTENSIONS.reasonRule,
          extension: [
            { url: 'ruleId', valueCode: 'doctor_plan_followup' },
            { url: 'ruleVersion', valueString: '1.2.0' },
            { url: 'layer', valueCode: 'doctor_plan' },
            { url: 'protocolId', valueCode: 'diabetes' },
            { url: 'protocolVersion', valueString: '1.0.0' },
          ],
        },
      ],
      [
        {
          url: ENGINE_EXTENSIONS.reasonRule,
          extension: [
            { url: 'ruleId', valueCode: 'lab_order_result_pending' },
            { url: 'ruleVersion', valueString: '1.0.0' },
            { url: 'layer', valueCode: 'universal' },
          ],
        },
      ],
    ]);
  });

  it('without the reasons, the inputs stay as before', () => {
    expect(caseToTask(escalatedCase).input?.every((input) => input.extension === undefined)).toBe(
      true,
    );
  });
});
