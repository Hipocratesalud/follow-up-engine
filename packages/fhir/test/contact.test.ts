import { describe, expect, it } from 'vitest';
import {
  caseToTask,
  communicationToFhir,
  contactRequestToFhir,
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  mapBundleToBatches,
  suppressionToFlag,
  taskToCase,
} from '../src/index.ts';
import {
  activeSuppression,
  callAttempt,
  callBooked,
  CLINIC,
  dismissedCase,
  hostPolicyAttempt,
  revokedSuppression,
  whatsappAttempt,
  wrongNumber,
} from './domain-fixtures.ts';
import { clone, loadBundle } from './helpers.ts';

const receivedAt = new Date('2026-01-22T16:00:00Z');

function communicationBundle(
  patch: (communication: Record<string, unknown>) => void,
  type: 'transaction' | 'batch' = 'transaction',
): unknown {
  const bundle = clone(loadBundle('communication-outcome')) as {
    type: string;
    entry: { resource: Record<string, unknown> }[];
  };
  bundle.type = type;
  const [entry] = bundle.entry;
  if (entry !== undefined) {
    patch(entry.resource);
  }
  return bundle;
}

describe('CommunicationRequest (a contact attempt)', () => {
  it('is basedOn the case Task, carries a generic purpose, the channel and the deadline', () => {
    const resource = contactRequestToFhir(whatsappAttempt);
    expect(resource).toMatchObject({
      resourceType: 'CommunicationRequest',
      id: 'cr-0001',
      basedOn: [{ reference: 'Task/case-0001' }],
      status: 'active',
      category: [
        { coding: [{ system: ENGINE_CODE_SYSTEMS.contactPurpose, code: 'schedule_follow_up' }] },
      ],
      medium: [
        {
          coding: [
            { system: ENGINE_CODE_SYSTEMS.contactChannel, code: 'whatsapp' },
            { code: 'ONLINEWRIT' },
          ],
        },
      ],
      subject: { reference: 'Patient/pat-dm-0001' },
      occurrenceDateTime: '2026-04-27T12:00:00.000Z',
      authoredOn: '2026-04-20T12:00:00.000Z',
      requester: { type: 'Device' },
    });
    expect(resource.extension).toEqual(
      expect.arrayContaining([
        { url: ENGINE_EXTENSIONS.contactAttempt, valueInteger: 1 },
        { url: ENGINE_EXTENSIONS.contactTrigger, valueCode: 'policy' },
      ]),
    );
    // The payload never names a diagnosis or a test.
    expect(JSON.stringify(resource.payload)).not.toMatch(/diabet|hba1c|E11/i);
  });

  it('a default_v1 attempt has no medium: the host chooses its channel', () => {
    expect(contactRequestToFhir(hostPolicyAttempt).medium).toBeUndefined();
  });

  it('is completed once an outcome concludes it, revoked when its case closed before that', () => {
    expect(contactRequestToFhir(whatsappAttempt, { communications: [wrongNumber] }).status).toBe(
      'completed',
    );
    expect(contactRequestToFhir(callAttempt, { caseStatus: 'resolved' }).status).toBe('revoked');
    expect(
      contactRequestToFhir(callAttempt, { communications: [callBooked], caseStatus: 'resolved' })
        .status,
    ).toBe('completed');
    expect(contactRequestToFhir(callAttempt).requester).toMatchObject({
      type: 'Practitioner',
      identifier: { value: 'user-reception-1' },
    });
  });
});

describe('Communication (what came of an attempt)', () => {
  it('a wrong number: outcome extension and statusReason, basedOn the request, about the case', () => {
    const resource = communicationToFhir(wrongNumber);
    expect(resource).toMatchObject({
      resourceType: 'Communication',
      id: 'wa-msg-0002',
      meta: { versionId: '1' },
      basedOn: [{ reference: 'CommunicationRequest/cr-0001' }],
      about: [{ reference: 'Task/case-0001' }],
      status: 'not-done',
      statusReason: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.contactOutcome, code: 'wrong_number' }],
      },
      extension: [
        {
          url: ENGINE_EXTENSIONS.contactOutcome,
          valueCodeableConcept: { coding: [{ code: 'wrong_number' }] },
        },
      ],
    });
  });

  it('a call recorded in the inbox has the clinic user as sender', () => {
    const resource = communicationToFhir(callBooked);
    expect(resource.sender).toMatchObject({
      type: 'Practitioner',
      identifier: { value: 'user-reception-1' },
    });
    expect(resource.statusReason).toBeUndefined();
    expect(resource.medium?.[0]?.coding?.[1]).toMatchObject({ code: 'PHONE' });
  });
});

