import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, ExpectationId, PatientId } from '../../domain/ids.ts';
import type {
  AgentAppointment,
  AgentConversation,
  AgentMessage,
  AgentMessageKind,
  AgentOrderProgress,
  AgentRun,
  AgentRunTrigger,
  AgentStep,
  OfferedSlot,
  OrderAgentLanguage,
  OrderAgentMode,
  Slot,
  StaffTask,
  StaffTaskAsk,
  StaffTaskKind,
  StaffTaskPriority,
  TraceArgs,
  TraceValue,
} from '../../domain/order-agent.ts';
import type { FhirResourceJson } from '../../domain/resource.ts';
import { ValidationError } from '../../domain/errors.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import { LlmBudgetExceededError } from '../../ports/llm.ts';
import type {
  EngineOutcome,
  OrderAgentEffects,
  OrderAgentModel,
  OrderAgentModelCall,
  OrderAgentStore,
  OrderAgentToolOutcome,
  PatientMediaReader,
} from '../../ports/order-agent.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import { testGroupsNamedIn } from '../terminology/test-names.ts';
import { checkBookingConfirmation, fold } from './confirmation.ts';
import { contactPolicy, isOptOut } from './contact-policy.ts';
import {
  dueRungs,
  LADDER,
  type LadderRung,
  rungById,
  startTrack,
  UNREACHABLE_RETRY_DAYS,
} from './ladder.ts';
import {
  describeOrder,
  isAgentOwned,
  isPending,
  isUrgentOrder,
  type OrderDescriptor,
} from './orders.ts';
import { checkOutboundText, type OutboundSafetyTerms } from './outbound-safety.ts';
import {
  availableSlots,
  formatSlotLine,
  formatSlotTime,
  type SlotPreference,
  slotFromId,
} from './slots.ts';
import {
  CreateAppointmentArgs,
  CreateStaffTaskArgs,
  EndTurnArgs,
  GetAvailableSlotsArgs,
  MatchResultArgs,
  ORDER_AGENT_TOOLS,
  ProposeSlotsArgs,
  SendMessageArgs,
  SubmitResultArgs,
} from './tools.ts';
import { localDateKey, zonedParts } from './zoned-time.ts';

/** A worker job: one agent turn for a patient. */
export const ORDER_AGENT_TURN_JOB = 'order_agent.turn';
/** A worker job: the no-response ladder over a span of the clinic's clock. */
export const ORDER_AGENT_LADDER_JOB = 'order_agent.ladder';

export interface OrderAgentTurnJobPayload {
  readonly patientId: string;
  readonly trigger: AgentRunTrigger;
  readonly messageId?: string;
  readonly rung?: string;
}

export interface OrderAgentLadderJobPayload {
  readonly from: string;
  readonly to: string;
}

export interface OrderAgentServiceDeps {
  readonly store: OrderAgentStore;
  readonly unitOfWork: UnitOfWork;
  readonly clinics: ClinicDirectory;
  readonly model: OrderAgentModel;
  readonly media: PatientMediaReader;
  readonly effects: OrderAgentEffects;
  /** The clinic's own clock (an evaluator's lab clinic has its own). */
  readonly nowOf: (clinicId: ClinicId) => Date;
  readonly newId: (prefix: string) => string;
  readonly safetyTerms: OutboundSafetyTerms;
  /** The patient's names and identifiers, masked before anything reaches a model. */
  readonly redactTermsOf?: (patient: FhirResourceJson) => readonly string[];
  /** Model calls per turn. Default 12. */
  readonly maxSteps?: number;
}

/** An order as the agent page shows it. */
export interface AgentOrderView {
  readonly orderId: ExpectationId;
  readonly descriptor: OrderDescriptor;
  readonly expectationStatus: Expectation['status'];
  readonly stage: AgentOrderProgress['stage'] | 'fulfilled';
  readonly dueAt: Date;
  readonly urgent: boolean;
  readonly closedReason?: string;
  readonly closedBy?: string;
  readonly closedAt?: Date;
  readonly appointmentId?: string;
}

export interface AgentConversationView {
  readonly conversation: AgentConversation;
  readonly messages: readonly AgentMessage[];
  readonly orders: readonly AgentOrderView[];
  /** Engine items the agent deliberately does not pursue (protocol and cadence suggestions). */
  readonly ignoredEngineItems: number;
  readonly steps: readonly AgentStep[];
  readonly runs: readonly AgentRun[];
  readonly tasks: readonly StaffTask[];
  readonly appointments: readonly AgentAppointment[];
  readonly now: Date;
  readonly timeZone: string;
}

export interface OrderAgentService {
  /** Starts (or restarts) owning the patient's open orders and queues the first turn. */
  takeOwnership(
    clinicId: ClinicId,
    patientId: PatientId,
    options: {
      readonly mode: OrderAgentMode;
      readonly language: OrderAgentLanguage;
      /** A result just arrived at the clinic: the reviewer runs on it before the agent starts. */
      readonly reviewFirst?: boolean;
    },
  ): Promise<AgentConversation>;
  /** A message from the patient on the simulated channel; queues a turn (or records an opt-out). */
  receiveMessage(
    clinicId: ClinicId,
    patientId: PatientId,
    input: {
      readonly kind: AgentMessageKind;
      readonly text?: string;
      readonly media?: { readonly data: Uint8Array; readonly contentType: string };
    },
  ): Promise<AgentMessage>;
  /** The simulator reports an outbound message delivered, read or undelivered. */
  setDeliveryStatus(
    clinicId: ClinicId,
    messageId: string,
    status: 'delivered' | 'read' | 'undelivered',
  ): Promise<AgentMessage>;
  /** Reception updated the phone: the ladder restarts on its previous track. */
  fixPhone(clinicId: ClinicId, patientId: PatientId): Promise<AgentConversation>;
  /** Handler of {@link ORDER_AGENT_TURN_JOB}. */
  runTurnJob(clinicId: ClinicId, payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** Handler of {@link ORDER_AGENT_LADDER_JOB}. */
  runLadderJob(clinicId: ClinicId, payload: Readonly<Record<string, unknown>>): Promise<void>;
  /** Queues the ladder for `[from, to]` of the clinic's clock (a clock jump, the hourly sweep). */
  scheduleLadder(clinicId: ClinicId, from: Date, to: Date): Promise<void>;
  /** Applies the ladder day by day over `[from, to]`, now (tests; the job calls it). */
  advanceLadder(clinicId: ClinicId, from: Date, to: Date): Promise<void>;
  view(clinicId: ClinicId, patientId: PatientId): Promise<AgentConversationView | undefined>;
  listConversations(clinicId: ClinicId): Promise<readonly AgentConversation[]>;
}

const DAY_MS = 86_400_000;

/** Placeholder the model writes for the patient's first name; code fills it in. */
export const FIRST_NAME_PLACEHOLDER = '{first_name}';

function stringField(resource: FhirResourceJson | undefined, field: string): string | undefined {
  const value = resource?.[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The given name of a FHIR Patient (`name[0].given[0]`, else the first word of `name[0].text`). */
export function firstNameOf(resource: FhirResourceJson | undefined): string | undefined {
  const names = resource?.['name'];
  if (!Array.isArray(names)) return undefined;
  const first = names[0] as { given?: unknown; text?: unknown } | undefined;
  if (Array.isArray(first?.given) && typeof first.given[0] === 'string') return first.given[0];
  if (typeof first?.text === 'string') return first.text.trim().split(/\s+/)[0];
  return undefined;
}

function fullNameOf(resource: FhirResourceJson | undefined): string | undefined {
  const names = resource?.['name'];
  if (!Array.isArray(names)) return undefined;
  const first = names[0] as { given?: unknown; family?: unknown; text?: unknown } | undefined;
  if (typeof first?.text === 'string') return first.text;
  const given = Array.isArray(first?.given) ? first.given.filter((g) => typeof g === 'string') : [];
  const family = typeof first?.family === 'string' ? [first.family] : [];
  const joined = [...given, ...family].join(' ');
  return joined === '' ? undefined : joined;
}

/** Short strings, numbers, booleans and string lists only: what a trace may hold. */
export function sanitizeArgs(args: unknown): TraceArgs {
  if (typeof args !== 'object' || args === null) return {};
  const out: Record<string, TraceValue> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.slice(0, key === 'text' ? 400 : 80);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null)
      out[key] = value;
    else if (Array.isArray(value))
      out[key] = value.filter((item): item is string => typeof item === 'string').slice(0, 8);
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'unknown error';
}

/**
 * When a new message is stamped: now, or one second after the latest one
 * when the clinic's clock has not moved since (a demo clock stands still
 * between messages), so the thread keeps its order.
 */
function nextMessageAt(messages: readonly AgentMessage[], now: Date): Date {
  const latest = messages.reduce((max, message) => Math.max(max, message.at.getTime()), 0);
  return new Date(Math.max(now.getTime(), latest + 1_000));
}

/** Copy of the slot list's "reply with the number" hint, in the conversation language. */
const OFFER_HINT: Readonly<Record<OrderAgentLanguage, (count: number) => string>> = {
  en: (count) =>
    count > 1 ? 'Reply with the number that works for you.' : 'Reply yes to book it.',
  es: (count) =>
    count > 1 ? 'Respóndeme con el número que te sirva.' : 'Respóndeme sí para reservarlo.',
};

interface TurnState {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly runId: string;
  readonly mode: OrderAgentMode;
  readonly now: Date;
  readonly rung?: LadderRung;
  readonly trigger: AgentRunTrigger;
  readonly timeZone: string;
  readonly language: OrderAgentLanguage;
  /** Slots `get_available_slots` returned in this turn, by id. */
  readonly slots: Map<string, OfferedSlot>;
  sent: number;
  toolCalls: number;
}

/**
 * The order-to-completion agent's application service (docs/agent/order-to-completion.md).
 * Code owns every decision that must not depend on a model: which orders
 * are the agent's, the contact cap, the ladder's timing, the slots, the
 * booking confirmation and the safety of every outbound message. The model
 * (`OrderAgentModel`) chooses what to do within that, through the tools.
 */
export function createOrderAgentService(deps: OrderAgentServiceDeps): OrderAgentService {
  const maxSteps = deps.maxSteps ?? 12;

  async function timeZoneOf(clinicId: ClinicId): Promise<string> {
    return (await deps.clinics.get(clinicId))?.settings.timezone ?? 'UTC';
  }

  async function step(
    clinicId: ClinicId,
    patientId: PatientId,
    at: Date,
    input: Omit<AgentStep, 'id' | 'seq' | 'clinicId' | 'patientId' | 'at'>,
  ): Promise<AgentStep> {
    return deps.store.appendStep({
      id: deps.newId('agent_step'),
      clinicId,
      patientId,
      at,
      ...input,
    });
  }

  async function readPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<{
    readonly patient: FhirResourceJson | undefined;
    readonly expectations: readonly Expectation[];
    readonly events: readonly ClinicalEvent[];
  }> {
    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const [patient, expectations, events] = await Promise.all([
        stores.clinicalRecords.getResource(clinicId, { resourceType: 'Patient', id: patientId }),
        stores.expectations.listByPatient(clinicId, patientId),
        stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
      ]);
      return { patient: patient?.resource, expectations, events };
    });
  }

