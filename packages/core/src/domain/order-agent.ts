import type { ClinicId, ExpectationId, PatientId } from './ids.ts';

/**
 * The order-to-completion agent (docs/agent/order-to-completion.md): it owns
 * every order the doctor wrote for a patient (the open expectations the
 * engine created from the doctor's note and orders) until the engine says it
 * is fulfilled. The agent acts (talks to the patient, books, submits a
 * result), the deterministic engine verifies (only the engine marks an
 * expectation fulfilled), the doctor decides.
 *
 * These are the agent's own records: the conversation on a simulated
 * WhatsApp channel, its messages and their delivery status, the trace of
 * every run (each model call, tool call and engine event), staff tasks for
 * reception and the doctor, and the appointments it booked.
 */

/** Who drives the agent's turns: the deterministic scripted player, or a live model. */
export const ORDER_AGENT_MODES = ['scripted', 'live'] as const;
export type OrderAgentMode = (typeof ORDER_AGENT_MODES)[number];

/** Language the agent writes to the patient in (the patient's preferred language). */
export const ORDER_AGENT_LANGUAGES = ['en', 'es'] as const;
export type OrderAgentLanguage = (typeof ORDER_AGENT_LANGUAGES)[number];

export const AGENT_MESSAGE_DIRECTIONS = ['outbound', 'inbound'] as const;
export type AgentMessageDirection = (typeof AGENT_MESSAGE_DIRECTIONS)[number];

/** `document`: a PDF the patient sent (a lab report), read as text by the same lab-result reading as a photo. */
export const AGENT_MESSAGE_KINDS = ['text', 'voice', 'image', 'document'] as const;
export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

/**
 * Delivery of an outbound message, as the (simulated) channel reports it.
 * `undelivered` usually means a wrong number: messaging stops.
 */
export const AGENT_DELIVERY_STATUSES = ['sent', 'delivered', 'read', 'undelivered'] as const;
export type AgentDeliveryStatus = (typeof AGENT_DELIVERY_STATUSES)[number];

/** A slot belongs to the treating professional (visits) or to a lab (tests). */
export const SLOT_RESOURCE_KINDS = ['professional', 'lab'] as const;
export type SlotResourceKind = (typeof SLOT_RESOURCE_KINDS)[number];

/** A bookable slot of the clinic's (synthetic) schedule. Computed by code, never by the model. */
export interface Slot {
  /** Deterministic: the resource and the start instant (`<resource>@<yyyymmddhhmm>`). */
  readonly id: string;
  readonly start: Date;
  readonly end: Date;
  readonly resourceKind: SlotResourceKind;
  /** Key of the resource in the schedule (`professional`, `lab_central`, `lab_north`). */
  readonly resource: string;
  /** Display name of the resource (synthetic). */
  readonly resourceName: string;
  readonly location: string;
}

/** A slot the agent offered in a message, for one order. */
export interface OfferedSlot extends Slot {
  readonly orderId: ExpectationId;
}

/**
 * What the vision model read from a photo of a lab report. Values stay in
 * the agent's records and the FHIR Observation the engine ingests: they are
 * never given back to the conversational model, never sent to the patient.
 */
export interface LabPhotoReading {
  readonly isLabReport: boolean;
  readonly tests: readonly {
    readonly name: string;
    readonly value: number;
    readonly unit?: string;
    readonly referenceLow?: number;
    readonly referenceHigh?: number;
  }[];
  /** `YYYY-MM-DD` as printed on the report. */
  readonly reportDate?: string;
  /** The patient name printed on the report, when any (compared by code, never sent to the model). */
  readonly patientName?: string;
  /**
   * Set when the photo was not read at all: the clinic does not send
   * unmasked images to a model provider (`allowUnmaskedImagesToProvider`).
   * The team reads it; the agent never asks the patient for another one.
   */
  readonly notRead?: 'photo_not_allowed';
}

