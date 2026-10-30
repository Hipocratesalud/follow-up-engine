import type { z } from 'zod';
import type { FindingTexts, ReviewLocale, ReviewStep } from '../domain/clinical-finding.ts';
import type { ClinicId } from '../domain/ids.ts';

/**
 * The clinical reviewer's agent port: an LLM that reads a patient's
 * structured summary, may call read-only tools over the record, and submits
 * proposed findings. Implemented in `@follow-up-engine/llm` on the
 * `llm_gateway` (a real Meta model, or a deterministic scripted agent in CI).
 * Everything it returns is untrusted: the engine checks every citation
 * verbatim, decides coverage itself and drops whatever does not pass.
 */

/** The PRD's `ReviewInput`: pseudonymous, document handles only, trends computed by code. */
export interface ReviewInput {
  /** A per-review pseudonym: never the name, phone, document number or host id. */
  readonly patientRef: string;
  readonly asOf: string;
  readonly ageYears?: number;
  readonly sex?: string;
  readonly conditions: readonly ConditionEntryView[];
  readonly medications: readonly MedicationView[];
  readonly labTrends: readonly TrendView[];
  readonly vitals: readonly TrendView[];
  readonly recentNotes: readonly NoteView[];
  readonly openExpectations: readonly {
    readonly ruleId: string;
    readonly label: string;
    readonly dueAt: string;
    readonly status: string;
  }[];
  readonly openCases: readonly { readonly reasons: readonly string[]; readonly status: string }[];
  /** What the deterministic detectors found, each with its evidence. */
  readonly signals: readonly SignalView[];
}

export interface ConditionEntryView {
  readonly docId?: string;
  readonly code: string;
  readonly display: string;
  readonly status: string;
}

export interface MedicationView {
  readonly docId: string;
  readonly name: string;
  readonly dose?: string;
  readonly since: string;
  readonly atc?: string;
  readonly active: boolean;
}

export interface TrendView {
  readonly test: string;
  readonly label: string;
  readonly unit: string;
  readonly values: readonly {
    readonly docId: string;
    readonly date: string;
    readonly value: number;
  }[];
  readonly low?: number;
  readonly high?: number;
  readonly changePct: number;
  readonly slopePerYear: number;
  readonly consecutiveWorsening: number;
  readonly latestOutOfRange: boolean;
}

export interface NoteView {
  readonly docId: string;
  readonly date: string;
  readonly specialty?: string;
  readonly text: string;
}

/** What a signal is about, so the agent knows which tool confirms it. */
export interface SignalTopic {
  readonly test?: string;
  readonly drugs?: readonly string[];
  readonly symptom?: string;
}

export interface SignalView {
  readonly id: string;
  readonly category: string;
  readonly severity: string;
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
  readonly evidence: readonly { readonly docId: string; readonly quote: string }[];
  readonly topic?: SignalTopic;
  /** The same summary, rationale and suggestion in every review locale (`en`, `es`). */
  readonly texts?: FindingTexts;
}

/** A tool the agent may call. Arguments are validated with `parameters` before it runs. */
export interface ReviewToolDefinition {
  readonly name: string;
  /** For the model (English, like every prompt). */
  readonly description: string;
  readonly parameters: z.ZodType;
  /** `submit_findings`: ends the review. */
  readonly terminal: boolean;
}

/** The result of one tool call: JSON for the model, plus a short summary for the audit trail. */
export type ToolExecution =
  | { readonly ok: true; readonly result: unknown; readonly summary: string }
  | { readonly ok: false; readonly error: string };

/**
 * Read-only tools over one patient's record. They never write, never reach
 * another patient and never return host ids (only document handles).
 */
export interface ReviewToolbox {
  readonly definitions: readonly ReviewToolDefinition[];
  /** Runs a non-terminal tool with already validated arguments. */
  execute(name: string, args: unknown): ToolExecution;
}

/** A finding as the agent proposes it. Untrusted until the engine validated it. */
export interface ProposedFinding {
  readonly category: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
  readonly citations: readonly { readonly docId: string; readonly quote: string }[];
  /** Detector signals this finding confirms or merges (`S1`); empty for a finding of its own. */
  readonly signalIds: readonly string[];
  /** Summary, rationale and suggestion in each review locale (`en`, `es`), when given. */
  readonly texts?: FindingTexts;
}

/** How far one review may go. */
export interface ReviewLimits {
  /** Model calls (each returns one tool call or the submission). */
  readonly maxSteps: number;
  /** Read-only tool calls; past it, the agent is told to submit. */
  readonly maxToolCalls: number;
  /** Input plus output tokens over the whole review. */
  readonly maxTokens: number;
}

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
  maxSteps: 8,
  maxToolCalls: 6,
  maxTokens: 60_000,
};

export interface ReviewAgentRequest {
  readonly input: ReviewInput;
  readonly toolbox: ReviewToolbox;
  readonly limits: ReviewLimits;
  /** The patient's names and identifiers: masked in everything sent to the model. */
  readonly redactTerms: readonly string[];
  /** Text of every citable document by handle, to map quotes back from masked text. */
  readonly documents: ReadonlyMap<string, string>;
  /** Language the findings are written in (quotes stay verbatim). */
  readonly locale: ReviewLocale;
}

/**
 * `submitted`: the agent called `submit_findings`. `step_limit` and
 * `token_budget`: it ran out before submitting (the engine then stores the
 * detector signals as they are).
 */
export type ReviewStopReason = 'submitted' | 'step_limit' | 'token_budget';

export interface ReviewAgentResult {
  readonly proposals: readonly ProposedFinding[];
  readonly stopReason: ReviewStopReason;
  readonly steps: number;
  readonly toolCalls: number;
  readonly trace: readonly ReviewStep[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** `<provider>:<model>` of the calls. */
  readonly modelId: string;
  readonly promptVersion: string;
}

/**
 * The reviewing agent. Throws `LlmBudgetExceededError` when the clinic's LLM
 * budget is spent and any provider error the gateway gives up on; the
 * engine then falls back to the detector signals (never blocks).
 */
export interface ClinicalReviewAgent {
  review(clinicId: ClinicId, request: ReviewAgentRequest): Promise<ReviewAgentResult>;
}
