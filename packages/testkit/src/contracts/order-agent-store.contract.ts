import {
  type AgentAppointment,
  type AgentConversation,
  type AgentMessage,
  type AgentRun,
  type ClinicId,
  type ExpectationId,
  type OrderAgentStore,
  type PatientId,
  patientId,
  type StaffTask,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { at, freshClinics, type MakeSubject, uniqueId, useSubject } from './harness.ts';

const ORDER = 'exp-1' as ExpectationId;

function conversation(clinicId: ClinicId, patient: PatientId): AgentConversation {
  return {
    clinicId,
    patientId: patient,
    mode: 'scripted',
    language: 'es',
    status: 'active',
    phoneStatus: 'ok',
    ladder: {
      track: 'undelivered',
      anchorAt: at(1),
      done: ['undelivered:0d'],
      resumeTrack: 'urgent',
    },
    orders: [{ orderId: ORDER, stage: 'booked', appointmentId: 'appt-1', updatedAt: at(2) }],
    retryAt: at(30),
    flagAtNextContact: true,
    createdAt: at(0),
    updatedAt: at(2),
  };
}

function slot(id: string) {
  return {
    id,
    start: at(3),
    end: new Date(at(3).getTime() + 30 * 60_000),
    resourceKind: 'professional' as const,
    resource: 'professional',
    resourceName: 'Dr. Elena Ruiz',
    location: 'Office 2',
  };
}

function outbound(clinicId: ClinicId, patient: PatientId, id: string, day: number): AgentMessage {
  return {
    id,
    clinicId,
    patientId: patient,
    direction: 'outbound',
    kind: 'text',
    text: `message ${id}`,
    at: at(day),
    deliveryStatus: 'delivered',
    statusAt: at(day),
    offeredSlots: [{ ...slot(`professional@${id}`), orderId: ORDER }],
    rung: 'routine:0d',
    runId: 'run-1',
    proactive: true,
  };
}

/** Contract every {@link OrderAgentStore} adapter must pass (memory and Postgres). */
export function describeOrderAgentStoreContract(
  name: string,
  makeSubject: MakeSubject<OrderAgentStore>,
): void {
  describe(`OrderAgentStore contract: ${name}`, () => {
    const current = useSubject(makeSubject);
    const store = () => current().subject;

    it('round-trips a conversation, every optional field included, scoped by clinic', async () => {
      const { a, b } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const value = conversation(a, patient);
      await store().saveConversation(value);
      expect(await store().getConversation(a, patient)).toEqual(value);
      expect(await store().getConversation(b, patient)).toBeUndefined();
      const updated: AgentConversation = { ...value, status: 'done', updatedAt: at(5) };
      await store().saveConversation(updated);
      expect(await store().getConversation(a, patient)).toEqual(updated);
      expect(await store().listConversations(a)).toEqual([updated]);
      expect(await store().listConversations(b)).toEqual([]);
    });

    it('keeps messages in order and updates them in place', async () => {
      const { a, b } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const later = outbound(a, patient, uniqueId('m'), 2);
      const earlier = outbound(a, patient, uniqueId('m'), 1);
      const inbound: AgentMessage = {
        id: uniqueId('m'),
        clinicId: a,
        patientId: patient,
        direction: 'inbound',
        kind: 'image',
        text: '',
        at: at(3),
        media: { id: 'media-1', contentType: 'image/jpeg', bytes: 3 },
        reading: {
          isLabReport: true,
          tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
          reportDate: '2025-12-29',
        },
      };
      await store().saveMessage(later);
      await store().saveMessage(earlier);
      await store().saveMessage(inbound);
      expect(await store().listMessages(a, patient)).toEqual([earlier, later, inbound]);
      const read: AgentMessage = { ...later, deliveryStatus: 'read', statusAt: at(4) };
      await store().saveMessage(read);
      expect(await store().getMessage(a, later.id)).toEqual(read);
      expect(await store().getMessage(b, later.id)).toBeUndefined();
    });

    it('stores media bytes per clinic', async () => {
      const { a, b } = freshClinics();
      const id = uniqueId('media');
      await store().saveMedia({
        id,
        clinicId: a,
        contentType: 'audio/wav',
        data: new Uint8Array([1, 2, 3]),
      });
      const media = await store().getMedia(a, id);
      expect(media?.contentType).toBe('audio/wav');
      expect([...(media?.data ?? [])]).toEqual([1, 2, 3]);
      expect(await store().getMedia(b, id)).toBeUndefined();
    });

    it('records runs and finds the one that answered an inbound message', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const run: AgentRun = {
        id: uniqueId('run'),
        clinicId: a,
        patientId: patient,
        trigger: 'inbound_message',
        status: 'running',
        mode: 'live',
        inboundMessageId: 'msg-in-1',
        startedAt: at(1),
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      await store().saveRun(run);
      const done: AgentRun = {
        ...run,
        status: 'completed',
        model: 'meta:muse-spark-1.3',
        finishedAt: at(1),
        modelCalls: 4,
        toolCalls: 3,
        inputTokens: 12_000,
        outputTokens: 900,
        costUsd: 0.0187,
        stopReason: 'end_turn',
      };
      await store().saveRun(done);
      expect(await store().listRuns(a, patient, 10)).toEqual([done]);
      expect(await store().findRunForInbound(a, 'msg-in-1')).toEqual(done);
      expect(await store().findRunForInbound(a, 'msg-other')).toBeUndefined();
    });

    it('appends steps with increasing sequence numbers and reads them after a cursor', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const first = await store().appendStep({
        id: uniqueId('step'),
        clinicId: a,
        patientId: patient,
        runId: 'run-1',
        at: at(1),
        kind: 'tool',
        tool: 'get_available_slots',
        arguments: { orderId: 'exp-1', excludeWeekdays: ['tuesday'], preference: null },
        read: ['schedule', 'appointments'],
        reason: 'She cannot on Tuesday',
        outcome: 'ok',
        event: 'slots_found',
        params: { count: 2 },
      });
      const second = await store().appendStep({
        id: uniqueId('step'),
        clinicId: a,
        patientId: patient,
        at: at(1),
        kind: 'model',
        outcome: 'ok',
        event: 'model_called',
        model: 'meta:muse-spark-1.3',
        costUsd: 0.004,
        latencyMs: 1500,
        inputTokens: 4000,
        outputTokens: 300,
      });
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(await store().listSteps(a, patient)).toEqual([first, second]);
      expect(await store().listSteps(a, patient, first.seq)).toEqual([second]);
    });

    it('saves staff tasks and closes them', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const task: StaffTask = {
        id: uniqueId('task'),
        clinicId: a,
        patientId: patient,
        kind: 'call_patient',
        priority: 'high',
        summary: {
          orders: ['HbA1c', 'visit'],
          outboundCount: 3,
          lastOutboundAt: at(9),
          lastStatus: 'read',
          replied: false,
          ask: 'book_orders',
        },
        status: 'open',
        rung: 'routine:14d',
        createdAt: at(14),
        dueAt: at(16),
      };
      await store().saveTask(task);
      expect(await store().listTasks(a, patient)).toEqual([task]);
      await store().saveTask({ ...task, status: 'done' });
      expect((await store().listTasks(a))[0]?.status).toBe('done');
    });

    it('books once per confirming message and once per slot', async () => {
      const { a } = freshClinics();
      const patient = patientId(uniqueId('pat'));
      const appointment: AgentAppointment = {
        id: uniqueId('appt'),
        clinicId: a,
        patientId: patient,
        orderId: ORDER,
        slot: slot(uniqueId('professional@')),
        confirmationMessageId: uniqueId('msg'),
        bookedAt: at(1),
        fhirAppointmentId: 'Appointment/agent-1',
        originCaseId: 'case-1',
      };
      expect(await store().addAppointment(appointment)).toEqual({ status: 'created', appointment });
      const again = await store().addAppointment({ ...appointment, id: uniqueId('appt') });
      expect(again).toEqual({ status: 'duplicate', appointment });
      await expect(
        store().addAppointment({
          ...appointment,
          id: uniqueId('appt'),
          confirmationMessageId: uniqueId('msg'),
        }),
      ).rejects.toThrow();
      expect(await store().listAppointments(a, patient)).toEqual([appointment]);
    });
  });
}