export interface AgentMessage {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly direction: AgentMessageDirection;
  readonly kind: AgentMessageKind;
  /** The text sent or received; for a voice note, its transcript once read. */
  readonly text: string;
  /** Clinic clock. */
  readonly at: Date;
  /** Outbound only. */
  readonly deliveryStatus?: AgentDeliveryStatus;
  readonly statusAt?: Date;
  /** Outbound: slots this message offered (appended by code). */
  readonly offeredSlots?: readonly OfferedSlot[];
  /** Inbound voice or image: the stored media. */
  readonly media?: { readonly id: string; readonly contentType: string; readonly bytes: number };
  /** Inbound voice: what the transcription model heard. */
  readonly transcript?: string;
  /** Inbound image or document: what the lab-result reading read. */
  readonly reading?: LabPhotoReading;
  /** Outbound: the ladder rung that asked for it (`routine:4`), absent for replies. */
  readonly rung?: string;
  /** The agent run that sent it (outbound). */
  readonly runId?: string;
  /** Outbound: proactive outreach (counts toward the contact cap) rather than a reply. */
  readonly proactive?: boolean;
}

/** Stored bytes of a voice note or a photo. */
export interface AgentMedia {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** The no-response ladder a conversation follows (docs/agent/order-to-completion.md#ladder). */
export const LADDER_TRACKS = ['routine', 'urgent', 'undelivered'] as const;
export type LadderTrack = (typeof LADDER_TRACKS)[number];

export interface LadderState {
  readonly track: LadderTrack;
  /** Rung offsets are counted from here (the first message of the track, or the fix of a phone). */
  readonly anchorAt: Date;
  /** Ids of the rungs already applied on this track. */
  readonly done: readonly string[];
  /** When the track was urgent or routine before the phone failed (to restart it after a fix). */
  readonly resumeTrack?: Exclude<LadderTrack, 'undelivered'>;
}

export const CONVERSATION_STATUSES = ['active', 'done', 'unreachable', 'opted_out'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** What the agent did for an order, as the order list shows it (the engine's fulfilment wins). */
export const AGENT_ORDER_STAGES = [
  'open',
  'contacted',
  'booked',
  'result_received',
  'fulfilled',
  'unreachable',
] as const;
export type AgentOrderStage = (typeof AGENT_ORDER_STAGES)[number];

export interface AgentOrderProgress {
  readonly orderId: ExpectationId;
  readonly stage: Exclude<AgentOrderStage, 'fulfilled'>;
  readonly appointmentId?: string;
  readonly updatedAt: Date;
}

export interface AgentConversation {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly mode: OrderAgentMode;
  readonly language: OrderAgentLanguage;
  readonly status: ConversationStatus;
  /** `undelivered`: the last message did not reach the phone (likely wrong number). */
  readonly phoneStatus: 'ok' | 'undelivered';
  readonly ladder: LadderState;
  readonly orders: readonly AgentOrderProgress[];
  /** Unreachable: when the agent tries again (the order stays open meanwhile). */
  readonly retryAt?: Date;
  /** Urgent track ended unreachable: raise it at the patient's next contact with the clinic. */
  readonly flagAtNextContact?: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const AGENT_RUN_TRIGGERS = [
  'take_ownership',
  'inbound_message',
  'ladder_rung',
  'phone_fixed',
] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

export const AGENT_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export interface AgentRun {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly trigger: AgentRunTrigger;
  readonly status: AgentRunStatus;
  readonly mode: OrderAgentMode;
  /** `<provider>:<model>` of the calls. */
  readonly model?: string;
  /** Inbound message this run answers (idempotency of `inbound_message` runs). */
  readonly inboundMessageId?: string;
  /** Rung this run applies (`ladder_rung`). */
  readonly rung?: string;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** `end_turn`, `step_limit`, `budget_exceeded`, `error`. */
  readonly stopReason?: string;
  readonly error?: string;
}

/**
 * Kinds of trace step: a model call, a tool call, what the engine did, a
 * transcription or vision reading, a guardrail that refused something, a
 * ladder rung, a contact-policy decision.
 */
export const AGENT_STEP_KINDS = [
  'model',
  'tool',
  'engine',
  'transcription',
  'vision',
  'guardrail',
  'ladder',
  'policy',
] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

export const AGENT_STEP_OUTCOMES = ['ok', 'rejected', 'error', 'info'] as const;
export type AgentStepOutcome = (typeof AGENT_STEP_OUTCOMES)[number];

/** Scalar values only: the trace never holds a record, a phone or a result value. */
export type TraceValue = string | number | boolean | null | readonly string[];
export type TraceArgs = Readonly<Record<string, TraceValue>>;

/**
 * One step of the trace (docs/agent/order-to-completion.md#trace). `event`
 * names what happened as a stable code with its parameters, so the console
 * renders it in the reader's language.
 */
export interface AgentStep {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly runId?: string;
  /** Order within the patient's trace. */
  readonly seq: number;
  /** Clinic clock. */
  readonly at: Date;
  readonly kind: AgentStepKind;
  readonly tool?: string;
  /** Sanitized arguments (short strings, numbers, ids). */
  readonly arguments?: TraceArgs;
  /** What the step read (sources), for example `expectations`, `schedule`, `message:<id>`. */
  readonly read?: readonly string[];
  /** The model's stated reason for the call. */
  readonly reason?: string;
  readonly outcome: AgentStepOutcome;
  readonly event: string;
  readonly params?: TraceArgs;
  readonly model?: string;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Work for people: reception calls, phone updates, notices to the doctor. */
export const STAFF_TASK_KINDS = [
  'call_patient',
  'update_phone',
  'call_other_contact',
  'doctor_notice',
] as const;
export type StaffTaskKind = (typeof STAFF_TASK_KINDS)[number];

export const STAFF_TASK_PRIORITIES = ['normal', 'high'] as const;
export type StaffTaskPriority = (typeof STAFF_TASK_PRIORITIES)[number];

/** Why the task exists (the third line of its summary). */
export const STAFF_TASK_ASKS = [
  'book_orders',
  'update_phone',
  'reach_other_contact',
  'patient_unreachable',
  'urgent_unanswered',
  'patient_question',
  'opted_out',
  /** A lab report photo the clinic does not send to a model: read it and enter the result. */
  'review_photo',
] as const;
export type StaffTaskAsk = (typeof STAFF_TASK_ASKS)[number];

/** A three-line summary, structured so the inbox renders it in the reader's language. */
export interface StaffTaskSummary {
  /** Line 1: the open orders (test names, or `visit`). */
  readonly orders: readonly string[];
  /** Line 2: outreach so far. */
  readonly outboundCount: number;
  readonly lastOutboundAt?: Date;
  readonly lastStatus?: AgentDeliveryStatus;
  readonly replied: boolean;
  /** Line 3: what to do. */
  readonly ask: StaffTaskAsk;
}

export interface StaffTask {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly kind: StaffTaskKind;
  readonly priority: StaffTaskPriority;
  readonly summary: StaffTaskSummary;
  readonly status: 'open' | 'done';
  /** The rung that created it, when any. */
  readonly rung?: string;
  readonly createdAt: Date;
  readonly dueAt: Date;
}

/** An appointment the agent booked, on the patient's explicit confirmation. */
export interface AgentAppointment {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly orderId: ExpectationId;
  readonly slot: Slot;
  /** The inbound message that confirmed it: one booking per confirmation (idempotency). */
  readonly confirmationMessageId: string;
  readonly bookedAt: Date;
  /** The FHIR `Appointment` ingested into the engine (visits only). */
  readonly fhirAppointmentId?: string;
  /** The case `Task` the booking answers (`follow-up-origin-case` extension). */
  readonly originCaseId?: string;
}
