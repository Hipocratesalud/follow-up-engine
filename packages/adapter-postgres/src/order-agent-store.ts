import {
  type AgentAppointment,
  type AgentConversation,
  type AgentMedia,
  type AgentMessage,
  type AgentOrderProgress,
  type DoctorConfirmation,
  type AgentRun,
  type AgentStep,
  type ClinicId,
  ConflictError,
  type ExpectationId,
  type LadderState,
  type OfferedSlot,
  type OrderAgentStore,
  type PatientId,
  type Slot,
  type StaffTask,
  type StaffTaskSummary,
} from '@follow-up-engine/core';
import {
  DEFAULT_SCHEMA,
  isUniqueViolation,
  jsonParam,
  quoteSchema,
  type Queryable,
  violatedConstraint,
} from './sql.ts';

type Row = Record<string, unknown>;

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : date(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function only<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
}

function slotFromJson(value: Row): Slot {
  return {
    id: String(value['id']),
    start: date(value['start']),
    end: date(value['end']),
    resourceKind: value['resourceKind'] === 'lab' ? 'lab' : 'professional',
    resource: String(value['resource']),
    resourceName: String(value['resourceName']),
    location: String(value['location']),
  };
}

function ladderFromJson(value: Row): LadderState {
  const resume = value['resumeTrack'];
  return {
    track: value['track'] as LadderState['track'],
    anchorAt: date(value['anchorAt']),
    done: Array.isArray(value['done']) ? value['done'].map(String) : [],
    ...(resume === 'routine' || resume === 'urgent' ? { resumeTrack: resume } : {}),
  };
}

function ordersFromJson(value: unknown): AgentOrderProgress[] {
  if (!Array.isArray(value)) return [];
  return (value as Row[]).map((item) => ({
    orderId: String(item['orderId']) as ExpectationId,
    stage: item['stage'] as AgentOrderProgress['stage'],
    ...only('appointmentId', text(item['appointmentId'])),
    ...only('doctorConfirmation', confirmationFromJson(item['doctorConfirmation'])),
    updatedAt: date(item['updatedAt']),
  }));
}

function confirmationFromJson(value: unknown): DoctorConfirmation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Row;
  const by = text(row['by']);
  return by === undefined ? undefined : { by, at: date(row['at']) };
}

function toConversation(row: Row): AgentConversation {
  return {
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    mode: row['mode'] as AgentConversation['mode'],
    language: row['language'] as AgentConversation['language'],
    status: row['status'] as AgentConversation['status'],
    phoneStatus: row['phone_status'] as AgentConversation['phoneStatus'],
    ladder: ladderFromJson(row['ladder'] as Row),
    orders: ordersFromJson(row['orders']),
    ...only('retryAt', optionalDate(row['retry_at'])),
    ...(row['flag_at_next_contact'] === true ? { flagAtNextContact: true } : {}),
    createdAt: date(row['created_at']),
    updatedAt: date(row['updated_at']),
  };
}

function toMessage(row: Row): AgentMessage {
  const offered = row['offered_slots'];
  const media = (row['media'] ?? null) as Row | null;
  const reading = row['reading'] as AgentMessage['reading'] | null;
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    direction: row['direction'] as AgentMessage['direction'],
    kind: row['kind'] as AgentMessage['kind'],
    text: String(row['text']),
    at: date(row['at']),
    ...only('deliveryStatus', text(row['delivery_status']) as AgentMessage['deliveryStatus']),
    ...only('statusAt', optionalDate(row['status_at'])),
    ...(Array.isArray(offered)
      ? {
          offeredSlots: (offered as Row[]).map((slot): OfferedSlot => ({
            ...slotFromJson(slot),
            orderId: String(slot['orderId']) as ExpectationId,
          })),
        }
      : {}),
    ...(media === null
      ? {}
      : {
          media: {
            id: String(media['id']),
            contentType: String(media['contentType']),
            bytes: num(media['bytes']),
          },
        }),
    ...only('transcript', text(row['transcript'])),
    ...(reading === null || reading === undefined ? {} : { reading }),
    ...only('rung', text(row['rung'])),
    ...only('runId', text(row['run_id'])),
    ...(typeof row['proactive'] === 'boolean' ? { proactive: row['proactive'] } : {}),
  };
}

