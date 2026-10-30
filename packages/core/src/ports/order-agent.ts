import type { z } from 'zod';
import type { ClinicId, ExpectationId, PatientId } from '../domain/ids.ts';
import type {
  AgentAppointment,
  AgentConversation,
  AgentMedia,
  AgentMessage,
  AgentRun,
  AgentStep,
  LabPhotoReading,
  OrderAgentLanguage,
  OrderAgentMode,
  Slot,
  StaffTask,
} from '../domain/order-agent.ts';

/**
 * Ports of the order-to-completion agent (docs/agent/order-to-completion.md).
 * Persistence (`OrderAgentStore`, memory and Postgres adapters), the model
 * loop (`OrderAgentModel`, `@follow-up-engine/llm` on the `llm_gateway`),
 * the multimodal readers (`PatientMediaReader`, same) and the engine-side
 * effects (`OrderAgentEffects`, wired by the runtime over FHIR ingestion).
 */

/** Every call is scoped by `clinicId`; nothing reads across clinics except {@link listConversations}' own clinic. */
export interface OrderAgentStore {
  getConversation(clinicId: ClinicId, patientId: PatientId): Promise<AgentConversation | undefined>;
  saveConversation(conversation: AgentConversation): Promise<void>;
  listConversations(clinicId: ClinicId): Promise<readonly AgentConversation[]>;

  /** Insert or replace by id. */
  saveMessage(message: AgentMessage): Promise<void>;
  getMessage(clinicId: ClinicId, id: string): Promise<AgentMessage | undefined>;
  /** Oldest first. */
  listMessages(clinicId: ClinicId, patientId: PatientId): Promise<readonly AgentMessage[]>;

  saveMedia(media: AgentMedia): Promise<void>;
  getMedia(clinicId: ClinicId, id: string): Promise<AgentMedia | undefined>;

  /** Insert or replace by id. */
  saveRun(run: AgentRun): Promise<void>;
  /** Newest first. */
  listRuns(clinicId: ClinicId, patientId: PatientId, limit: number): Promise<readonly AgentRun[]>;
  /** The run that already answered an inbound message, if any (idempotency). */
  findRunForInbound(clinicId: ClinicId, inboundMessageId: string): Promise<AgentRun | undefined>;

  /** Appends a step; the store assigns `seq` (increasing per clinic). */
  appendStep(step: Omit<AgentStep, 'seq'>): Promise<AgentStep>;
  /** Oldest first; only steps after `afterSeq` when given. */
  listSteps(
    clinicId: ClinicId,
    patientId: PatientId,
    afterSeq?: number,
  ): Promise<readonly AgentStep[]>;

  saveTask(task: StaffTask): Promise<void>;
  /** Newest first. */
  listTasks(clinicId: ClinicId, patientId?: PatientId): Promise<readonly StaffTask[]>;

  /**
   * Stores a booking unless one exists for the same confirmation message
   * (`duplicate`, the existing one returned): one booking per "yes".
   */
  addAppointment(
    appointment: AgentAppointment,
  ): Promise<{ readonly status: 'created' | 'duplicate'; readonly appointment: AgentAppointment }>;
  listAppointments(clinicId: ClinicId, patientId?: PatientId): Promise<readonly AgentAppointment[]>;
}

/** A tool the model may call. Arguments are validated with `parameters` before it runs. */
export interface OrderAgentToolDefinition {
  readonly name: string;
  /** For the model (English, like every prompt). */
  readonly description: string;
  readonly parameters: z.ZodType;
  /** `end_turn`: ends the turn. */
  readonly terminal: boolean;
}

export type OrderAgentToolOutcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string; readonly detail?: unknown };

/** The agent's tools for one turn, over one patient. Every call is traced by the toolbox itself. */
export interface OrderAgentToolbox {
  readonly definitions: readonly OrderAgentToolDefinition[];
  /** Runs a tool with already validated arguments; `reason` is the model's stated reason. */
  execute(name: string, args: unknown, reason: string): Promise<OrderAgentToolOutcome>;
  /** A call the loop refused before running it (unknown tool, invalid arguments). */
  reject(name: string, error: string, detail: string, reason: string): Promise<void>;
}

/** One model call of a turn, for the trace. */
export interface OrderAgentModelCall {
  readonly index: number;
  /** `<provider>:<model>`. */
  readonly model: string;
  readonly thought: string;
  readonly tool: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly repaired: boolean;
}