  function progressOf(
    conversation: AgentConversation,
    orderId: ExpectationId,
  ): AgentOrderProgress | undefined {
    return conversation.orders.find((item) => item.orderId === orderId);
  }

  /** Every order of the patient the agent owns, with its stage (the engine's fulfilment wins). */
  function orderViews(
    conversation: AgentConversation,
    expectations: readonly Expectation[],
    appointments: readonly AgentAppointment[],
    now: Date,
  ): AgentOrderView[] {
    const upcomingVisit = appointments.find(
      (appointment) =>
        appointment.slot.resourceKind === 'professional' && appointment.slot.start > now,
    );
    return expectations
      .filter((expectation) => isAgentOwned(expectation))
      .filter(
        (expectation) =>
          isPending(expectation) ||
          (expectation.status === 'fulfilled' &&
            (expectation.closedAt?.getTime() ?? 0) >= conversation.createdAt.getTime()),
      )
      .map((expectation) => {
        const descriptor = describeOrder(expectation);
        const progress = progressOf(conversation, expectation.id);
        let stage: AgentOrderView['stage'] =
          expectation.status === 'fulfilled' ? 'fulfilled' : (progress?.stage ?? 'open');
        // A visit order is covered by a visit already booked: nothing more to chase.
        if (
          stage !== 'fulfilled' &&
          descriptor.kind === 'visit' &&
          upcomingVisit !== undefined &&
          (stage === 'open' || stage === 'contacted')
        ) {
          stage = 'booked';
        }
        const appointmentId = progress?.appointmentId ?? upcomingVisit?.id;
        return {
          orderId: expectation.id,
          descriptor,
          expectationStatus: expectation.status,
          stage,
          dueAt: expectation.dueAt,
          urgent: isUrgentOrder(expectation),
          ...(expectation.closedReason === undefined
            ? {}
            : { closedReason: expectation.closedReason }),
          ...(expectation.closedBy === undefined
            ? {}
            : { closedBy: `${expectation.closedBy.resourceType}/${expectation.closedBy.id}` }),
          ...(expectation.closedAt === undefined ? {} : { closedAt: expectation.closedAt }),
          ...(stage === 'booked' && appointmentId !== undefined ? { appointmentId } : {}),
        };
      });
  }

  /** Orders the agent still has to move: pending and not yet booked or answered. */
  function chasing(orders: readonly AgentOrderView[]): AgentOrderView[] {
    return orders.filter((order) => order.stage === 'open' || order.stage === 'contacted');
  }

  async function setProgress(
    conversation: AgentConversation,
    updates: readonly AgentOrderProgress[],
    now: Date,
  ): Promise<AgentConversation> {
    const orders = [
      ...conversation.orders.filter(
        (item) => !updates.some((update) => update.orderId === item.orderId),
      ),
      ...updates,
    ];
    const next = { ...conversation, orders, updatedAt: now };
    await deps.store.saveConversation(next);
    return next;
  }

  async function requireConversation(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<AgentConversation> {
    const conversation = await deps.store.getConversation(clinicId, patientId);
    if (conversation === undefined) {
      throw new ValidationError('patientId', 'The agent does not own orders for this patient yet');
    }
    return conversation;
  }

  async function enqueueTurn(clinicId: ClinicId, payload: OrderAgentTurnJobPayload): Promise<void> {
    await deps.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.jobs.enqueue(clinicId, {
        type: ORDER_AGENT_TURN_JOB,
        payload: { ...payload },
        ...(payload.messageId === undefined
          ? {}
          : { dedupKey: `${ORDER_AGENT_TURN_JOB}:${payload.messageId}` }),
        maxAttempts: 2,
      }),
    );
  }

  async function addTask(
    conversation: AgentConversation,
    input: {
      readonly kind: StaffTaskKind;
      readonly priority: StaffTaskPriority;
      readonly ask: StaffTaskAsk;
      readonly now: Date;
      readonly dueInDays: number;
      readonly rung?: string;
      readonly runId?: string;
    },
  ): Promise<StaffTask> {
    const { clinicId, patientId } = conversation;
    const [{ expectations }, messages, appointments] = await Promise.all([
      readPatient(clinicId, patientId),
      deps.store.listMessages(clinicId, patientId),
      deps.store.listAppointments(clinicId, patientId),
    ]);
    // Still to do: being chased, or left open after an unreachable ladder.
    const orders = orderViews(conversation, expectations, appointments, input.now).filter(
      (order) =>
        order.stage === 'open' || order.stage === 'contacted' || order.stage === 'unreachable',
    );
    const outbound = messages.filter((message) => message.direction === 'outbound');
    const last = outbound.at(-1);
    const task: StaffTask = {
      id: deps.newId('staff_task'),
      clinicId,
      patientId,
      kind: input.kind,
      priority: input.priority,
      summary: {
        orders: orders.map((order) => order.descriptor.test ?? 'visit'),
        outboundCount: outbound.length,
        ...(last === undefined ? {} : { lastOutboundAt: last.at }),
        ...(last?.deliveryStatus === undefined ? {} : { lastStatus: last.deliveryStatus }),
        replied: messages.some((message) => message.direction === 'inbound'),
        ask: input.ask,
      },
      status: 'open',
      ...(input.rung === undefined ? {} : { rung: input.rung }),
      createdAt: input.now,
      dueAt: new Date(input.now.getTime() + input.dueInDays * DAY_MS),
    };
    await deps.store.saveTask(task);
    await step(clinicId, patientId, input.now, {
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      kind: 'ladder',
      outcome: 'ok',
      event: 'staff_task_created',
      params: { kind: input.kind, priority: input.priority, ask: input.ask },
    });
    return task;
  }

  /** Runs the clinical reviewer (findings and questions for the doctor) and traces it; never throws. */
  async function runClinicalReview(
    clinicId: ClinicId,
    patientId: PatientId,
    at: Date,
    input: {
      readonly runId?: string;
      readonly mode: OrderAgentMode;
      readonly language: OrderAgentLanguage;
      readonly on: 'result' | 'booking' | 'arrival';
    },
  ): Promise<void> {
    const runId = input.runId === undefined ? {} : { runId: input.runId };
    try {
      const review = await deps.effects.requestClinicalReview(
        clinicId,
        patientId,
        input.mode,
        input.language,
      );
      await step(clinicId, patientId, at, {
        ...runId,
        kind: 'engine',
        outcome: 'ok',
        event: 'clinical_review_completed',
        params: {
          on: input.on,
          reviewRunId: review.runId,
          status: review.status,
          findings: review.findings.length,
          categories: [...new Set(review.findings.map((item) => item.category))],
        },
      });
    } catch (error) {
      await step(clinicId, patientId, at, {
        ...runId,
        kind: 'engine',
        outcome: 'error',
        event: 'clinical_review_failed',
        params: { error: errorText(error) },
      });
    }
  }