function toRun(row: Row): AgentRun {
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    trigger: row['trigger'] as AgentRun['trigger'],
    status: row['status'] as AgentRun['status'],
    mode: row['mode'] as AgentRun['mode'],
    ...only('model', text(row['model'])),
    ...only('inboundMessageId', text(row['inbound_message_id'])),
    ...only('rung', text(row['rung'])),
    startedAt: date(row['started_at']),
    ...only('finishedAt', optionalDate(row['finished_at'])),
    modelCalls: num(row['model_calls']),
    toolCalls: num(row['tool_calls']),
    inputTokens: num(row['input_tokens']),
    outputTokens: num(row['output_tokens']),
    costUsd: num(row['cost_usd']),
    ...only('stopReason', text(row['stop_reason'])),
    ...only('error', text(row['error'])),
  };
}

function toStep(row: Row): AgentStep {
  const numberOrUndefined = (value: unknown): number | undefined =>
    value === null || value === undefined ? undefined : num(value);
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    ...only('runId', text(row['run_id'])),
    seq: num(row['seq']),
    at: date(row['at']),
    kind: row['kind'] as AgentStep['kind'],
    ...only('tool', text(row['tool'])),
    ...(row['arguments'] === null || row['arguments'] === undefined
      ? {}
      : { arguments: row['arguments'] as NonNullable<AgentStep['arguments']> }),
    ...(Array.isArray(row['read']) ? { read: (row['read'] as unknown[]).map(String) } : {}),
    ...only('reason', text(row['reason'])),
    outcome: row['outcome'] as AgentStep['outcome'],
    event: String(row['event']),
    ...(row['params'] === null || row['params'] === undefined
      ? {}
      : { params: row['params'] as NonNullable<AgentStep['params']> }),
    ...only('model', text(row['model'])),
    ...only('costUsd', numberOrUndefined(row['cost_usd'])),
    ...only('latencyMs', numberOrUndefined(row['latency_ms'])),
    ...only('inputTokens', numberOrUndefined(row['input_tokens'])),
    ...only('outputTokens', numberOrUndefined(row['output_tokens'])),
  };
}

function toTask(row: Row): StaffTask {
  const summary = row['summary'] as Row;
  const parsed: StaffTaskSummary = {
    orders: Array.isArray(summary['orders']) ? summary['orders'].map(String) : [],
    outboundCount: num(summary['outboundCount']),
    ...only('lastOutboundAt', optionalDate(summary['lastOutboundAt'])),
    ...only('lastStatus', text(summary['lastStatus']) as StaffTaskSummary['lastStatus']),
    replied: summary['replied'] === true,
    ask: summary['ask'] as StaffTaskSummary['ask'],
  };
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    kind: row['kind'] as StaffTask['kind'],
    priority: row['priority'] as StaffTask['priority'],
    summary: parsed,
    status: row['status'] as StaffTask['status'],
    ...only('rung', text(row['rung'])),
    createdAt: date(row['created_at']),
    dueAt: date(row['due_at']),
  };
}

function toAppointment(row: Row): AgentAppointment {
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']) as ClinicId,
    patientId: String(row['patient_id']) as PatientId,
    orderId: String(row['order_id']) as ExpectationId,
    slot: slotFromJson(row['slot'] as Row),
    confirmationMessageId: String(row['confirmation_message_id']),
    bookedAt: date(row['booked_at']),
    ...only('fhirAppointmentId', text(row['fhir_appointment_id'])),
    ...only('originCaseId', text(row['origin_case_id'])),
  };
}

/**
 * Postgres {@link OrderAgentStore} (migration 0017). Each call is one
 * statement scoped by `clinic_id`; bookings are unique per confirming
 * message and per slot (constraints, so two concurrent "yes" never double-book).
 */
