/**
 * Wire types of the order-to-completion agent's demo routes
 * (`/api/demo/agent/*`, apps/api/src/http/agent-routes.ts). Dates are ISO
 * strings; the page formats them.
 */

export type AgentMode = 'scripted' | 'live';
export type AgentLanguage = 'en' | 'es';
export type AgentDeliveryStatus = 'sent' | 'delivered' | 'read' | 'undelivered';
export type AgentOrderStage =
  'open' | 'contacted' | 'booked' | 'result_received' | 'fulfilled' | 'unreachable';
export type AgentStepKind =
  'model' | 'tool' | 'engine' | 'transcription' | 'vision' | 'guardrail' | 'ladder' | 'policy';
export type TraceValue = string | number | boolean | null | readonly string[];

export interface AgentMessageView {
  readonly id: string;
  readonly direction: 'outbound' | 'inbound';
  readonly kind: 'text' | 'voice' | 'image';
  readonly text: string;
  readonly at: string;
  readonly deliveryStatus?: AgentDeliveryStatus;
  readonly offeredSlots?: readonly { readonly id: string; readonly start: string }[];
  readonly media?: { readonly id: string; readonly contentType: string };
  readonly transcript?: string;
  readonly reading?: {
    readonly isLabReport: boolean;
    readonly tests: readonly {
      readonly name: string;
      readonly value: number;
      readonly unit?: string;
      readonly referenceLow?: number;
      readonly referenceHigh?: number;
    }[];
  };
  readonly rung?: string;
  readonly proactive?: boolean;
}

export interface AgentStepView {
  readonly seq: number;
  readonly at: string;
  readonly kind: AgentStepKind;
  readonly outcome: 'ok' | 'rejected' | 'error' | 'info';
  readonly event: string;
  readonly runId?: string;
  readonly tool?: string;
  readonly arguments?: Readonly<Record<string, TraceValue>>;
  readonly read?: readonly string[];
  readonly reason?: string;
  readonly params?: Readonly<Record<string, TraceValue>>;
  readonly model?: string;
  readonly costUsd?: number;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface AgentOrderView {
  readonly orderId: string;
  readonly kind: 'visit' | 'test';
  readonly test?: string;
  readonly source: 'doctor_note' | 'doctor_order' | 'abnormal_result';
  readonly stage: AgentOrderStage;
  readonly expectationStatus: string;
  readonly dueAt: string;
  readonly urgent: boolean;
  readonly closedBy?: string;
  readonly closedAt?: string;
}

export type StaffTaskAsk =
  | 'book_orders'
  | 'update_phone'
  | 'reach_other_contact'
  | 'patient_unreachable'
  | 'urgent_unanswered'
  | 'patient_question'
  | 'opted_out';

export interface AgentTaskView {
  readonly id: string;
  readonly kind: 'call_patient' | 'update_phone' | 'call_other_contact' | 'doctor_notice';
  readonly priority: 'normal' | 'high';
  readonly status: 'open' | 'done';
  readonly createdAt: string;
  readonly dueAt: string;
  readonly summary: {
    readonly orders: readonly string[];
    readonly outboundCount: number;
    readonly lastOutboundAt?: string;
    readonly lastStatus?: AgentDeliveryStatus;
    readonly replied: boolean;
    readonly ask: StaffTaskAsk;
  };
}

export interface AgentFindingView {
  readonly id: string;
  readonly category: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly summary: string;
  readonly suggestion: string;
  readonly mode: 'shadow' | 'live';
  readonly modelId: string;
  readonly createdAt: string;
}

export interface AgentLadderView {
  readonly track: 'routine' | 'urgent' | 'undelivered';
  readonly anchorAt: string;
  readonly rungs: readonly {
    readonly id: string;
    readonly action: string;
    readonly dueAt: string;
    readonly done: boolean;
  }[];
}

export interface AgentConversationSummary {
  readonly patientId: string;
  readonly mode: AgentMode;
  readonly language: AgentLanguage;
  readonly status: 'active' | 'done' | 'unreachable' | 'opted_out';
  readonly phoneStatus: 'ok' | 'undelivered';
  readonly retryAt?: string;
  readonly flagAtNextContact: boolean;
  readonly createdAt: string;
  readonly busy: boolean;
  readonly ladder: AgentLadderView;
}

export interface AgentPageView {
  readonly now: string;
  readonly liveAvailable: boolean;
  readonly model: string;
  readonly patients: readonly { readonly patientId: string; readonly createdAt: string }[];
  readonly conversation: AgentConversationSummary | null;
  readonly timeZone?: string;
  readonly messages?: readonly AgentMessageView[];
  readonly orders?: readonly AgentOrderView[];
  readonly ignoredEngineItems?: number;
  readonly steps?: readonly AgentStepView[];
  readonly runs?: readonly {
    readonly id: string;
    readonly trigger: string;
    readonly status: string;
    readonly mode: AgentMode;
    readonly model?: string;
    readonly costUsd: number;
    readonly modelCalls: number;
  }[];
  readonly tasks?: readonly AgentTaskView[];
  readonly appointments?: readonly {
    readonly id: string;
    readonly start: string;
    readonly resourceKind: 'professional' | 'lab';
    readonly fhirAppointmentId?: string;
    readonly originCaseId?: string;
  }[];
  readonly findings?: readonly AgentFindingView[];
}

export interface AgentStoryRequest {
  readonly story: 'maria';
  readonly mode: AgentMode;
  readonly language: AgentLanguage;
}
