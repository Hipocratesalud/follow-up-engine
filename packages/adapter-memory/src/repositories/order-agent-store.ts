import {
  type AgentAppointment,
  type AgentConversation,
  type AgentMedia,
  type AgentMessage,
  type AgentRun,
  type AgentStep,
  type ClinicId,
  ConflictError,
  type OrderAgentStore,
  type PatientId,
  type StaffTask,
} from '@follow-up-engine/core';

function key(clinicId: ClinicId, id: string): string {
  return `${clinicId}\u0000${id}`;
}

/**
 * In-memory {@link OrderAgentStore}: the offline demo and tests. Each call is
 * its own atomic step (like a single Postgres statement); bookings are unique
 * per confirmation message, as in the Postgres adapter.
 */
export class MemoryOrderAgentStore implements OrderAgentStore {
  readonly #conversations = new Map<string, AgentConversation>();
  readonly #messages = new Map<string, AgentMessage>();
  readonly #media = new Map<string, AgentMedia>();
  readonly #runs = new Map<string, AgentRun>();
  readonly #steps: AgentStep[] = [];
  readonly #tasks = new Map<string, StaffTask>();
  readonly #appointments = new Map<string, AgentAppointment>();
  #seq = 0;

  getConversation(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<AgentConversation | undefined> {
    return Promise.resolve(this.#conversations.get(key(clinicId, patientId)));
  }

  saveConversation(conversation: AgentConversation): Promise<void> {
    this.#conversations.set(key(conversation.clinicId, conversation.patientId), conversation);
    return Promise.resolve();
  }

  listConversations(clinicId: ClinicId): Promise<readonly AgentConversation[]> {
    return Promise.resolve(
      [...this.#conversations.values()]
        .filter((item) => item.clinicId === clinicId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()),
    );
  }

  saveMessage(message: AgentMessage): Promise<void> {
    this.#messages.set(key(message.clinicId, message.id), message);
    return Promise.resolve();
  }

  getMessage(clinicId: ClinicId, id: string): Promise<AgentMessage | undefined> {
    return Promise.resolve(this.#messages.get(key(clinicId, id)));
  }

  listMessages(clinicId: ClinicId, patientId: PatientId): Promise<readonly AgentMessage[]> {
    return Promise.resolve(
      [...this.#messages.values()]
        .filter((item) => item.clinicId === clinicId && item.patientId === patientId)
        .sort((left, right) => left.at.getTime() - right.at.getTime()),
    );
  }

  saveMedia(media: AgentMedia): Promise<void> {
    this.#media.set(key(media.clinicId, media.id), { ...media, data: new Uint8Array(media.data) });
    return Promise.resolve();
  }

  getMedia(clinicId: ClinicId, id: string): Promise<AgentMedia | undefined> {
    return Promise.resolve(this.#media.get(key(clinicId, id)));
  }

  saveRun(run: AgentRun): Promise<void> {
    this.#runs.set(key(run.clinicId, run.id), run);
    return Promise.resolve();
  }

  listRuns(clinicId: ClinicId, patientId: PatientId, limit: number): Promise<readonly AgentRun[]> {
    return Promise.resolve(
      [...this.#runs.values()]
        .filter((item) => item.clinicId === clinicId && item.patientId === patientId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
        .slice(0, limit),
    );
  }

  findRunForInbound(clinicId: ClinicId, inboundMessageId: string): Promise<AgentRun | undefined> {
    return Promise.resolve(
      [...this.#runs.values()].find(
        (item) => item.clinicId === clinicId && item.inboundMessageId === inboundMessageId,
      ),
    );
  }

  appendStep(step: Omit<AgentStep, 'seq'>): Promise<AgentStep> {
    this.#seq += 1;
    const stored: AgentStep = { ...step, seq: this.#seq };
    this.#steps.push(stored);
    return Promise.resolve(stored);
  }

  listSteps(
    clinicId: ClinicId,
    patientId: PatientId,
    afterSeq?: number,
  ): Promise<readonly AgentStep[]> {
    return Promise.resolve(
      this.#steps.filter(
        (item) =>
          item.clinicId === clinicId &&
          item.patientId === patientId &&
          (afterSeq === undefined || item.seq > afterSeq),
      ),
    );
  }

  saveTask(task: StaffTask): Promise<void> {
    this.#tasks.set(key(task.clinicId, task.id), task);
    return Promise.resolve();
  }

  listTasks(clinicId: ClinicId, patientId?: PatientId): Promise<readonly StaffTask[]> {
    return Promise.resolve(
      [...this.#tasks.values()]
        .filter(
          (item) =>
            item.clinicId === clinicId && (patientId === undefined || item.patientId === patientId),
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
    );
  }

  addAppointment(
    appointment: AgentAppointment,
  ): Promise<{ readonly status: 'created' | 'duplicate'; readonly appointment: AgentAppointment }> {
    const existing = [...this.#appointments.values()].find(
      (item) =>
        item.clinicId === appointment.clinicId &&
        item.confirmationMessageId === appointment.confirmationMessageId,
    );
    if (existing !== undefined) {
      return Promise.resolve({ status: 'duplicate', appointment: existing });
    }
    if (
      [...this.#appointments.values()].some(
        (item) => item.clinicId === appointment.clinicId && item.slot.id === appointment.slot.id,
      )
    ) {
      return Promise.reject(new ConflictError('AgentAppointment', appointment.slot.id));
    }
    this.#appointments.set(key(appointment.clinicId, appointment.id), appointment);
    return Promise.resolve({ status: 'created', appointment });
  }

  listAppointments(
    clinicId: ClinicId,
    patientId?: PatientId,
  ): Promise<readonly AgentAppointment[]> {
    return Promise.resolve(
      [...this.#appointments.values()]
        .filter(
          (item) =>
            item.clinicId === clinicId && (patientId === undefined || item.patientId === patientId),
        )
        .sort((left, right) => left.slot.start.getTime() - right.slot.start.getTime()),
    );
  }
}