export class PostgresOrderAgentStore implements OrderAgentStore {
  readonly #db: () => Queryable;
  readonly #t: (table: string) => string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    const quoted = quoteSchema(schema);
    this.#db = db;
    this.#t = (table) => `${quoted}."${table}"`;
  }

  async getConversation(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<AgentConversation | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_conversations')} WHERE clinic_id = $1 AND patient_id = $2`,
      [clinicId, patientId],
    );
    return rows[0] === undefined ? undefined : toConversation(rows[0]);
  }

  async saveConversation(conversation: AgentConversation): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#t('order_agent_conversations')}
         (clinic_id, patient_id, mode, language, status, phone_status, ladder, orders, retry_at,
          flag_at_next_contact, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
       ON CONFLICT (clinic_id, patient_id) DO UPDATE SET
         mode = EXCLUDED.mode, language = EXCLUDED.language, status = EXCLUDED.status,
         phone_status = EXCLUDED.phone_status, ladder = EXCLUDED.ladder, orders = EXCLUDED.orders,
         retry_at = EXCLUDED.retry_at, flag_at_next_contact = EXCLUDED.flag_at_next_contact,
         created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [
        conversation.clinicId,
        conversation.patientId,
        conversation.mode,
        conversation.language,
        conversation.status,
        conversation.phoneStatus,
        jsonParam(conversation.ladder),
        jsonParam(conversation.orders),
        conversation.retryAt ?? null,
        conversation.flagAtNextContact === true,
        conversation.createdAt,
        conversation.updatedAt,
      ],
    );
  }

  async listConversations(clinicId: ClinicId): Promise<readonly AgentConversation[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_conversations')} WHERE clinic_id = $1 ORDER BY created_at, patient_id`,
      [clinicId],
    );
    return rows.map(toConversation);
  }

  async saveMessage(message: AgentMessage): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#t('order_agent_messages')}
         (clinic_id, id, patient_id, direction, kind, text, at, delivery_status, status_at,
          offered_slots, media, transcript, reading, rung, run_id, proactive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, $15, $16)
       ON CONFLICT (clinic_id, id) DO UPDATE SET
         text = EXCLUDED.text, delivery_status = EXCLUDED.delivery_status,
         status_at = EXCLUDED.status_at, offered_slots = EXCLUDED.offered_slots,
         media = EXCLUDED.media, transcript = EXCLUDED.transcript, reading = EXCLUDED.reading,
         rung = EXCLUDED.rung, run_id = EXCLUDED.run_id, proactive = EXCLUDED.proactive`,
      [
        message.clinicId,
        message.id,
        message.patientId,
        message.direction,
        message.kind,
        message.text,
        message.at,
        message.deliveryStatus ?? null,
        message.statusAt ?? null,
        message.offeredSlots === undefined ? null : jsonParam(message.offeredSlots),
        message.media === undefined ? null : jsonParam(message.media),
        message.transcript ?? null,
        message.reading === undefined ? null : jsonParam(message.reading),
        message.rung ?? null,
        message.runId ?? null,
        message.proactive ?? null,
      ],
    );
  }

  async getMessage(clinicId: ClinicId, id: string): Promise<AgentMessage | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_messages')} WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    return rows[0] === undefined ? undefined : toMessage(rows[0]);
  }

  async listMessages(clinicId: ClinicId, patientId: PatientId): Promise<readonly AgentMessage[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_messages')} WHERE clinic_id = $1 AND patient_id = $2 ORDER BY at, id`,
      [clinicId, patientId],
    );
    return rows.map(toMessage);
  }

  async saveMedia(media: AgentMedia): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#t('order_agent_media')} (clinic_id, id, content_type, data)
       VALUES ($1, $2, $3, $4) ON CONFLICT (clinic_id, id) DO NOTHING`,
      [media.clinicId, media.id, media.contentType, Buffer.from(media.data)],
    );
  }

  async getMedia(clinicId: ClinicId, id: string): Promise<AgentMedia | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_media')} WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      id: String(row['id']),
      clinicId,
      contentType: String(row['content_type']),
      data: new Uint8Array(row['data'] as Buffer),
    };
  }

  async saveRun(run: AgentRun): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#t('order_agent_runs')}
         (clinic_id, id, patient_id, trigger, status, mode, model, inbound_message_id, rung,
          started_at, finished_at, model_calls, tool_calls, input_tokens, output_tokens, cost_usd,
          stop_reason, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (clinic_id, id) DO UPDATE SET
         status = EXCLUDED.status, mode = EXCLUDED.mode, model = EXCLUDED.model,
         finished_at = EXCLUDED.finished_at, model_calls = EXCLUDED.model_calls,
         tool_calls = EXCLUDED.tool_calls, input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd,
         stop_reason = EXCLUDED.stop_reason, error = EXCLUDED.error`,
      [
        run.clinicId,
        run.id,
        run.patientId,
        run.trigger,
        run.status,
        run.mode,
        run.model ?? null,
        run.inboundMessageId ?? null,
        run.rung ?? null,
        run.startedAt,
        run.finishedAt ?? null,
        run.modelCalls,
        run.toolCalls,
        run.inputTokens,
        run.outputTokens,
        run.costUsd,
        run.stopReason ?? null,
        run.error ?? null,
      ],
    );
  }

  async listRuns(
    clinicId: ClinicId,
    patientId: PatientId,
    limit: number,
  ): Promise<readonly AgentRun[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_runs')} WHERE clinic_id = $1 AND patient_id = $2
       ORDER BY started_at DESC, id DESC LIMIT $3`,
      [clinicId, patientId, limit],
    );
    return rows.map(toRun);
  }

  async findRunForInbound(
    clinicId: ClinicId,
    inboundMessageId: string,
  ): Promise<AgentRun | undefined> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_runs')} WHERE clinic_id = $1 AND inbound_message_id = $2
       ORDER BY started_at LIMIT 1`,
      [clinicId, inboundMessageId],
    );
    return rows[0] === undefined ? undefined : toRun(rows[0]);
  }

  async appendStep(step: Omit<AgentStep, 'seq'>): Promise<AgentStep> {
    const { rows } = await this.#db().query<Row>(
      `INSERT INTO ${this.#t('order_agent_steps')}
         (clinic_id, id, patient_id, run_id, at, kind, tool, arguments, read, reason, outcome,
          event, params, model, cost_usd, latency_ms, input_tokens, output_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)
       RETURNING seq`,
      [
        step.clinicId,
        step.id,
        step.patientId,
        step.runId ?? null,
        step.at,
        step.kind,
        step.tool ?? null,
        step.arguments === undefined ? null : jsonParam(step.arguments),
        step.read === undefined ? null : [...step.read],
        step.reason ?? null,
        step.outcome,
        step.event,
        step.params === undefined ? null : jsonParam(step.params),
        step.model ?? null,
        step.costUsd ?? null,
        step.latencyMs ?? null,
        step.inputTokens ?? null,
        step.outputTokens ?? null,
      ],
    );
    return { ...step, seq: num(rows[0]?.['seq']) };
  }

  async listSteps(
    clinicId: ClinicId,
    patientId: PatientId,
    afterSeq?: number,
  ): Promise<readonly AgentStep[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_steps')}
       WHERE clinic_id = $1 AND patient_id = $2 AND seq > $3 ORDER BY seq`,
      [clinicId, patientId, afterSeq ?? 0],
    );
    return rows.map(toStep);
  }

  async saveTask(task: StaffTask): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#t('order_agent_tasks')}
         (clinic_id, id, patient_id, kind, priority, summary, status, rung, created_at, due_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       ON CONFLICT (clinic_id, id) DO UPDATE SET status = EXCLUDED.status, summary = EXCLUDED.summary`,
      [
        task.clinicId,
        task.id,
        task.patientId,
        task.kind,
        task.priority,
        jsonParam(task.summary),
        task.status,
        task.rung ?? null,
        task.createdAt,
        task.dueAt,
      ],
    );
  }

  async listTasks(clinicId: ClinicId, patientId?: PatientId): Promise<readonly StaffTask[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_tasks')}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR patient_id = $2)
       ORDER BY created_at DESC, id DESC`,
      [clinicId, patientId ?? null],
    );
    return rows.map(toTask);
  }

  async addAppointment(
    appointment: AgentAppointment,
  ): Promise<{ readonly status: 'created' | 'duplicate'; readonly appointment: AgentAppointment }> {
    try {
      await this.#db().query(
        `INSERT INTO ${this.#t('order_agent_appointments')}
           (clinic_id, id, patient_id, order_id, slot_id, slot, confirmation_message_id, booked_at,
            fhir_appointment_id, origin_case_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
        [
          appointment.clinicId,
          appointment.id,
          appointment.patientId,
          appointment.orderId,
          appointment.slot.id,
          jsonParam(appointment.slot),
          appointment.confirmationMessageId,
          appointment.bookedAt,
          appointment.fhirAppointmentId ?? null,
          appointment.originCaseId ?? null,
        ],
      );
      return { status: 'created', appointment };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (violatedConstraint(error) === 'order_agent_appointments_slot_unique') {
        throw new ConflictError('AgentAppointment', appointment.slot.id);
      }
      const { rows } = await this.#db().query<Row>(
        `SELECT * FROM ${this.#t('order_agent_appointments')}
         WHERE clinic_id = $1 AND confirmation_message_id = $2`,
        [appointment.clinicId, appointment.confirmationMessageId],
      );
      if (rows[0] === undefined) throw error;
      return { status: 'duplicate', appointment: toAppointment(rows[0]) };
    }
  }

  async listAppointments(
    clinicId: ClinicId,
    patientId?: PatientId,
  ): Promise<readonly AgentAppointment[]> {
    const { rows } = await this.#db().query<Row>(
      `SELECT * FROM ${this.#t('order_agent_appointments')}
       WHERE clinic_id = $1 AND ($2::text IS NULL OR patient_id = $2)
       ORDER BY (slot->>'start'), id`,
      [clinicId, patientId ?? null],
    );
    return rows.map(toAppointment);
  }
}
