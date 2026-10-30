/**
 * Wire types of the rule-authoring routes (docs/agent/rule-authoring.md,
 * `apps/api/src/http/rule-authoring-routes.ts`): a clinic rule the agent
 * drafted from a clinician's words, its dry run, the codes it uses and the
 * agent's trace.
 */

export type RuleAuthoringMode = 'scripted' | 'live';

export interface Bilingual {
  readonly en: string;
  readonly es: string;
}

export interface TerminologyCitationView {
  readonly system: string;
  readonly code: string;
  readonly display: string;
  readonly displayEs?: string;
  readonly catalog: string;
}

export interface DryRunExampleView {
  readonly patientRef: string;
  readonly status: 'open' | 'overdue' | 'closed';
  readonly dueInDays: number;
  readonly overlapsWith: readonly string[];
}

export interface DryRunView {
  readonly asOf: string;
  readonly patientsScanned: number;
  readonly truncated: boolean;
  readonly patientsMatched: number;
  readonly expectations: {
    readonly total: number;
    readonly open: number;
    readonly overdue: number;
    readonly closed: number;
  };
  readonly overlaps: {
    readonly expectations: number;
    readonly patients: number;
    readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
  };
  readonly examples: readonly DryRunExampleView[];
}

export interface AuthoringStepView {
  readonly index: number;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly outcome: string;
  readonly summary: string;
  readonly model?: string;
  readonly costUsd?: number;
}

export interface ProvenanceView {
  readonly mode: RuleAuthoringMode;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
  readonly trace: readonly AuthoringStepView[];
  readonly firstValidationPassed: boolean;
  readonly dryRun: DryRunView;
  readonly terminology: readonly TerminologyCitationView[];
  readonly basedOn?: string;
  readonly rationale?: Bilingual;
  readonly draftedBy: string;
  readonly draftedAt: string;
}

/** A clinic rule or protocol as the engine's config format has it (shown, diffed, described). */
export type DefinitionJson = Readonly<Record<string, unknown>>;

export interface AuthoredRuleView {
  readonly ruleId: string;
  /** `disabled`: enabled once, then switched off. */
  readonly status: 'draft' | 'enabled' | 'disabled';
  readonly live: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly request: string;
  readonly labels: Bilingual;
  readonly kind: 'rule' | 'protocol';
  readonly definition: DefinitionJson;
  /** The existing rule or protocol it adapts (`provenance.basedOn`), for the JSON diff. */
  readonly baseline?: DefinitionJson;
  readonly provenance: ProvenanceView;
  /** Inbox names of the existing rules the dry run found overlapping, in the request's language. */
  readonly ruleLabels: Readonly<Record<string, string>>;
  readonly validatedBy?: string;
  readonly validatedAt?: string;
}

export interface RulesPageView {
  readonly items: readonly AuthoredRuleView[];
  readonly liveAvailable: boolean;
  /** Patients in the evaluator's sandbox clinic (the dry run's records). */
  readonly patients: number;
}

export interface AuthoringRunView {
  readonly stopReason: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly trace: readonly AuthoringStepView[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelId: string;
  readonly promptVersion: string;
}

export type RuleDraftResponse =
  | { readonly status: 'drafted'; readonly rule: AuthoredRuleView; readonly run: AuthoringRunView }
  | {
      readonly status: 'failed';
      readonly reason: 'no_submission' | 'abstained' | 'invalid_submission';
      readonly issues: readonly string[];
      readonly run: AuthoringRunView;
    };

export interface RuleDraftRequest {
  readonly request: string;
  readonly mode: RuleAuthoringMode;
}

export interface RuleDecisionResponse {
  readonly ruleId: string;
  readonly version: number;
  readonly removed?: boolean;
  readonly rule?: AuthoredRuleView;
}