describe('Flag (a rule suppressed for a patient)', () => {
  it('active, category follow-up-suppression, the rule as code, the dismissal reason', () => {
    const flag = suppressionToFlag(activeSuppression);
    expect(flag).toMatchObject({
      resourceType: 'Flag',
      status: 'active',
      category: [{ coding: [{ code: 'follow-up-suppression' }] }],
      code: {
        coding: [{ system: ENGINE_CODE_SYSTEMS.expectation, code: 'protocol_diabetes_fundus' }],
      },
      subject: { reference: 'Patient/pat-dm-0001' },
      period: { start: '2026-04-15T10:00:00.000Z' },
    });
    expect(flag.period?.end).toBeUndefined();
    expect(flag.extension).toEqual(
      expect.arrayContaining([
        { url: ENGINE_EXTENSIONS.dismissReason, valueCode: 'not_applicable_to_patient' },
        {
          url: ENGINE_EXTENSIONS.sourceCase,
          valueReference: { reference: 'Task/case-0004', type: 'Task' },
        },
      ]),
    );
  });

  it('reactivated: inactive, with the end of its period', () => {
    expect(suppressionToFlag(revokedSuppression)).toMatchObject({
      status: 'inactive',
      period: { end: '2026-05-02T09:00:00.000Z' },
    });
  });
});

describe('a dismissed case Task', () => {
  it('is cancelled with the dismissal reason as statusReason, and reads back', () => {
    const task = caseToTask(dismissedCase);
    expect(task.status).toBe('cancelled');
    expect(task.statusReason).toEqual({
      coding: [{ system: ENGINE_CODE_SYSTEMS.dismissReason, code: 'not_applicable_to_patient' }],
    });
    expect(taskToCase(task, CLINIC)).toEqual(dismissedCase);
  });
});

describe('inbound Communication', () => {
  it('maps to a contact outcome on its CommunicationRequest, and no clinical event', () => {
    const result = mapBundleToBatches(loadBundle('communication-outcome'), {
      clinicId: CLINIC,
      receivedAt,
    });
    expect(result.issues).toBeUndefined();
    expect(result.batches).toEqual([]);
    expect(result.resources.map(({ resource }) => resource.resourceType)).toEqual([
      'Communication',
    ]);
    expect(result.communications).toEqual([
      {
        communication: {
          id: 'wa-msg-0001',
          requestId: 'cr-0001',
          patientId: '5f1c2a52-6d1e-4b8a-9a34-0b9f0c1d2e01',
          status: 'completed',
          channel: 'whatsapp',
          outcome: 'replied',
          sentAt: new Date('2026-01-22T12:00:00Z'),
          receivedAt: new Date('2026-01-22T15:09:00Z'),
          versionId: '2',
          lastUpdated: new Date('2026-01-22T15:10:00Z'),
        },
        entryIndex: 0,
        expression: 'Bundle.entry[0].resource',
      },
    ]);
  });

  it('reads the outcome from statusReason too, and the channel from the v3 ParticipationMode', () => {
    const result = mapBundleToBatches(
      communicationBundle((communication) => {
        delete communication['extension'];
        communication['status'] = 'not-done';
        communication['statusReason'] = {
          coding: [{ system: ENGINE_CODE_SYSTEMS.contactOutcome, code: 'wrong_number' }],
        };
        communication['medium'] = [
          {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode',
                code: 'PHONE',
              },
            ],
          },
        ];
      }),
      { clinicId: CLINIC, receivedAt },
    );
    expect(result.communications[0]?.communication).toMatchObject({
      outcome: 'wrong_number',
      channel: 'phone_call',
      status: 'not-done',
    });
  });

  it('a not-done Communication without an outcome did not reach the patient', () => {
    const result = mapBundleToBatches(
      communicationBundle((communication) => {
        delete communication['extension'];
        communication['status'] = 'not-done';
      }),
      { clinicId: CLINIC, receivedAt },
    );
    expect(result.communications[0]?.communication.outcome).toBe('no_answer');
  });

  it('a status-only update carries no outcome', () => {
    const result = mapBundleToBatches(
      communicationBundle((communication) => {
        delete communication['extension'];
        communication['status'] = 'in-progress';
      }),
      { clinicId: CLINIC, receivedAt },
    );
    expect(result.communications[0]?.communication.outcome).toBeUndefined();
  });

  it('rejects an unknown outcome code and a Communication not basedOn a CommunicationRequest', () => {
    const unknown = mapBundleToBatches(
      communicationBundle((communication) => {
        communication['extension'] = [
          {
            url: ENGINE_EXTENSIONS.contactOutcome,
            valueCodeableConcept: {
              coding: [{ system: ENGINE_CODE_SYSTEMS.contactOutcome, code: 'maybe' }],
            },
          },
        ];
      }),
      { clinicId: CLINIC, receivedAt },
    );
    expect(unknown.communications).toEqual([]);
    expect(unknown.issues?.issue[0]).toMatchObject({
      severity: 'error',
      code: 'code-invalid',
      expression: ['Bundle.entry[0].resource.extension'],
    });
    const unlinked = mapBundleToBatches(
      communicationBundle((communication) => {
        communication['basedOn'] = [{ reference: 'ServiceRequest/sr-1' }];
      }),
      { clinicId: CLINIC, receivedAt },
    );
    expect(unlinked.communications).toEqual([]);
    expect(unlinked.issues?.issue[0]).toMatchObject({
      severity: 'error',
      expression: ['Bundle.entry[0].resource.basedOn'],
    });
  });
});
