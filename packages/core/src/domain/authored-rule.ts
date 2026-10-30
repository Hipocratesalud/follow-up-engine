import type { Protocol } from '../config/protocol.ts';
import type { Rule } from '../config/rule.ts';

/**
 * A rule a clinic wrote for itself in plain words ("TSH every 6 months for my
 * hypothyroid patients on levothyroxine"), drafted by the rule-authoring
 * agent (docs/agent/rule-authoring.md) in the engine's own config format and
 * stored as a per-clinic rule override (`RuleOverride.authored`), versioned
 * and audited like any other override.
 *
 * `draft`: never runs, whatever else happens. `enabled`: a clinician
 * enabled it for the clinic (`validatedBy`, `validatedAt`); it then drafts
 * expectations for new events like any validated rule.
 */
export const AUTHORED_RULE_STATUSES = ['draft', 'enabled'] as const;
export type AuthoredRuleStatus = (typeof AUTHORED_RULE_STATUSES)[number];

/** Prefix of every clinic-authored rule or protocol id: never collides with config/rules or config/protocols. */
export const AUTHORED_ID_PREFIX = 'clinic_';

/**
 * What the clinic's rule is, in the engine's config format: a rule
 * (`config/rules`, a trigger and what fulfills it) or a protocol
 * (`config/protocols`, a cadence for patients with a condition).
 */
export type AuthoredDefinition =
  | { readonly kind: 'rule'; readonly rule: Rule }
  | { readonly kind: 'protocol'; readonly protocol: Protocol };

/** A terminology code the draft uses, and the repository catalog that knows it. */
export interface TerminologyCitation {
  /** `icd10`, `loinc`, `atc` or `procedure`. */
  readonly system: string;
  readonly code: string;
  readonly display: string;
  /** Spanish display, when the catalog has one (ICD-10 categories, some tests). */
  readonly displayEs?: string;
  /** The catalog it was found in (`condition-terms`, `test-names`, `atc-names`). */
  readonly catalog: string;
}

/** One pseudonymous patient of a dry run: a stable handle, never a name or a host id. */
export interface DryRunExample {
  /** `P-3f2a9c`: a hash of the patient id, stable within the clinic. */
  readonly patientRef: string;
  /** `open` (on time), `overdue` (would open a case now) or `closed` (already fulfilled or replaced). */
  readonly status: 'open' | 'overdue' | 'closed';
  /** Days from the dry run's "now" to the due date (negative when overdue). */
  readonly dueInDays: number;
  /** Ids of the existing rules or protocol items that already ask for the same thing. */
  readonly overlapsWith: readonly string[];
}

/**
 * What a draft would do to the clinic's current records: the real engine
 * replays every patient's stored events with the draft added, in a
 * transaction that is always rolled back, and counts what the draft's
 * definition created. Nothing is written.
 */
export interface RuleDryRunReport {
  /** The instant the replay counted up to (ISO 8601). */
  readonly asOf: string;
  readonly patientsScanned: number;
  /** More patients than the dry run's limit: only the first `patientsScanned` were replayed. */
  readonly truncated: boolean;
  /** Patients the draft would create at least one expectation for. */
  readonly patientsMatched: number;
  readonly expectations: {
    readonly total: number;
    /** Live, not due yet. */
    readonly open: number;
    /** Live and past due: each one opens (or joins) a case right away. */
    readonly overdue: number;
    /** Already fulfilled, replaced or closed by the patient's later records. */
    readonly closed: number;
  };
  /** Live draft expectations that an existing rule's live expectation already asks for. */
  readonly overlaps: {
    readonly expectations: number;
    readonly patients: number;
    readonly byRule: readonly { readonly ruleId: string; readonly count: number }[];
  };
  /** A few pseudonymous patients, overdue first. */
  readonly examples: readonly DryRunExample[];
}

/** One step of the authoring agent, for the audit trail: ids and codes only. */
export interface AuthoringStep {
  readonly index: number;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** `ok`, or why the call was rejected (`invalid_arguments`, `unknown_tool`, `tool_budget_exhausted`). */
  readonly outcome: string;
  readonly summary: string;
  /** `<provider>:<model>` that answered the step. */
  readonly model?: string;
  readonly costUsd?: number;
}

/** How the draft was produced: by whom, with which model, at what cost, through which steps. */
export interface AuthoringProvenance {
  readonly mode: 'scripted' | 'live';
  /** `<provider>:<model>`. */
  readonly modelId: string;
  readonly promptVersion: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Model calls. */
  readonly steps: number;
  readonly trace: readonly AuthoringStep[];
  /** Whether the agent's first `validate_rule` call already passed. */
  readonly firstValidationPassed: boolean;
  /** The engine's own dry run of the submitted draft (not the agent's claim). */
  readonly dryRun: RuleDryRunReport;
  readonly terminology: readonly TerminologyCitation[];
  /** The existing rule or protocol the draft adapts, when it adapts one. */
  readonly basedOn?: string;
  /** The agent's one-line rationale for the clinician, in both UI languages. */
  readonly rationale?: { readonly en: string; readonly es: string };
  /** Who asked for the draft. */
  readonly draftedBy: string;
  /** ISO 8601. */
  readonly draftedAt: string;
}

/** A clinic-authored rule as stored in its override. */
export interface AuthoredRule {
  readonly status: AuthoredRuleStatus;
  readonly definition: AuthoredDefinition;
  /** The clinician's request, verbatim. */
  readonly request: string;
  /** The inbox reason label, in both UI languages. */
  readonly labels: { readonly en: string; readonly es: string };
  readonly provenance: AuthoringProvenance;
  /** The clinician who enabled it for the clinic. */
  readonly validatedBy?: string;
  /** When it was enabled (ISO 8601). */
  readonly validatedAt?: string;
}

/** The id of an authored definition (its rule id or protocol id). */
export function authoredDefinitionId(definition: AuthoredDefinition): string {
  return definition.kind === 'rule' ? definition.rule.id : definition.protocol.id;
}
