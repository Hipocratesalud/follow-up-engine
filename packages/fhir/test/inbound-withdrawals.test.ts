import { describe, expect, it } from 'vitest';
import { type BundleMappingResult, mapBundleToBatches } from '../src/index.ts';

/**
 * A new version of a resource the host sent before can withdraw it (an order
 * revoked, a prescription stopped, a diagnosis refuted, a note or a result
 * entered in error) or withdraw a booking (no-show).
 */

const OPTIONS = { clinicId: 'clinic-demo', receivedAt: new Date('2026-01-07T20:00:00Z') };
const PATIENT_REF = { reference: 'Patient/p-1' };
const UPDATED = '2026-01-07T10:00:00Z';

function map(resource: Record<string, unknown>): BundleMappingResult {
  return mapBundleToBatches(
    {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        {
          resource,
          request: {
            method: 'PUT',
            url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
          },
        },
      ],
    },
    OPTIONS,
  );
}

function events(result: BundleMappingResult) {
  return result.batches.flatMap((batch) => batch.events);
}

const meta = { versionId: '2', lastUpdated: UPDATED };

describe('withdrawn resources', () => {
  it.each([
    ['revoked', 'revoked'],
    ['entered-in-error', 'entered_in_error'],
  ])('a %s ServiceRequest withdraws the order', (status, reason) => {
    const result = map({
      resourceType: 'ServiceRequest',
      id: 'sr-1',
      meta,
      status,
      intent: 'order',
      code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
      subject: PATIENT_REF,
    });
    expect(events(result)).toMatchObject([
      {
        type: 'record.withdrawn',
        reason,
        source: { resourceType: 'ServiceRequest', id: 'sr-1' },
        occurredAt: new Date(UPDATED),
        idempotencyKey: 'ServiceRequest/sr-1/2#record.withdrawn',
      },
    ]);
  });

  it.each([
    ['stopped', 'stopped'],
    ['cancelled', 'cancelled'],
    ['entered-in-error', 'entered_in_error'],
  ])('a %s MedicationRequest withdraws the prescription', (status, reason) => {
    const result = map({
      resourceType: 'MedicationRequest',
      id: 'mr-1',
      meta,
      status,
      intent: 'order',
      medicationCodeableConcept: { text: 'Amoxicilina 500 mg' },
      subject: PATIENT_REF,
    });
    expect(events(result)).toMatchObject([{ type: 'record.withdrawn', reason }]);
  });

  it.each([
    ['refuted', 'refuted'],
    ['entered-in-error', 'entered_in_error'],
  ])('a %s Condition withdraws the diagnosis', (code, reason) => {
    const result = map({
      resourceType: 'Condition',
      id: 'dx-1',
      meta,
      verificationStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code }],
      },
      code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'E11.9' }] },
      subject: PATIENT_REF,
    });
    expect(events(result)).toMatchObject([{ type: 'record.withdrawn', reason }]);
  });

  it.each([
    [{ status: 'entered-in-error' }, 'entered_in_error'],
    [{ status: 'current', docStatus: 'entered-in-error' }, 'entered_in_error'],
    [{ status: 'superseded' }, 'superseded'],
  ])('a DocumentReference %o withdraws the note', (statuses, reason) => {
    const result = map({
      resourceType: 'DocumentReference',
      id: 'note-1',
      meta,
      ...statuses,
      subject: PATIENT_REF,
      content: [{ attachment: { contentType: 'text/plain', data: 'UGxhbg==' } }],
    });
    expect(events(result)).toMatchObject([{ type: 'record.withdrawn', reason }]);
  });

  it.each([
    ['entered-in-error', 'entered_in_error'],
    ['cancelled', 'cancelled'],
  ])('a %s Observation withdraws the result', (status, reason) => {
    const result = map({
      resourceType: 'Observation',
      id: 'obs-1',
      meta,
      status,
      code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
      subject: PATIENT_REF,
    });
    expect(events(result)).toMatchObject([{ type: 'record.withdrawn', reason }]);
  });

  it.each([
    ['noshow', 'no_show'],
    ['entered-in-error', 'entered_in_error'],
  ])('a %s Appointment withdraws the booking', (status, reason) => {
    const result = map({
      resourceType: 'Appointment',
      id: 'ap-1',
      meta,
      status,
      start: '2026-01-06T10:00:00Z',
      participant: [{ actor: PATIENT_REF, status: 'accepted' }],
    });
    expect(events(result)).toMatchObject([
      { type: 'appointment.cancelled', reason, scheduledFor: new Date('2026-01-06T10:00:00Z') },
    ]);
  });

  it('a note that replaces another names it', () => {
    const result = map({
      resourceType: 'DocumentReference',
      id: 'note-2',
      status: 'current',
      subject: PATIENT_REF,
      relatesTo: [{ code: 'replaces', target: { reference: 'DocumentReference/note-1' } }],
      content: [{ attachment: { contentType: 'text/plain', data: 'UGxhbg==' } }],
    });
    expect(events(result)).toMatchObject([
      { type: 'note.received', documentId: 'note-2', replacesDocumentIds: ['note-1'] },
    ]);
  });
});