  // --- The turn -------------------------------------------------------------------------

  function localLabel(date: Date, timeZone: string): string {
    const parts = zonedParts(date, timeZone);
    return `${localDateKey(date, timeZone)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  }

  function turnContext(
    conversation: AgentConversation,
    messages: readonly AgentMessage[],
    state: TurnState,
    inbound: AgentMessage | undefined,
  ): Record<string, unknown> {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: state.timeZone,
      weekday: 'long',
    }).format(state.now);
    return {
      trigger: state.trigger,
      now: `${weekday} ${localLabel(state.now, state.timeZone)} (clinic time)`,
      patientLanguage: conversation.language,
      reasonLanguage: conversation.language === 'es' ? 'Spanish' : 'English',
      rung:
        state.rung === undefined
          ? null
          : {
              id: state.rung.id,
              brief: state.rung.brief ?? null,
              slotPreference: state.rung.slotPreference ?? null,
            },
      latestPatientMessage:
        inbound === undefined
          ? null
          : {
              id: inbound.id,
              kind: inbound.kind,
              text: inbound.text,
              hasLabPhoto: inbound.kind === 'image',
            },
      conversation: messages.slice(-12).map((message) => ({
        id: message.id,
        from: message.direction === 'outbound' ? 'agent' : 'patient',
        at: localLabel(message.at, state.timeZone),
        kind: message.kind,
        text: message.text,
        ...(message.offeredSlots === undefined
          ? {}
          : {
              offeredSlots: message.offeredSlots.map((slot, index) => ({
                option: index + 1,
                slotId: slot.id,
                orderId: slot.orderId,
                label: formatSlotTime(slot, conversation.language, state.timeZone),
              })),
            }),
        ...(message.deliveryStatus === undefined ? {} : { status: message.deliveryStatus }),
      })),
    };
  }

  async function sendOutbound(
    state: TurnState,
    conversation: AgentConversation,
    text: string,
    offeredSlots: readonly OfferedSlot[] | undefined,
    reason: string,
    tool: string,
    args: TraceArgs,
  ): Promise<OrderAgentToolOutcome> {
    const { clinicId, patientId, now } = state;
    const messages = await deps.store.listMessages(clinicId, patientId);
    const policy = contactPolicy(conversation, messages, now);
    if (!policy.canSend) {
      await step(clinicId, patientId, now, {
        runId: state.runId,
        kind: 'policy',
        tool,
        arguments: args,
        reason,
        outcome: 'rejected',
        event: 'send_blocked',
        params: { block: policy.block ?? 'unknown' },
      });
      return {
        ok: false,
        error: 'contact_policy',
        detail: {
          block: policy.block,
          nextProactiveAllowedAt: localLabel(policy.nextProactiveAllowedAt, state.timeZone),
        },
      };
    }
    const violations = checkOutboundText(text, deps.safetyTerms);
    if (violations.length > 0) {
      await step(clinicId, patientId, now, {
        runId: state.runId,
        kind: 'guardrail',
        tool,
        arguments: args,
        reason,
        outcome: 'rejected',
        event: 'unsafe_message_blocked',
        params: {
          kinds: [...new Set(violations.map((item) => item.kind))],
          matches: violations.map((item) => item.match).slice(0, 6),
        },
      });
      return {
        ok: false,
        error: 'unsafe_message',
        detail: {
          violations: violations.map((item) => ({ kind: item.kind, text: item.match })),
          rule: 'Never write results, values, verdicts on a result, diagnoses, condition names or treatment instructions. Rewrite the message.',
        },
      };
    }
    const { patient } = await readPatient(clinicId, patientId);
    const firstName = firstNameOf(patient) ?? '';
    let body = text.split(FIRST_NAME_PLACEHOLDER).join(firstName).replace(/\s+,/g, ',').trim();
    if (offeredSlots !== undefined && offeredSlots.length > 0) {
      const lines = offeredSlots.map(
        (slot, index) =>
          `${String(index + 1)}. ${formatSlotLine(slot, conversation.language, state.timeZone)}`,
      );
      body = `${body}\n\n${lines.join('\n')}\n\n${OFFER_HINT[conversation.language](offeredSlots.length)}`;
    }
    const proactive = policy.sendKind === 'proactive';
    const message: AgentMessage = {
      id: deps.newId('agent_message'),
      clinicId,
      patientId,
      direction: 'outbound',
      kind: 'text',
      text: body,
      at: nextMessageAt(messages, now),
      // The simulated channel delivers at once; the evaluator marks read or undelivered.
      deliveryStatus: 'delivered',
      statusAt: now,
      ...(offeredSlots === undefined || offeredSlots.length === 0 ? {} : { offeredSlots }),
      ...(proactive && state.rung !== undefined ? { rung: state.rung.id } : {}),
      runId: state.runId,
      proactive,
    };
    await deps.store.saveMessage(message);
    state.sent += 1;
    await step(clinicId, patientId, now, {
      runId: state.runId,
      kind: 'tool',
      tool,
      arguments: args,
      read: ['contact_policy', 'outbound_safety'],
      reason,
      outcome: 'ok',
      event: offeredSlots === undefined ? 'message_sent' : 'slots_offered',
      params: {
        messageId: message.id,
        sendKind: policy.sendKind,
        ...(offeredSlots === undefined ? {} : { slots: offeredSlots.map((slot) => slot.id) }),
      },
    });
    // Every order still being chased has now been contacted.
    const [{ expectations }, appointments] = await Promise.all([
      readPatient(clinicId, patientId),
      deps.store.listAppointments(clinicId, patientId),
    ]);
    const current = (await deps.store.getConversation(clinicId, patientId)) ?? conversation;
    const updates = chasing(orderViews(current, expectations, appointments, now))
      .filter((order) => order.stage === 'open')
      .map((order): AgentOrderProgress => ({
        orderId: order.orderId,
        stage: 'contacted',
        updatedAt: now,
      }));
    if (updates.length > 0) await setProgress(current, updates, now);
    return { ok: true, result: { sent: true, messageId: message.id, sendKind: policy.sendKind } };
  }

  function createToolbox(state: TurnState) {
    const { clinicId, patientId } = state;

    async function trace(
      tool: string,
      args: unknown,
      reason: string,
      outcome: AgentStep['outcome'],
      event: string,
      params: TraceArgs,
      read: readonly string[],
    ): Promise<void> {
      await step(clinicId, patientId, state.now, {
        runId: state.runId,
        kind: 'tool',
        tool,
        arguments: sanitizeArgs(args),
        read,
        reason,
        outcome,
        event,
        params,
      });
    }

    async function ownedPendingOrder(
      orderId: string,
    ): Promise<{ expectation: Expectation; descriptor: OrderDescriptor } | undefined> {
      const { expectations } = await readPatient(clinicId, patientId);
      const expectation = expectations.find((item) => item.id === orderId);
      if (expectation === undefined || !isAgentOwned(expectation) || !isPending(expectation)) {
        return undefined;
      }
      return { expectation, descriptor: describeOrder(expectation) };
    }

    async function refuse(
      tool: string,
      args: unknown,
      reason: string,
      error: string,
      read: readonly string[],
      detail?: unknown,
    ): Promise<OrderAgentToolOutcome> {
      await trace(tool, args, reason, 'rejected', 'tool_refused', { error }, read);
      return { ok: false, error, ...(detail === undefined ? {} : { detail }) };
    }

    async function engineSteps(
      outcome: EngineOutcome,
      expectations: readonly Expectation[],
    ): Promise<void> {
      for (const closed of outcome.closed) {
        const expectation = expectations.find((item) => item.id === closed.expectationId);
        const descriptor = expectation === undefined ? undefined : describeOrder(expectation);
        await step(clinicId, patientId, state.now, {
          runId: state.runId,
          kind: 'engine',
          outcome: 'ok',
          event: 'expectation_fulfilled',
          params: {
            expectationId: closed.expectationId,
            order: descriptor?.test ?? descriptor?.kind ?? 'order',
            owned: expectation === undefined ? false : isAgentOwned(expectation),
            reason: closed.reason,
            by: outcome.resource,
          },
        });
      }
      for (const created of outcome.created) {
        await step(clinicId, patientId, state.now, {
          runId: state.runId,
          kind: 'engine',
          outcome: 'info',
          event: 'expectation_created',
          params: { expectationId: created.expectationId, ruleId: created.ruleId },
        });
      }
    }

    async function execute(
      name: string,
      args: unknown,
      reason: string,
    ): Promise<OrderAgentToolOutcome> {
      state.toolCalls += 1;
      const conversation = await requireConversation(clinicId, patientId);
      switch (name) {
        case 'list_open_orders': {
          const [{ expectations }, appointments] = await Promise.all([
            readPatient(clinicId, patientId),
            deps.store.listAppointments(clinicId, patientId),
          ]);
          const orders = orderViews(conversation, expectations, appointments, state.now).filter(
            (order) => order.stage !== 'fulfilled',
          );
          const ignored = expectations.filter(
            (expectation) => isPending(expectation) && !isAgentOwned(expectation),
          ).length;
          await trace(
            name,
            args,
            reason,
            'ok',
            'orders_listed',
            { open: orders.length, ignoredEngineItems: ignored },
            ['expectations', 'appointments'],
          );
          return {
            ok: true,
            result: {
              orders: orders.map((order) => ({
                orderId: order.orderId,
                kind: order.descriptor.kind,
                ...(order.descriptor.test === undefined ? {} : { test: order.descriptor.test }),
                source: order.descriptor.source,
                dueDate: localDateKey(order.dueAt, state.timeZone),
                overdueDays: Math.max(
                  0,
                  Math.floor((state.now.getTime() - order.dueAt.getTime()) / DAY_MS),
                ),
                urgent: order.urgent,
                stage: order.stage,
              })),
              upcomingAppointments: appointments
                .filter((item) => item.slot.start > state.now)
                .map((item) => ({
                  kind: item.slot.resourceKind === 'lab' ? 'lab' : 'visit',
                  when: formatSlotTime(item.slot, conversation.language, state.timeZone),
                })),
              note: 'Only these are yours. Protocol suggestions of the engine are not orders and are not listed.',
            },
          };
        }
        case 'read_patient_summary': {
          const [{ patient, events }, appointments] = await Promise.all([
            readPatient(clinicId, patientId),
            deps.store.listAppointments(clinicId, patientId),
          ]);
          const birthDate = stringField(patient, 'birthDate');
          const age =
            birthDate === undefined
              ? undefined
              : Math.floor(
                  (state.now.getTime() -
                    new Date(`${birthDate.slice(0, 10)}T00:00:00Z`).getTime()) /
                    (365.25 * DAY_MS),
                );
          const lastVisit = events
            .filter(
              (event) => event.type === 'encounter.finished' || event.type === 'note.received',
            )
            .at(-1)?.occurredAt;
          const upcoming = appointments.filter((item) => item.slot.start > state.now);
          await trace(name, args, reason, 'ok', 'patient_summary_read', {}, [
            'patient',
            'clinical_events',
            'appointments',
          ]);
          return {
            ok: true,
            result: {
              patientRef: `P-${patientId.slice(-6)}`,
              ...(age === undefined ? {} : { ageYears: age }),
              ...(stringField(patient, 'gender') === undefined
                ? {}
                : { sex: stringField(patient, 'gender') }),
              language: conversation.language,
              ...(lastVisit === undefined
                ? {}
                : {
                    daysSinceLastVisit: Math.floor(
                      (state.now.getTime() - lastVisit.getTime()) / DAY_MS,
                    ),
                  }),
              channel: 'whatsapp',
              nameInMessages: FIRST_NAME_PLACEHOLDER,
              upcomingAppointments: upcoming.map((item) => ({
                kind: item.slot.resourceKind === 'lab' ? 'lab' : 'visit',
                when: formatSlotTime(item.slot, conversation.language, state.timeZone),
              })),
            },
          };
        }
        case 'get_contact_policy': {
          const messages = await deps.store.listMessages(clinicId, patientId);
          const policy = contactPolicy(conversation, messages, state.now);
          await trace(
            name,
            args,
            reason,
            'ok',
            'policy_read',
            {
              canSend: policy.canSend,
              sendKind: policy.sendKind,
              proactiveRemaining: policy.proactiveRemaining,
            },
            ['messages', 'conversation'],
          );
          return {
            ok: true,
            result: {
              canSendNow: policy.canSend,
              ...(policy.block === undefined ? {} : { block: policy.block }),
              sendKind: policy.sendKind,
              proactiveRemainingThisWeek: policy.proactiveRemaining,
              nextProactiveAllowedAt: localLabel(policy.nextProactiveAllowedAt, state.timeZone),
              repliesLeftForThisMessage: policy.repliesLeft,
              optedOut: policy.optedOut,
              phoneUndelivered: policy.phoneUndelivered,
              ladder: {
                track: conversation.ladder.track,
                rung: state.rung?.id ?? null,
                brief: state.rung?.brief ?? null,
              },
            },
          };
        }
        case 'get_available_slots': {
          const parsed = GetAvailableSlotsArgs.parse(args);
          const order = await ownedPendingOrder(parsed.orderId);
          if (order === undefined) {
            return refuse(name, args, reason, 'not_an_open_order', ['expectations']);
          }
          const [messages, allAppointments] = await Promise.all([
            deps.store.listMessages(clinicId, patientId),
            deps.store.listAppointments(clinicId),
          ]);
          const preference: SlotPreference =
            parsed.preference ?? state.rung?.slotPreference ?? 'earliest';
          const previouslyOffered = messages.flatMap((message) =>
            (message.offeredSlots ?? []).filter((slot) => slot.orderId === parsed.orderId),
          );
          const slots = availableSlots({
            now: state.now,
            timeZone: state.timeZone,
            kind: order.descriptor.resourceKind,
            preference,
            urgent: isUrgentOrder(order.expectation),
            excludeWeekdays: parsed.excludeWeekdays ?? [],
            previouslyOffered,
            booked: new Set(allAppointments.map((item) => item.slot.id)),
            count: 3,
          });
          for (const slot of slots)
            state.slots.set(slot.id, { ...slot, orderId: order.expectation.id });
          await trace(
            name,
            args,
            reason,
            'ok',
            'slots_found',
            { count: slots.length, preference, slotIds: slots.map((slot) => slot.id) },
            ['schedule', 'appointments', 'messages'],
          );
          return {
            ok: true,
            result: {
              orderId: parsed.orderId,
              preference,
              slots: slots.map((slot) => ({
                slotId: slot.id,
                label: formatSlotTime(slot, conversation.language, state.timeZone),
                with: slot.resourceKind === 'lab' ? 'lab' : 'treating professional',
                resource: slot.resource,
              })),
              ...(slots.length === 0 ? { note: 'No free slot fits: try another preference.' } : {}),
            },
          };
        }
        case 'send_message': {
          const parsed = SendMessageArgs.parse(args);
          return sendOutbound(
            state,
            conversation,
            parsed.text,
            undefined,
            reason,
            name,
            sanitizeArgs(args),
          );
        }
        case 'propose_slots': {
          const parsed = ProposeSlotsArgs.parse(args);
          const order = await ownedPendingOrder(parsed.orderId);
          if (order === undefined) {
            return refuse(name, args, reason, 'not_an_open_order', ['expectations']);
          }
          const booked = new Set(
            (await deps.store.listAppointments(clinicId)).map((a) => a.slot.id),
          );
          const offered: OfferedSlot[] = [];
          for (const id of [...new Set(parsed.slotIds)]) {
            const fromTurn = state.slots.get(id);
            const slot = fromTurn ?? slotFromId(id, state.timeZone, booked);
            if (
              slot === undefined ||
              booked.has(id) ||
              (fromTurn !== undefined && fromTurn.orderId !== parsed.orderId)
            ) {
              return refuse(name, args, reason, 'unknown_or_taken_slot', ['schedule'], {
                slotId: id,
              });
            }
            offered.push({ ...slot, orderId: order.expectation.id });
          }
          return sendOutbound(
            state,
            conversation,
            parsed.text,
            offered,
            reason,
            name,
            sanitizeArgs(args),
          );
        }
        case 'create_appointment': {
          const parsed = CreateAppointmentArgs.parse(args);
          const order = await ownedPendingOrder(parsed.orderId);
          if (order === undefined) {
            return refuse(name, args, reason, 'not_an_open_order', ['expectations']);
          }
          const messages = await deps.store.listMessages(clinicId, patientId);
          const allAppointments = await deps.store.listAppointments(clinicId);
          const existing = allAppointments.find(
            (item) => item.confirmationMessageId === parsed.confirmationMessageId,
          );
          if (existing !== undefined) {
            await trace(
              name,
              args,
              reason,
              'ok',
              'appointment_already_booked',
              { appointmentId: existing.id },
              ['appointments'],
            );
            return {
              ok: true,
              result: {
                booked: true,
                duplicate: true,
                appointmentId: existing.id,
                when: formatSlotTime(existing.slot, conversation.language, state.timeZone),
              },
            };
          }
          const booked = new Set(allAppointments.map((item) => item.slot.id));
          const check = checkBookingConfirmation({
            orderId: parsed.orderId,
            slotId: parsed.slotId,
            confirmationMessageId: parsed.confirmationMessageId,
            messages,
            slotStillFree: slotFromId(parsed.slotId, state.timeZone, booked) !== undefined,
            timeZone: state.timeZone,
          });
          if (!check.ok) {
            await step(clinicId, patientId, state.now, {
              runId: state.runId,
              kind: 'guardrail',
              tool: name,
              arguments: sanitizeArgs(args),
              read: ['messages', 'schedule', 'appointments'],
              reason,
              outcome: 'rejected',
              event: 'booking_refused',
              params: { reason: check.reason },
            });
            return {
              ok: false,
              error: 'booking_refused',
              detail: {
                reason: check.reason,
                rule: 'Book only an offered, free slot that the patient explicitly confirmed in their latest message.',
              },
            };
          }
          const appointmentIdOf = deps.newId('agent_appointment');
          const appointment: AgentAppointment = {
            id: appointmentIdOf,
            clinicId,
            patientId,
            orderId: order.expectation.id,
            slot: check.slot,
            confirmationMessageId: parsed.confirmationMessageId,
            bookedAt: state.now,
            ...(order.expectation.caseId === undefined
              ? {}
              : { originCaseId: order.expectation.caseId }),
            ...(check.slot.resourceKind === 'professional'
              ? { fhirAppointmentId: `Appointment/${appointmentFhirId(appointmentIdOf)}` }
              : {}),
          };
          const stored = await deps.store.addAppointment(appointment);
          if (stored.status === 'duplicate') {
            return {
              ok: true,
              result: { booked: true, duplicate: true, appointmentId: stored.appointment.id },
            };
          }
          await trace(
            name,
            args,
            reason,
            'ok',
            'appointment_booked',
            {
              appointmentId: appointment.id,
              slotId: appointment.slot.id,
              resource: appointment.slot.resource,
            },
            ['messages', 'schedule', 'appointments'],
          );
          let closedOrders: string[] = [];
          if (check.slot.resourceKind === 'professional') {
            const outcome = await deps.effects.bookVisit(clinicId, {
              patientId,
              appointmentId: appointment.id,
              slot: check.slot,
              bookedAt: state.now,
              ...(appointment.originCaseId === undefined
                ? {}
                : { originCaseId: appointment.originCaseId }),
            });
            const { expectations } = await readPatient(clinicId, patientId);
            await engineSteps(outcome, expectations);
            closedOrders = outcome.closed.map((item) => item.expectationId);
            // A visit is booked: the reviewer prepares the doctor's questions for it.
            await runClinicalReview(clinicId, patientId, state.now, {
              runId: state.runId,
              mode: state.mode,
              language: state.language,
              on: 'booking',
            });
          }
          const current = await requireConversation(clinicId, patientId);
          await setProgress(
            current,
            [
              {
                orderId: order.expectation.id,
                stage: 'booked',
                appointmentId: appointment.id,
                updatedAt: state.now,
              },
            ],
            state.now,
          );
          return {
            ok: true,
            result: {
              booked: true,
              appointmentId: appointment.id,
              when: formatSlotTime(check.slot, conversation.language, state.timeZone),
              where: formatSlotLine(check.slot, conversation.language, state.timeZone),
              engine: { fulfilledOrders: closedOrders },
            },
          };
        }
        case 'match_result_to_order': {
          const parsed = MatchResultArgs.parse(args);
          const message = await deps.store.getMessage(clinicId, parsed.messageId);
          if (message?.patientId !== patientId || message.kind !== 'image') {
            return refuse(name, args, reason, 'not_a_photo_message', ['messages']);
          }
          if (message.reading?.isLabReport !== true) {
            await trace(name, args, reason, 'ok', 'photo_not_a_report', {}, [
              `message:${message.id}`,
            ]);
            return { ok: true, result: { isLabReport: false, matches: [] } };
          }
          const match = await matchReading(message);
          await trace(
            name,
            args,
            reason,
            'ok',
            'result_matched',
            {
              matches: match.matches.map((item) => item.test),
              unmatched: match.unmatched,
              nameCheck: match.nameCheck,
            },
            [`message:${message.id}`, 'vision_reading', 'expectations', 'lab_test_catalog'],
          );
          return {
            ok: true,
            result: {
              isLabReport: true,
              matches: match.matches.map((item) => ({ orderId: item.orderId, test: item.test })),
              unmatchedTests: match.unmatched,
              nameOnReport: match.nameCheck,
              note: 'Values are kept by code and never shown to you.',
            },
          };
        }
        case 'submit_fhir_result': {
          const parsed = SubmitResultArgs.parse(args);
          const message = await deps.store.getMessage(clinicId, parsed.messageId);
          if (
            message?.patientId !== patientId ||
            message.kind !== 'image' ||
            message.reading === undefined
          ) {
            return refuse(name, args, reason, 'not_a_photo_message', ['messages']);
          }
          const match = await matchReading(message);
          const hit = match.matches.find((item) => item.orderId === parsed.orderId);
          if (hit === undefined) {
            return refuse(name, args, reason, 'photo_does_not_answer_order', [
              `message:${message.id}`,
              'expectations',
            ]);
          }
          if (match.nameCheck === 'mismatch') {
            return refuse(
              name,
              args,
              reason,
              'name_on_report_does_not_match',
              [`message:${message.id}`, 'patient'],
              {
                next: 'Do not submit. Hand over to the clinic team with create_staff_task.',
              },
            );
          }
          const test = hit.reading;
          const interpretation =
            test.referenceHigh !== undefined && test.value > test.referenceHigh
              ? 'H'
              : test.referenceLow !== undefined && test.value < test.referenceLow
                ? 'L'
                : test.referenceHigh !== undefined || test.referenceLow !== undefined
                  ? 'N'
                  : undefined;
          const reportDate =
            message.reading.reportDate !== undefined &&
            /^\d{4}-\d{2}-\d{2}$/.test(message.reading.reportDate)
              ? new Date(`${message.reading.reportDate}T12:00:00Z`)
              : message.at;
          const effectiveAt = reportDate.getTime() > state.now.getTime() ? message.at : reportDate;
          const observationId = `agent-obs-${message.id.replace(/^agent-message-/, '')}-${hit.groupId}`;
          const outcome = await deps.effects.submitResult(clinicId, {
            patientId,
            observationId,
            code: { system: hit.code.system, code: hit.code.code, display: hit.test },
            value: test.value,
            ...(test.unit === undefined ? {} : { unit: test.unit }),
            ...(test.referenceLow === undefined ? {} : { referenceLow: test.referenceLow }),
            ...(test.referenceHigh === undefined ? {} : { referenceHigh: test.referenceHigh }),
            ...(interpretation === undefined ? {} : { interpretation }),
            effectiveAt,
            receivedAt: state.now,
          });
          await trace(
            name,
            args,
            reason,
            'ok',
            'result_submitted',
            { resource: outcome.resource, test: hit.test },
            [`message:${message.id}`, 'vision_reading'],
          );
          const { expectations } = await readPatient(clinicId, patientId);
          await engineSteps(outcome, expectations);
          const fulfilled = outcome.closed.some((item) => item.expectationId === parsed.orderId);
          if (!fulfilled) {
            await step(clinicId, patientId, state.now, {
              runId: state.runId,
              kind: 'engine',
              outcome: 'info',
              event: 'expectation_still_open',
              params: { expectationId: parsed.orderId, by: outcome.resource },
            });
          }
          const current = await requireConversation(clinicId, patientId);
          await setProgress(
            current,
            [
              {
                orderId: parsed.orderId as ExpectationId,
                stage: 'result_received',
                updatedAt: state.now,
              },
            ],
            state.now,
          );
          let doctorReview: 'requested' | 'not_needed' = 'not_needed';
          if (interpretation === 'H' || interpretation === 'L') {
            doctorReview = 'requested';
            await runClinicalReview(clinicId, patientId, state.now, {
              runId: state.runId,
              mode: state.mode,
              language: state.language,
              on: 'result',
            });
          }
          const newOrders = outcome.created
            .map((item) =>
              expectations.find((expectation) => expectation.id === item.expectationId),
            )
            .filter(
              (item): item is Expectation =>
                item !== undefined && isAgentOwned(item) && isPending(item),
            );
          return {
            ok: true,
            result: {
              submitted: true,
              resource: outcome.resource,
              engine: {
                fulfilledOrders: outcome.closed
                  .filter((item) =>
                    expectations.find((e) => e.id === item.expectationId && isAgentOwned(e)),
                  )
                  .map((item) => item.expectationId),
                orderStillOpen: !fulfilled,
                newOrders: newOrders.map((item) => ({
                  orderId: item.id,
                  urgent: isUrgentOrder(item),
                })),
              },
              doctorReview,
              note:
                doctorReview === 'requested'
                  ? 'The doctor will review the result. Tell the patient only that the doctor will review it; never its value or meaning.'
                  : 'Thank the patient; never comment on the result.',
            },
          };
        }
        case 'create_staff_task': {
          const parsed = CreateStaffTaskArgs.parse(args);
          const task = await addTask(conversation, {
            kind: 'call_patient',
            priority: 'normal',
            ask: 'patient_question',
            now: state.now,
            dueInDays: 1,
            runId: state.runId,
          });
          await trace(
            name,
            args,
            reason,
            'ok',
            'handed_to_staff',
            { taskId: task.id, reason: parsed.reason },
            ['conversation'],
          );
          return {
            ok: true,
            result: {
              taskId: task.id,
              note: 'Tell the patient the clinic team will contact them.',
            },
          };
        }
        case 'end_turn': {
          const parsed = EndTurnArgs.parse(args);
          await trace(
            name,
            args,
            reason,
            'ok',
            'turn_ended',
            { summary: parsed.summary.slice(0, 200) },
            [],
          );
          return { ok: true, result: { ended: true } };
        }
        default:
          return refuse(name, args, reason, 'unknown_tool', []);
      }
    }

    async function matchReading(message: AgentMessage): Promise<{
      matches: {
        orderId: ExpectationId;
        test: string;
        groupId: string;
        code: { system: string; code: string };
        reading: NonNullable<AgentMessage['reading']>['tests'][number];
      }[];
      unmatched: string[];
      nameCheck: 'matches' | 'mismatch' | 'absent';
    }> {
      const { expectations, patient } = await readPatient(clinicId, patientId);
      const owned = expectations.filter((item) => isAgentOwned(item) && isPending(item));
      const matches: Awaited<ReturnType<typeof matchReading>>['matches'] = [];
      const unmatched: string[] = [];
      for (const test of message.reading?.tests ?? []) {
        const group = testGroupsNamedIn(test.name, 'lab')[0];
        const order =
          group === undefined
            ? undefined
            : owned.find((expectation) => {
                const descriptor = describeOrder(expectation);
                return (
                  descriptor.kind === 'test' &&
                  descriptor.code !== undefined &&
                  group.loinc.includes(descriptor.code.code)
                );
              });
        const code = group?.loinc[0];
        if (order === undefined || group === undefined || code === undefined) {
          unmatched.push(group?.label ?? test.name.slice(0, 40));
          continue;
        }
        if (!matches.some((item) => item.orderId === order.id)) {
          matches.push({
            orderId: order.id,
            test: group.label,
            groupId: group.id,
            code: { system: 'http://loinc.org', code },
            reading: test,
          });
        }
      }
      const printed = message.reading?.patientName;
      let nameCheck: 'matches' | 'mismatch' | 'absent' = 'absent';
      if (printed !== undefined && printed.trim() !== '') {
        const known = fold(fullNameOf(patient) ?? '')
          .trim()
          .split(' ')
          .filter((part) => part.length > 2);
        const seen = fold(printed).trim().split(' ');
        nameCheck =
          known.length > 0 && known.some((part) => seen.includes(part)) ? 'matches' : 'mismatch';
      }
      return { matches, unmatched, nameCheck };
    }

    async function reject(
      name: string,
      error: string,
      detail: string,
      reason: string,
    ): Promise<void> {
      await step(clinicId, patientId, state.now, {
        runId: state.runId,
        kind: 'tool',
        tool: name.slice(0, 40),
        reason,
        outcome: 'rejected',
        event: 'call_rejected',
        params: { error, detail: detail.slice(0, 200) },
      });
    }

    return { definitions: ORDER_AGENT_TOOLS, execute, reject };
  }

  async function readMedia(
    conversation: AgentConversation,
    message: AgentMessage,
    runId: string,
    now: Date,
  ): Promise<AgentMessage> {
    if (message.media === undefined) return message;
    const media = await deps.store.getMedia(message.clinicId, message.media.id);
    if (media === undefined) return message;
    const { clinicId, patientId } = message;
    const attempt = async (mode: OrderAgentMode): Promise<AgentMessage> => {
      if (message.kind === 'voice' && message.transcript === undefined) {
        const heard = await deps.media.transcribe(clinicId, {
          mode,
          audio: media.data,
          contentType: media.contentType,
        });
        const next: AgentMessage = {
          ...message,
          text: heard.transcript,
          transcript: heard.transcript,
        };
        await deps.store.saveMessage(next);
        await step(clinicId, patientId, now, {
          runId,
          kind: 'transcription',
          outcome: 'ok',
          event: 'voice_transcribed',
          params: {
            messageId: message.id,
            transcript: heard.transcript.slice(0, 400),
            ...(heard.durationMs === undefined ? {} : { durationMs: heard.durationMs }),
          },
          model: heard.model,
          costUsd: heard.costUsd,
          latencyMs: heard.latencyMs,
        });
        return next;
      }
      if (message.kind === 'image' && message.reading === undefined) {
        const read = await deps.media.readLabPhoto(clinicId, {
          mode,
          image: media.data,
          contentType: media.contentType,
        });
        const next: AgentMessage = { ...message, reading: read.reading };
        await deps.store.saveMessage(next);
        await step(clinicId, patientId, now, {
          runId,
          kind: 'vision',
          outcome: 'ok',
          event: 'photo_read',
          params: {
            messageId: message.id,
            isLabReport: read.reading.isLabReport,
            tests: read.reading.tests.map(
              (test) =>
                `${test.name}: ${String(test.value)}${test.unit === undefined ? '' : ` ${test.unit}`}${
                  test.referenceLow === undefined && test.referenceHigh === undefined
                    ? ''
                    : ` (ref ${String(test.referenceLow ?? '')}–${String(test.referenceHigh ?? '')})`
                }`,
            ),
            ...(read.reading.reportDate === undefined
              ? {}
              : { reportDate: read.reading.reportDate }),
          },
          model: read.model,
          costUsd: read.costUsd,
          latencyMs: read.latencyMs,
        });
        return next;
      }
      return message;
    };
    try {
      return await attempt(conversation.mode);
    } catch (error) {
      if (conversation.mode === 'live' && error instanceof LlmBudgetExceededError) {
        await step(clinicId, patientId, now, {
          runId,
          kind: 'policy',
          outcome: 'info',
          event: 'budget_fallback_scripted',
          params: {},
        });
        return attempt('scripted');
      }
      await step(clinicId, patientId, now, {
        runId,
        kind: message.kind === 'voice' ? 'transcription' : 'vision',
        outcome: 'error',
        event: 'media_unreadable',
        params: { messageId: message.id, error: errorText(error) },
      });
      return message;
    }
  }

  async function runTurn(
    clinicId: ClinicId,
    patientId: PatientId,
    trigger: AgentRunTrigger,
    options: { readonly messageId?: string; readonly rung?: string; readonly now: Date },
  ): Promise<AgentRun | undefined> {
    if (options.messageId !== undefined) {
      const done = await deps.store.findRunForInbound(clinicId, options.messageId);
      if (done !== undefined) return done;
    }
    const conversation = await deps.store.getConversation(clinicId, patientId);
    if (conversation === undefined || conversation.status === 'opted_out') return undefined;
    const now = options.now;
    const timeZone = await timeZoneOf(clinicId);
    const rung = options.rung === undefined ? undefined : rungById(options.rung);
    let run: AgentRun = {
      id: deps.newId('agent_run'),
      clinicId,
      patientId,
      trigger,
      status: 'running',
      mode: conversation.mode,
      ...(options.messageId === undefined ? {} : { inboundMessageId: options.messageId }),
      ...(rung === undefined ? {} : { rung: rung.id }),
      startedAt: now,
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    await deps.store.saveRun(run);
    await step(clinicId, patientId, now, {
      runId: run.id,
      kind: 'ladder',
      outcome: 'info',
      event: 'turn_started',
      params: {
        trigger,
        ...(rung === undefined ? {} : { rung: rung.id }),
        mode: conversation.mode,
      },
    });
    let inbound: AgentMessage | undefined;
    if (options.messageId !== undefined) {
      const message = await deps.store.getMessage(clinicId, options.messageId);
      inbound =
        message === undefined ? undefined : await readMedia(conversation, message, run.id, now);
    }
    const messages = await deps.store.listMessages(clinicId, patientId);
    const { patient } = await readPatient(clinicId, patientId);
    const redactTerms = patient === undefined ? [] : (deps.redactTermsOf?.(patient) ?? []);
    const state: TurnState = {
      clinicId,
      patientId,
      runId: run.id,
      mode: conversation.mode,
      now,
      ...(rung === undefined ? {} : { rung }),
      trigger,
      timeZone,
      language: conversation.language,
      slots: new Map(),
      sent: 0,
      toolCalls: 0,
    };
    const context = turnContext(conversation, messages, state, inbound);
    const toolbox = createToolbox(state);
    const onModelCall = async (call: OrderAgentModelCall): Promise<void> => {
      run = {
        ...run,
        model: call.model,
        modelCalls: run.modelCalls + 1,
        inputTokens: run.inputTokens + call.inputTokens,
        outputTokens: run.outputTokens + call.outputTokens,
        costUsd: run.costUsd + call.costUsd,
      };
      await deps.store.saveRun(run);
      await step(clinicId, patientId, now, {
        runId: run.id,
        kind: 'model',
        tool: call.tool.slice(0, 40),
        reason: call.thought.slice(0, 400),
        outcome: 'ok',
        event: 'model_called',
        params: { index: call.index, repaired: call.repaired, tool: call.tool.slice(0, 40) },
        model: call.model,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
      });
    };
    const play = (mode: OrderAgentMode) =>
      deps.model.runTurn(clinicId, {
        mode,
        context,
        toolbox,
        maxSteps,
        redactTerms,
        onModelCall,
      });
    try {
      let result;
      try {
        result = await play(conversation.mode);
      } catch (error) {
        if (conversation.mode !== 'live' || !(error instanceof LlmBudgetExceededError)) throw error;
        await step(clinicId, patientId, now, {
          runId: run.id,
          kind: 'policy',
          outcome: 'info',
          event: 'budget_fallback_scripted',
          params: {},
        });
        result = await play('scripted');
      }
      run = {
        ...run,
        status: 'completed',
        finishedAt: now,
        toolCalls: state.toolCalls,
        stopReason: result.stopReason,
      };
    } catch (error) {
      run = {
        ...run,
        status: 'failed',
        finishedAt: now,
        toolCalls: state.toolCalls,
        stopReason: 'error',
        error: errorText(error),
      };
      await step(clinicId, patientId, now, {
        runId: run.id,
        kind: 'model',
        outcome: 'error',
        event: 'turn_failed',
        params: { error: errorText(error) },
      });
    }
    await deps.store.saveRun(run);
    await afterTurn(clinicId, patientId, trigger, state, now);
    return run;
  }

  /** After a turn: re-anchor the ladder on a live conversation, close it when nothing is left. */
  async function afterTurn(
    clinicId: ClinicId,
    patientId: PatientId,
    trigger: AgentRunTrigger,
    state: TurnState,
    now: Date,
  ): Promise<void> {
    const conversation = await deps.store.getConversation(clinicId, patientId);
    if (conversation?.status !== 'active') return;
    const [{ expectations }, appointments] = await Promise.all([
      readPatient(clinicId, patientId),
      deps.store.listAppointments(clinicId, patientId),
    ]);
    const pending = chasing(orderViews(conversation, expectations, appointments, now));
    if (pending.length === 0) {
      await deps.store.saveConversation({ ...conversation, status: 'done', updatedAt: now });
      await step(clinicId, patientId, now, {
        runId: state.runId,
        kind: 'ladder',
        outcome: 'ok',
        event: 'all_orders_covered',
        params: {},
      });
      return;
    }
    if (
      trigger === 'inbound_message' &&
      state.sent > 0 &&
      conversation.ladder.track !== 'undelivered'
    ) {
      const track = pending.some((order) => order.urgent) ? 'urgent' : 'routine';
      await deps.store.saveConversation({
        ...conversation,
        ladder: startTrack(track, now, { firstDone: true }),
        updatedAt: now,
      });
      await step(clinicId, patientId, now, {
        runId: state.runId,
        kind: 'ladder',
        outcome: 'info',
        event: 'ladder_reanchored',
        params: { track },
      });
    }
  }

  // --- The ladder -----------------------------------------------------------------------

  async function applyRung(
    conversation: AgentConversation,
    rung: LadderRung,
    at: Date,
  ): Promise<void> {
    const { clinicId, patientId } = conversation;
    const marked: AgentConversation = {
      ...conversation,
      ladder: { ...conversation.ladder, done: [...conversation.ladder.done, rung.id] },
      updatedAt: at,
    };
    await deps.store.saveConversation(marked);
    await step(clinicId, patientId, at, {
      kind: 'ladder',
      outcome: 'info',
      event: 'rung_due',
      params: { rung: rung.id, action: rung.action },
    });
    switch (rung.action) {
      case 'message': {
        const messages = await deps.store.listMessages(clinicId, patientId);
        const policy = contactPolicy(marked, messages, at);
        if (!policy.canSend) {
          await step(clinicId, patientId, at, {
            kind: 'policy',
            outcome: 'rejected',
            event: 'rung_skipped',
            params: { rung: rung.id, block: policy.block ?? 'unknown' },
          });
          return;
        }
        await runTurn(clinicId, patientId, 'ladder_rung', { rung: rung.id, now: at });
        return;
      }
      case 'call_task':
        await addTask(marked, {
          kind: 'call_patient',
          priority: rung.priority ?? 'normal',
          ask: rung.track === 'urgent' ? 'urgent_unanswered' : 'book_orders',
          now: at,
          dueInDays: rung.track === 'urgent' ? 0 : 2,
          rung: rung.id,
        });
        return;
      case 'doctor_notice':
        await addTask(marked, {
          kind: 'doctor_notice',
          priority: rung.priority ?? 'high',
          ask: 'urgent_unanswered',
          now: at,
          dueInDays: 0,
          rung: rung.id,
        });
        return;
      case 'update_phone_task':
        await addTask(marked, {
          kind: 'update_phone',
          priority: marked.ladder.resumeTrack === 'urgent' ? 'high' : 'normal',
          ask: 'update_phone',
          now: at,
          dueInDays: 0,
          rung: rung.id,
        });
        return;
      case 'other_contact_task':
        await addTask(marked, {
          kind: 'call_other_contact',
          priority: marked.ladder.resumeTrack === 'urgent' ? 'high' : 'normal',
          ask: 'reach_other_contact',
          now: at,
          dueInDays: 1,
          rung: rung.id,
        });
        return;
      case 'unreachable': {
        const urgent = rung.track === 'urgent' || marked.ladder.resumeTrack === 'urgent';
        const [{ expectations }, appointments] = await Promise.all([
          readPatient(clinicId, patientId),
          deps.store.listAppointments(clinicId, patientId),
        ]);
        const pending = chasing(orderViews(marked, expectations, appointments, at));
        const next: AgentConversation = {
          ...marked,
          status: 'unreachable',
          orders: [
            ...marked.orders.filter(
              (item) => !pending.some((order) => order.orderId === item.orderId),
            ),
            ...pending.map((order): AgentOrderProgress => ({
              orderId: order.orderId,
              stage: 'unreachable',
              updatedAt: at,
            })),
          ],
          ...(urgent
            ? { flagAtNextContact: true }
            : { retryAt: new Date(at.getTime() + UNREACHABLE_RETRY_DAYS * DAY_MS) }),
          updatedAt: at,
        };
        await deps.store.saveConversation(next);
        await step(clinicId, patientId, at, {
          kind: 'ladder',
          outcome: 'info',
          event: 'patient_unreachable',
          params: {
            urgent,
            ...(next.retryAt === undefined ? {} : { retryAt: next.retryAt.toISOString() }),
          },
        });
        if (!urgent) {
          await addTask(next, {
            kind: 'doctor_notice',
            priority: 'normal',
            ask: 'patient_unreachable',
            now: at,
            dueInDays: 2,
            rung: rung.id,
          });
        }
        return;
      }
    }
  }

  async function evaluateConversation(conversation: AgentConversation, at: Date): Promise<void> {
    const { clinicId, patientId } = conversation;
    let current = conversation;
    if (
      current.status === 'unreachable' &&
      current.retryAt !== undefined &&
      current.retryAt <= at
    ) {
      current = {
        clinicId: current.clinicId,
        patientId: current.patientId,
        mode: current.mode,
        language: current.language,
        status: 'active',
        phoneStatus: current.phoneStatus,
        orders: current.orders.filter((item) => item.stage !== 'unreachable'),
        ladder: startTrack('routine', at),
        createdAt: current.createdAt,
        updatedAt: at,
      };
      await deps.store.saveConversation(current);
      await step(clinicId, patientId, at, {
        kind: 'ladder',
        outcome: 'info',
        event: 'retry_started',
        params: {},
      });
    }
    if (current.status !== 'active') return;
    const [{ expectations }, appointments, messages] = await Promise.all([
      readPatient(clinicId, patientId),
      deps.store.listAppointments(clinicId, patientId),
      deps.store.listMessages(clinicId, patientId),
    ]);
    if (chasing(orderViews(current, expectations, appointments, at)).length === 0) {
      await deps.store.saveConversation({ ...current, status: 'done', updatedAt: at });
      await step(clinicId, patientId, at, {
        kind: 'ladder',
        outcome: 'ok',
        event: 'all_orders_covered',
        params: {},
      });
      return;
    }
    const lastInbound = messages.findLast((message) => message.direction === 'inbound');
    for (const rung of dueRungs(current.ladder, at, lastInbound?.at)) {
      const fresh = await deps.store.getConversation(clinicId, patientId);
      if (fresh?.status !== 'active' || fresh.ladder.track !== rung.track) return;
      await applyRung(fresh, rung, at);
    }
  }

  async function advanceLadder(clinicId: ClinicId, from: Date, to: Date): Promise<void> {
    if (to.getTime() <= from.getTime()) return;
    let cursor = from.getTime();
    while (cursor < to.getTime()) {
      cursor = Math.min(cursor + DAY_MS, to.getTime());
      const at = new Date(cursor);
      for (const conversation of await deps.store.listConversations(clinicId)) {
        await evaluateConversation(conversation, at);
      }
    }
  }

  function parseDate(value: unknown, field: string): Date {
    const date = typeof value === 'string' ? new Date(value) : undefined;
    if (date === undefined || Number.isNaN(date.getTime())) {
      throw new ValidationError(field, `Invalid ${ORDER_AGENT_LADDER_JOB} payload`);
    }
    return date;
  }

  return {
    async takeOwnership(clinicId, patientId, options) {
      const now = deps.nowOf(clinicId);
      const { expectations } = await readPatient(clinicId, patientId);
      const owned = expectations.filter((item) => isAgentOwned(item) && isPending(item));
      const track = owned.some(isUrgentOrder) ? 'urgent' : 'routine';
      const first = LADDER[track][0];
      const conversation: AgentConversation = {
        clinicId,
        patientId,
        mode: options.mode,
        language: options.language,
        status: 'active',
        phoneStatus: 'ok',
        ladder: startTrack(track, now, { firstDone: true }),
        orders: [],
        createdAt: now,
        updatedAt: now,
      };
      await deps.store.saveConversation(conversation);
      await step(clinicId, patientId, now, {
        kind: 'ladder',
        outcome: 'ok',
        event: 'ownership_taken',
        params: {
          orders: owned.length,
          ignoredEngineItems: expectations.filter((item) => isPending(item) && !isAgentOwned(item))
            .length,
          track,
          mode: options.mode,
        },
      });
      if (options.reviewFirst === true) {
        await runClinicalReview(clinicId, patientId, now, {
          mode: options.mode,
          language: options.language,
          on: 'arrival',
        });
      }
      await enqueueTurn(clinicId, {
        patientId,
        trigger: 'take_ownership',
        ...(first === undefined ? {} : { rung: first.id }),
      });
      return conversation;
    },

    async receiveMessage(clinicId, patientId, input) {
      const now = deps.nowOf(clinicId);
      const conversation = await requireConversation(clinicId, patientId);
      let media: AgentMessage['media'];
      if (input.media !== undefined) {
        const id = deps.newId('agent_media');
        await deps.store.saveMedia({
          id,
          clinicId,
          contentType: input.media.contentType,
          data: input.media.data,
        });
        media = { id, contentType: input.media.contentType, bytes: input.media.data.byteLength };
      }
      const message: AgentMessage = {
        id: deps.newId('agent_message'),
        clinicId,
        patientId,
        direction: 'inbound',
        kind: input.kind,
        text: (input.text ?? '').slice(0, 2_000),
        at: nextMessageAt(await deps.store.listMessages(clinicId, patientId), now),
        ...(media === undefined ? {} : { media }),
      };
      await deps.store.saveMessage(message);
      // A reply proves the phone works again.
      let current = conversation;
      if (current.phoneStatus === 'undelivered') {
        current = {
          ...current,
          phoneStatus: 'ok',
          ladder: startTrack(current.ladder.resumeTrack ?? 'routine', now, { firstDone: true }),
          updatedAt: now,
        };
        await deps.store.saveConversation(current);
      }
      if (input.kind === 'text' && isOptOut(message.text)) {
        const next = { ...current, status: 'opted_out' as const, updatedAt: now };
        await deps.store.saveConversation(next);
        await step(clinicId, patientId, now, {
          kind: 'policy',
          outcome: 'ok',
          event: 'opted_out',
          params: { messageId: message.id },
        });
        await addTask(next, {
          kind: 'call_patient',
          priority: 'normal',
          ask: 'opted_out',
          now,
          dueInDays: 2,
        });
        return message;
      }
      if (current.status === 'unreachable') {
        await deps.store.saveConversation({ ...current, status: 'active', updatedAt: now });
      }
      await step(clinicId, patientId, now, {
        kind: 'ladder',
        outcome: 'info',
        event: 'patient_message_received',
        params: { messageId: message.id, kind: message.kind },
      });
      await enqueueTurn(clinicId, { patientId, trigger: 'inbound_message', messageId: message.id });
      return message;
    },

    async setDeliveryStatus(clinicId, messageId, status) {
      const now = deps.nowOf(clinicId);
      const message = await deps.store.getMessage(clinicId, messageId);
      if (message?.direction !== 'outbound') {
        throw new ValidationError('messageId', 'Only an outbound message has a delivery status');
      }
      const next: AgentMessage = { ...message, deliveryStatus: status, statusAt: now };
      await deps.store.saveMessage(next);
      await step(clinicId, message.patientId, now, {
        kind: 'policy',
        outcome: 'info',
        event: 'delivery_status',
        params: { messageId, status },
      });
      if (status === 'undelivered') {
        const conversation = await requireConversation(clinicId, message.patientId);
        if (conversation.phoneStatus !== 'undelivered') {
          const resumeTrack =
            conversation.ladder.track === 'undelivered'
              ? (conversation.ladder.resumeTrack ?? 'routine')
              : conversation.ladder.track;
          const moved: AgentConversation = {
            ...conversation,
            phoneStatus: 'undelivered',
            ladder: startTrack('undelivered', now, { resumeTrack }),
            updatedAt: now,
          };
          await deps.store.saveConversation(moved);
          await step(clinicId, message.patientId, now, {
            kind: 'ladder',
            outcome: 'info',
            event: 'messaging_stopped_undelivered',
            params: { resumeTrack },
          });
          await evaluateConversation(moved, now);
        }
      }
      return next;
    },

    async fixPhone(clinicId, patientId) {
      const now = deps.nowOf(clinicId);
      const conversation = await requireConversation(clinicId, patientId);
      const track = conversation.ladder.resumeTrack ?? 'routine';
      const next: AgentConversation = {
        ...conversation,
        phoneStatus: 'ok',
        status: conversation.status === 'opted_out' ? 'opted_out' : 'active',
        ladder: startTrack(track, now, { firstDone: true }),
        updatedAt: now,
      };
      await deps.store.saveConversation(next);
      for (const task of await deps.store.listTasks(clinicId, patientId)) {
        if (
          task.status === 'open' &&
          (task.kind === 'update_phone' || task.kind === 'call_other_contact')
        ) {
          await deps.store.saveTask({ ...task, status: 'done' });
        }
      }
      await step(clinicId, patientId, now, {
        kind: 'ladder',
        outcome: 'ok',
        event: 'phone_fixed',
        params: { track },
      });
      const first = LADDER[track][0];
      await enqueueTurn(clinicId, {
        patientId,
        trigger: 'phone_fixed',
        ...(first === undefined ? {} : { rung: first.id }),
      });
      return next;
    },

    async runTurnJob(clinicId, payload) {
      const patientId = payload['patientId'];
      const trigger = payload['trigger'];
      if (typeof patientId !== 'string' || typeof trigger !== 'string') {
        throw new ValidationError('payload', `Invalid ${ORDER_AGENT_TURN_JOB} payload`);
      }
      const messageId = typeof payload['messageId'] === 'string' ? payload['messageId'] : undefined;
      const rung = typeof payload['rung'] === 'string' ? payload['rung'] : undefined;
      await runTurn(clinicId, patientId as PatientId, trigger as AgentRunTrigger, {
        ...(messageId === undefined ? {} : { messageId }),
        ...(rung === undefined ? {} : { rung }),
        now: deps.nowOf(clinicId),
      });
    },

    async runLadderJob(clinicId, payload) {
      await advanceLadder(
        clinicId,
        parseDate(payload['from'], 'from'),
        parseDate(payload['to'], 'to'),
      );
    },

    async scheduleLadder(clinicId, from, to) {
      if (to.getTime() <= from.getTime()) return;
      if ((await deps.store.listConversations(clinicId)).length === 0) return;
      const payload: OrderAgentLadderJobPayload = {
        from: from.toISOString(),
        to: to.toISOString(),
      };
      await deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.jobs.enqueue(clinicId, {
          type: ORDER_AGENT_LADDER_JOB,
          payload: { ...payload },
          maxAttempts: 2,
        }),
      );
    },

    advanceLadder,

    async view(clinicId, patientId) {
      const conversation = await deps.store.getConversation(clinicId, patientId);
      if (conversation === undefined) return undefined;
      const now = deps.nowOf(clinicId);
      const [messages, { expectations }, steps, runs, tasks, appointments, timeZone] =
        await Promise.all([
          deps.store.listMessages(clinicId, patientId),
          readPatient(clinicId, patientId),
          deps.store.listSteps(clinicId, patientId),
          deps.store.listRuns(clinicId, patientId, 50),
          deps.store.listTasks(clinicId, patientId),
          deps.store.listAppointments(clinicId, patientId),
          timeZoneOf(clinicId),
        ]);
      return {
        conversation,
        messages,
        orders: orderViews(conversation, expectations, appointments, now),
        ignoredEngineItems: expectations.filter((item) => isPending(item) && !isAgentOwned(item))
          .length,
        steps,
        runs,
        tasks,
        appointments,
        now,
        timeZone,
      };
    },

    listConversations: (clinicId) => deps.store.listConversations(clinicId),
  };
}

/** The FHIR `Appointment.id` of an agent booking (deterministic: a retry re-sends the same resource). */
export function appointmentFhirId(appointmentId: string): string {
  const id = appointmentId.startsWith('agent-') ? appointmentId : `agent-${appointmentId}`;
  return id.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64);
}

/** Every slot offered so far in a conversation (for tests and the console). */
export function offeredSlotsOf(messages: readonly AgentMessage[]): readonly Slot[] {
  return messages.flatMap((message) => message.offeredSlots ?? []);
}