export interface OrderAgentTurnRequest {
  readonly mode: OrderAgentMode;
  /** What this turn is about (trigger, rung, recent messages): pseudonymous JSON, built by code. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly toolbox: OrderAgentToolbox;
  readonly maxSteps: number;
  /** The patient's names and identifiers: masked in everything sent to the model. */
  readonly redactTerms: readonly string[];
  /** Called after each model call, before its tool runs (the live console shows it at once). */
  onModelCall(call: OrderAgentModelCall): Promise<void>;
}

export interface OrderAgentTurnResult {
  readonly stopReason: 'end_turn' | 'step_limit';
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly model: string;
}

/**
 * The agent's model loop. Throws `LlmBudgetExceededError` when the clinic's
 * budget is spent, and whatever provider error the gateway gives up on.
 */
export interface OrderAgentModel {
  runTurn(clinicId: ClinicId, request: OrderAgentTurnRequest): Promise<OrderAgentTurnResult>;
}

export interface MediaReadingCost {
  /** `<provider>:<model>`. */
  readonly model: string;
  readonly costUsd: number;
  readonly latencyMs: number;
}

/** Voice notes, photos and documents from the patient, read on the `llm_gateway`. */
export interface PatientMediaReader {
  transcribe(
    clinicId: ClinicId,
    input: {
      readonly mode: OrderAgentMode;
      readonly audio: Uint8Array;
      readonly contentType: string;
    },
  ): Promise<MediaReadingCost & { readonly transcript: string; readonly durationMs?: number }>;
  readLabPhoto(
    clinicId: ClinicId,
    input: {
      readonly mode: OrderAgentMode;
      readonly image: Uint8Array;
      readonly contentType: string;
    },
  ): Promise<MediaReadingCost & { readonly reading: LabPhotoReading }>;
  /**
   * A lab report the patient sent as a document (PDF): its text is
   * extracted, masked and read by the same lab-result reading as a photo,
   * into the same {@link LabPhotoReading}.
   */
  readLabDocument(
    clinicId: ClinicId,
    input: {
      readonly mode: OrderAgentMode;
      readonly document: Uint8Array;
      readonly contentType: string;
      /**
       * The patient's names and identifiers: masked in the text before it
       * reaches the model (a photo cannot be masked). A masked mention read
       * back as the printed name is restored by code, for the name check.
       */
      readonly redactTerms?: readonly string[];
    },
  ): Promise<MediaReadingCost & { readonly reading: LabPhotoReading }>;
}

/** What the engine did after the agent's FHIR write. */
export interface EngineOutcome {
  /** The FHIR resource written (`Observation/<id>`, `Appointment/<id>`). */
  readonly resource: string;
  readonly closed: readonly { readonly expectationId: ExpectationId; readonly reason: string }[];
  readonly created: readonly { readonly expectationId: ExpectationId; readonly ruleId: string }[];
}

export interface ResultSubmission {
  readonly patientId: PatientId;
  readonly observationId: string;
  readonly code: { readonly system: string; readonly code: string; readonly display: string };
  readonly value: number;
  readonly unit?: string;
  readonly referenceLow?: number;
  readonly referenceHigh?: number;
  /** HL7 v3 ObservationInterpretation: `H`, `L` or `N`, computed by code from the reference range. */
  readonly interpretation?: 'H' | 'L' | 'N';
  readonly effectiveAt: Date;
  readonly receivedAt: Date;
}

/**
 * The engine side of the agent's actions, wired by the runtime: each goes
 * through the same FHIR ingestion as `POST /fhir`, so the engine alone
 * decides what is fulfilled.
 */
export interface OrderAgentEffects {
  bookVisit(
    clinicId: ClinicId,
    input: {
      readonly patientId: PatientId;
      readonly appointmentId: string;
      readonly slot: Slot;
      readonly bookedAt: Date;
      readonly originCaseId?: string;
    },
  ): Promise<EngineOutcome>;
  submitResult(clinicId: ClinicId, input: ResultSubmission): Promise<EngineOutcome>;
  /** Runs the clinical reviewer on the patient (findings and pre-visit questions for the doctor). */
  requestClinicalReview(
    clinicId: ClinicId,
    patientId: PatientId,
    mode: OrderAgentMode,
    /** Language the findings are written in. */
    language: OrderAgentLanguage,
  ): Promise<{
    readonly runId: string;
    readonly status: string;
    readonly findings: readonly { readonly id: string; readonly category: string }[];
  }>;
}
