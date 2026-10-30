import type { z } from 'zod';
import type { AuthoringStep } from '../domain/authored-rule.ts';
import type { ClinicId } from '../domain/ids.ts';

/** Code systems a clinic-authored rule may use. */
export const TERMINOLOGY_SYSTEMS = ['icd10', 'loinc', 'atc', 'procedure'] as const;
export type TerminologySystem = (typeof TERMINOLOGY_SYSTEMS)[number];

/** One code of the repository's catalogs. */
export interface TerminologyEntry {
  readonly system: TerminologySystem;
  /** The code (`E03`, `3016-3`, `H03AA01`, `fundus-exam`); for ICD-10 the 3-character category. */
  readonly code: string;
  /** English display (`Hypothyroidism`, `TSH`, `levothyroxine`). */
  readonly display: string;
  /** The catalog it comes from (`condition-terms`, `test-names`, `atc-names`). */
  readonly catalog: string;
  /** Test entries: `lab` or `imaging`; and the test group (`thyroid`), whose codes are equivalent. */
  readonly testKind?: 'lab' | 'imaging';
  readonly group?: string;
  /** The FHIR system URI a filter or an item code uses (`http://loinc.org`). */
  readonly systemUri?: string;
  /** A few words the catalog knows the code by (Spanish and English). */
  readonly terms: readonly string[];
}

/**
 * The repository's terminology catalogs, read only: ICD-10 categories
 * (the note extractor's condition terms), LOINC test groups (the engine's
 * test lexicon) and ATC drugs (the engine's medication name table). A
 * clinic-authored rule may only use codes these know.
 */
export interface RuleTerminology {
  /** Entries whose code, display or terms match `query` (case and accents ignored), best first. */
  search(
    query: string,
    options?: { readonly system?: TerminologySystem; readonly limit?: number },
  ): readonly TerminologyEntry[];
  /**
   * The entry of an exact code. ICD-10: a known category or any code under
   * it (`E03.9` is `E03`). ATC: a known drug or a class prefix of one
   * (`H03AA` names levothyroxine's class).
   */
  find(system: TerminologySystem, code: string): TerminologyEntry | undefined;
}

/** A tool the authoring agent may call. Arguments are validated with `parameters` before it runs. */
export interface AuthoringToolDefinition {
  readonly name: string;
  /** For the model (English, like every prompt). */
  readonly description: string;
  readonly parameters: z.ZodType;
  /** `submit_draft` and `abstain`: end the run. */
  readonly terminal: boolean;
}

/** The result of one tool call: JSON for the model, plus a short summary for the audit trail. */
export type AuthoringToolExecution =
  | { readonly ok: true; readonly result: unknown; readonly summary: string }
  | { readonly ok: false; readonly error: string };

/**
 * The authoring agent's tools over one clinic: its existing rules, the
 * terminology catalogs, the validator and the dry run. None writes; the
 * dry run's transaction is always rolled back.
 */
export interface AuthoringToolbox {
  readonly definitions: readonly AuthoringToolDefinition[];
  /** Runs a non-terminal tool with already validated arguments. */
  execute(name: string, args: unknown): Promise<AuthoringToolExecution>;
}

/** How far one authoring run may go. */
export interface AuthoringLimits {
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTokens: number;
}

export const DEFAULT_AUTHORING_LIMITS: AuthoringLimits = {
  maxSteps: 12,
  maxToolCalls: 10,
  maxTokens: 120_000,
};

export interface AuthoringAgentRequest {
  /** The clinician's words, verbatim (any language). */
  readonly request: string;
  readonly toolbox: AuthoringToolbox;
  readonly limits: AuthoringLimits;
}

/**
 * `submitted`: the agent called `submit_draft`. `abstained`: it declined
 * (`abstain`: not a follow-up rule, or no codes for it). Otherwise it ran
 * out first.
 */
export type AuthoringStopReason = 'submitted' | 'abstained' | 'step_limit' | 'token_budget';

export interface AuthoringAgentResult {
  /** The `submit_draft` arguments, untrusted until the engine validated them. */
  readonly submission?: unknown;
  /** Why the agent abstained (`abstain`), as it wrote it. */
  readonly abstention?: string;
  readonly stopReason: AuthoringStopReason;
  readonly steps: number;
  readonly toolCalls: number;
  readonly trace: readonly AuthoringStep[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** `<provider>:<model>` of the calls. */
  readonly modelId: string;
  readonly promptVersion: string;
}

/**
 * The rule-authoring agent: turns a clinician's sentence into a draft in
 * the engine's config format through tools. Throws `LlmBudgetExceededError`
 * when the clinic's LLM budget is spent.
 */
export interface RuleAuthoringAgent {
  author(clinicId: ClinicId, request: AuthoringAgentRequest): Promise<AuthoringAgentResult>;
}
