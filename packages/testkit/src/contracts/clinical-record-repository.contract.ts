import {
  type ClinicalEvent,
  type ClinicalRecordRepository,
  type ClinicId,
  type FhirResourceJson,
  ICD10_SYSTEM,
  type PatientId,
  patientId,
  practitionerId,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { anEncounterEvent } from './builders.ts';
import { at, freshClinics, type MakeSubject, uniqueId, useSubject } from './harness.ts';

function aResource(id: string, status = 'finished'): FhirResourceJson {
  return {
    resourceType: 'Encounter',
    id,
    status,
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
    subject: { reference: 'Patient/pat-1' },
  };
}

const HBA1C = { system: 'http://loinc.org', code: '4548-4', display: 'Hemoglobin A1c' };

/** One event of every type, with every optional field set. */
function everyEventType(clinic: ClinicId, patient: PatientId): ClinicalEvent[] {
  const base = (type: string, resourceType: string, day: number) => {
    const id = uniqueId(resourceType.toLowerCase());
    return {
      clinicId: clinic,
      patientId: patient,
      source: { resourceType, id },
      encounterId: 'enc-all',
      occurredAt: at(day),
      idempotencyKey: `${resourceType}/${id}/1#${type}`,
    };
  };
  return [
    {
      ...base('encounter.finished', 'Encounter', 0),
      type: 'encounter.finished',
      practitionerId: practitionerId('prac-1'),
      specialty: 'diabetology',
    },
    {
      ...base('appointment.booked', 'Appointment', 1),
      type: 'appointment.booked',
      scheduledFor: at(90),
      practitionerId: practitionerId('prac-1'),
      specialty: 'diabetology',
    },
    {
      ...base('appointment.cancelled', 'Appointment', 2),
      type: 'appointment.cancelled',
      scheduledFor: at(90),
    },
    {
      ...base('service_request.created', 'ServiceRequest', 3),
      type: 'service_request.created',
      orderId: 'sr-1',
      code: HBA1C,
      category: 'laboratory',
    },
    {
      ...base('result.received', 'Observation', 4),
      type: 'result.received',
      basedOnOrderId: 'sr-1',
      code: HBA1C,
      interpretation: 'abnormal',
      value: { value: 8.2, unit: '%' },
    },
    {
      ...base('medication.prescribed', 'MedicationRequest', 5),
      type: 'medication.prescribed',
      medication: {
        text: 'amoxicilina 500 mg',
        code: { system: 'http://www.whocc.no/atc', code: 'J01CA04' },
      },
      startAt: at(5),
      durationDays: 7,
    },
    {
      ...base('condition.recorded', 'DocumentReference', 6),
      type: 'condition.recorded',
      code: { system: ICD10_SYSTEM, code: 'E11' },
      verification: 'provisional',
      evidence: { quote: 'DM2', sourceDocumentId: 'doc-1' },
    },
    {
      ...base('note.received', 'DocumentReference', 7),
      type: 'note.received',
      documentId: 'doc-1',
      text: 'Plan: control en 3 meses.',
      specialty: 'diabetology',
      authoredAt: at(7),
    },
    {
      ...base('plan.extracted', 'DocumentReference', 8),
      type: 'plan.extracted',
      sourceDocumentId: 'doc-1',
      items: [
        {
          kind: 'lab',
          description: 'repeat HbA1c',
          dueAt: at(97),
          evidenceQuote: 'control en 3 meses',
          confidence: 0.9,
          code: HBA1C,
        },
      ],
      extractor: { model: 'fake', promptVersion: 'v1' },
    },
    { ...base('patient.opted_out', 'Consent', 9), type: 'patient.opted_out' },
    {
      ...base('record.withdrawn', 'ServiceRequest', 10),
      type: 'record.withdrawn',
      reason: 'revoked',
    },
  ] as ClinicalEvent[];
}

/** Contract every {@link ClinicalRecordRepository} adapter must pass. */
export function describeClinicalRecordRepositoryContract(
  name: string,
  makeSubject: MakeSubject<ClinicalRecordRepository>,
): void {
  describe(`ClinicalRecordRepository contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const repo = () => current().subject;
    const patient = patientId('pat-1');

    it('stores a resource and reads it back with its version', async () => {
      const { a } = freshClinics();
      const resource = aResource(uniqueId('enc'));
      const saved = await repo().saveResource(a, patient, resource, at(0));
      expect(saved.changed).toBe(true);
      const stored = await repo().getResource(a, { resourceType: 'Encounter', id: resource.id });
      expect(stored).toEqual({
        patientId: patient,
        resource,
        versionId: saved.versionId,
        receivedAt: at(0),
      });
    });

    it('is idempotent for identical content and versions changed content', async () => {
      const { a } = freshClinics();
      const resource = aResource(uniqueId('enc'));
      const first = await repo().saveResource(a, patient, resource, at(0));
      const again = await repo().saveResource(a, patient, { ...resource }, at(1));
      expect(again).toEqual({ versionId: first.versionId, changed: false });

      const changed = await repo().saveResource(
        a,
        patient,
        aResource(resource.id, 'cancelled'),
        at(2),
      );
      expect(changed.changed).toBe(true);
      expect(changed.versionId).not.toBe(first.versionId);
      const stored = await repo().getResource(a, { resourceType: 'Encounter', id: resource.id });
      expect(stored?.resource['status']).toBe('cancelled');
      expect(stored?.versionId).toBe(changed.versionId);
    });

    it('appends events skipping known idempotency keys', async () => {
      const { a } = freshClinics();
      const e1 = anEncounterEvent(a, patient, at(1));
      const e2 = anEncounterEvent(a, patient, at(2));
      expect(await repo().appendEvents(a, [e1, e2])).toEqual({ inserted: 2 });
      expect(await repo().appendEvents(a, [e1, e2, anEncounterEvent(a, patient, at(3))])).toEqual({
        inserted: 1,
      });
      expect(await repo().listEventsForPatient(a, patient)).toHaveLength(3);
    });

    it('round-trips every event type with every optional field (dates included)', async () => {
      const { a } = freshClinics();
      const events = everyEventType(a, patient);
      expect(await repo().appendEvents(a, events)).toEqual({ inserted: events.length });
      expect(await repo().listEventsForPatient(a, patient)).toEqual(events);
    });

    it('lists a patient’s events chronologically, ties in insertion order', async () => {
      const { a } = freshClinics();
      const late = anEncounterEvent(a, patient, at(5));
      const tieFirst = anEncounterEvent(a, patient, at(2));
      const tieSecond = anEncounterEvent(a, patient, at(2));
      const early = anEncounterEvent(a, patient, at(1));
      const other = anEncounterEvent(a, patientId('pat-2'), at(0));
      await repo().appendEvents(a, [late, tieFirst, tieSecond, early, other]);
      const events = await repo().listEventsForPatient(a, patient);
      expect(events.map((e) => e.idempotencyKey)).toEqual([
        early.idempotencyKey,
        tieFirst.idempotencyKey,
        tieSecond.idempotencyKey,
        late.idempotencyKey,
      ]);
      expect(events[0]).toEqual(early);
    });

    it('filters events by type and by [since, until)', async () => {
      const { a } = freshClinics();
      const e1 = anEncounterEvent(a, patient, at(1));
      const e2 = anEncounterEvent(a, patient, at(2));
      const e3 = anEncounterEvent(a, patient, at(3));
      const opted = {
        type: 'patient.opted_out' as const,
        clinicId: a,
        patientId: patient,
        source: { resourceType: 'Consent', id: uniqueId('consent') },
        occurredAt: at(2),
        idempotencyKey: uniqueId('Consent'),
      };
      await repo().appendEvents(a, [e1, e2, e3, opted]);
      const window = await repo().listEventsForPatient(a, patient, { since: at(2), until: at(3) });
      expect(window.map((e) => e.idempotencyKey)).toEqual([
        e2.idempotencyKey,
        opted.idempotencyKey,
      ]);
      const typed = await repo().listEventsForPatient(a, patient, { types: ['patient.opted_out'] });
      expect(typed).toEqual([opted]);
    });

    it('finds the other patients with events of a resource', async () => {
      const { a, b } = freshClinics();
      const moved = anEncounterEvent(a, patient, at(1));
      const other = patientId(uniqueId('pat'));
      await repo().appendEvents(a, [
        moved,
        { ...moved, patientId: other, idempotencyKey: uniqueId('k') },
      ]);
      await repo().appendEvents(b, [{ ...moved, clinicId: b, idempotencyKey: uniqueId('k') }]);
      expect(await repo().findOtherPatientsWithSources(a, other, [moved.source])).toEqual([
        { source: moved.source, patientId: patient },
      ]);
      expect(await repo().findOtherPatientsWithSources(a, patient, [moved.source])).toEqual([
        { source: moved.source, patientId: other },
      ]);
      expect(await repo().findOtherPatientsWithSources(a, other, [])).toEqual([]);
    });

    it('pages patient ids in id order', async () => {
      const { a } = freshClinics();
      const ids = ['pat-c', 'pat-a', 'pat-e', 'pat-b', 'pat-d'].map((id) => patientId(id));
      await repo().appendEvents(
        a,
        ids.map((id, index) => anEncounterEvent(a, id, at(index))),
      );
      const first = await repo().listPatientIds(a, { limit: 2 });
      expect(first.patientIds).toEqual(['pat-a', 'pat-b']);
      expect(first.next).toBeDefined();
      const second = await repo().listPatientIds(a, {
        after: first.next ?? patientId('x'),
        limit: 2,
      });
      expect(second.patientIds).toEqual(['pat-c', 'pat-d']);
      const third = await repo().listPatientIds(a, {
        after: second.next ?? patientId('x'),
        limit: 2,
      });
      expect(third.patientIds).toEqual(['pat-e']);
      expect(third.next).toBeUndefined();
    });

    it('isolates clinics: nothing of clinic A is visible from clinic B', async () => {
      const { a, b } = freshClinics();
      const resource = aResource(uniqueId('enc'));
      await repo().saveResource(a, patient, resource, at(0));
      const event = anEncounterEvent(a, patient, at(1));
      await repo().appendEvents(a, [event]);

      expect(
        await repo().getResource(b, { resourceType: 'Encounter', id: resource.id }),
      ).toBeUndefined();
      expect(await repo().listEventsForPatient(b, patient)).toEqual([]);
      expect((await repo().listPatientIds(b, { limit: 10 })).patientIds).toEqual([]);

      // Same resource id and idempotency key are independent per clinic.
      expect((await repo().saveResource(b, patient, resource, at(0))).changed).toBe(true);
      expect(await repo().appendEvents(b, [{ ...event, clinicId: b }])).toEqual({ inserted: 1 });
    });
  });
}
