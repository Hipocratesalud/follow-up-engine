import type { RuleId, Specialty } from '../constants.ts';
import type { TransactionBundle } from '../synthetic/fhir-builders.ts';

/**
 * The extraction the fake LLM provider must return for one note, in the
 * shape of core's `NoteExtraction`, serialized as JSON (`dueAt` is an ISO
 * instant resolved against the note's `authoredAt`).
 */
export interface LlmFixtureExtraction {
  readonly hasPlan: boolean;
  readonly conditions: readonly {
    readonly code: { readonly system: string; readonly code: string; readonly display?: string };
    readonly confidence: number;
    readonly evidenceQuote: string;
  }[];
  readonly medications: readonly {
    readonly text: string;
    readonly code?: { readonly system: string; readonly code: string; readonly display?: string };
    readonly durationDays?: number;
    readonly evidenceQuote: string;
  }[];
  readonly planItems: readonly {
    readonly kind: 'follow_up_visit' | 'lab' | 'imaging' | 'session' | 'other';
    readonly description: string;
    readonly dueAt: string;
    readonly evidenceQuote: string;
    readonly confidence: number;
    readonly code?: { readonly system: string; readonly code: string; readonly display?: string };
  }[];
  readonly model: string;
  readonly promptVersion: string;
  readonly costUsd: number;
}

/** One expectation the engine must hold. Optional fields are only compared when present. */
export interface ExpectationAssertion {
  readonly ruleId: RuleId;
  /** `<system-short>:<code>`, for example `loinc:4548-4`. */
  readonly matchKey?: string;
  /** Whole days from the base date to `dueAt` (compare at day granularity). */
  readonly dueDay?: number;
}

export interface ClosedExpectationAssertion extends ExpectationAssertion {
  readonly status: 'fulfilled' | 'superseded' | 'expired' | 'cancelled';
}

export interface CaseAssertion {
  /** Rule ids of the case's expectations; the case must include all of them. */
  readonly reasons: readonly RuleId[];
  readonly resolution?:
    'fulfilled' | 'handled_outside' | 'not_needed' | 'patient_declined' | 'patient_unreachable';
}

/**
 * What must hold for the scenario's patient at the end of `day`: after every
 * step with `step.day <= day` was ingested, the clock moved to
 * `BASE_DATE + day` and the watcher ran.
 *
 * Semantics (so that new protocol items do not break old scenarios):
 * - `openExpectations` + `absentRuleIds`: for every rule id that appears in
 *   either, the patient's open expectations of that rule are exactly the
 *   listed ones (order-insensitive). Rules not mentioned are unconstrained.
 * - `activeCases`: the exact number of active cases; each listed case's
 *   reasons must include the listed rule ids.
 * - `resolvedCases`, `closedExpectations`: must be present (contains).
 * - `qualityFindings`: exact list of finding kinds for the patient.
 */
export interface ScenarioCheckpoint {
  readonly day: number;
  readonly openExpectations?: readonly ExpectationAssertion[];
  readonly absentRuleIds?: readonly RuleId[];
  readonly closedExpectations?: readonly ClosedExpectationAssertion[];
  readonly activeCases?: readonly CaseAssertion[];
  readonly resolvedCases?: readonly CaseAssertion[];
  readonly qualityFindings?: readonly 'note_without_plan'[];
}

export interface ScenarioStep {
  /** Days after the base date; the bundle is ingested at `BASE_DATE + day`. */
  readonly day: number;
  readonly bundle: TransactionBundle;
}

/** A PRD acceptance case, replayable against the engine with a fake clock and fake LLM. */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly clinicId: string;
  readonly patientId: string;
  readonly specialty: Specialty;
  readonly steps: readonly ScenarioStep[];
  /** Extraction per DocumentReference id, for the fake LLM provider. */
  readonly llmFixture: Readonly<Record<string, LlmFixtureExtraction>>;
  readonly expect: readonly ScenarioCheckpoint[];
}
