import type { ClinicId, PatientId } from './ids.ts';
import type { ResourceRef } from './resource.ts';

/**
 * What the clinical reviewer can point out (PRD V3 "Findings catalog").
 * Each category is a flag per clinic and specialty ({@link FindingFlag}).
 * `similar_patients` is reserved: it needs cross-clinic data and validation,
 * and is never produced in V3.
 */
export const FINDING_CATEGORIES = [
  'pre_visit_question',
  'lab_trend',
  'vital_trend',
  'abnormal_result_no_followup',
  'drug_interaction',
  'drug_condition_conflict',
  'unaddressed_symptom',
  'missing_screening',
  'record_quality',
  'utilization_change',
  'similar_patients',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Categories the reviewer implements; `similar_patients` is reserved. */
export const IMPLEMENTED_FINDING_CATEGORIES = FINDING_CATEGORIES.filter(
  (category) => category !== 'similar_patients',
);

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * `shadow`: stored and reviewed in batches by the clinical team, never shown
 * to doctors, never sent to the host. `live`: a validated category, shown to
 * doctors and exported to the host.
 */
export const FINDING_MODES = ['shadow', 'live'] as const;
export type FindingMode = (typeof FINDING_MODES)[number];

/** The clinician's verdict on a finding (the precision metric of the shadow review). */
export const FINDING_VERDICTS = ['relevant', 'already_known', 'not_relevant'] as const;
export type FindingVerdict = (typeof FINDING_VERDICTS)[number];

export const FINDING_STATUSES = ['open', ...FINDING_VERDICTS, 'expired'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** What kind of record a citation points at. */
export const CITATION_KINDS = ['note', 'result', 'medication', 'condition'] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

/**
 * A verbatim quote from one of the patient's documents. `quote` was checked
 * against the stored text of `source` before the finding was stored (a
 * finding whose quote is not in the document is discarded, never stored).
 * For a result, medication or condition the "text" is the canonical line the
 * engine renders from the structured record (`Creatinina: 1.7 mg/dL`).
 */
export interface FindingCitation {
  readonly source: ResourceRef;
  readonly kind: CitationKind;
  readonly quote: string;
  /** When the cited fact happened (note authored, result collected, drug prescribed). */
  readonly occurredAt: Date;
}

/**
 * How a finding was produced: a deterministic detector signal the agent
 * confirmed (`confirmed`), one the agent added on its own (`added`), or a
 * detector signal stored as is because the agent could not run (`fallback`).
 */
export const FINDING_ORIGINS = ['confirmed', 'added', 'fallback'] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

/** An open expectation or active case that already deals with what the finding says. */
export interface FindingCoverage {
  readonly kind: 'expectation' | 'case';
  readonly id: string;
  /** Rule or reason code (`abnormal_result_followup`, `protocol_diabetes_fundus`). */
  readonly code: string;
}

/** A finding's words in one language: what the clinician reads. */
export interface FindingText {
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
}

/**
 * A finding's words in each review locale it was written in. The deterministic
 * detectors render every locale from the same templates; the reviewing model
 * returns both languages. The inbox shows the viewer's language; quotes are
 * never translated (they stay the record's own words).
 */
export type FindingTexts = Readonly<Partial<Record<ReviewLocale, FindingText>>>;

/**
 * When a live finding reached the doctor's inbox, and whose daily quota it
 * took (the patient's owner, or `unassigned`). Findings over a doctor's
 * daily cap wait without one (PRD V3: cap per doctor per day).
 */
export interface FindingInboxRelease {
  readonly at: Date;
  readonly doctor: string;
}

export interface FindingReview {
  readonly verdict: FindingVerdict;
  readonly reason?: string;
  readonly reviewedBy: string;
  readonly reviewedAt: Date;
}

/**
 * What the clinical reviewer saw in a patient's record: a suggestion to the
 * clinician with cited evidence, never a decision and never a message to
 * the patient (PRD V3). Exposed as a FHIR `DetectedIssue`.
 */
export interface ClinicalFinding {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  /** One line, Spanish (clinic UI copy). */
  readonly summary: string;
  /** Why it matters, Spanish. */
  readonly rationale: string;
  /** What to consider reviewing, Spanish. Never addressed to the patient. */
  readonly suggestion: string;
  /** At least one, each checked verbatim against its document. */
  readonly citations: readonly FindingCitation[];
  /** Computed by code against the open expectations and active cases; the model cannot set it. */
  readonly alreadyCovered: boolean;
  readonly coveredBy: readonly FindingCoverage[];
  /**
   * The words in every locale available (`summary`, `rationale` and
   * `suggestion` above are the clinic's locale). Absent on findings stored
   * before it existed: readers fall back to the fields above.
   */
  readonly texts?: FindingTexts;
  /** Set when the finding was released to the doctor's inbox (daily cap per doctor). */
  readonly inboxRelease?: FindingInboxRelease;
  /** Specialty of the record the finding rests on (for per-specialty flags), when known. */
  readonly specialty?: string;
  readonly mode: FindingMode;
  readonly status: FindingStatus;
  readonly origin: FindingOrigin;
  /** Same category and same main citations: the 90-day deduplication key. */
  readonly dedupKey: string;
  readonly runId: string;
  /** `<provider>:<model>` that confirmed or proposed it (`detector` for a fallback). */
  readonly modelId: string;
  readonly promptVersion: string;
  readonly review?: FindingReview;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Language the reviewer writes findings in (the clinic's locale). Quotes
 * stay verbatim, in the language of the record.
 */
export const REVIEW_LOCALES = ['en', 'es'] as const;
export type ReviewLocale = (typeof REVIEW_LOCALES)[number];
export const DEFAULT_REVIEW_LOCALE: ReviewLocale = 'en';

/** Why the reviewer looked at a patient. */
export const REVIEW_TRIGGERS = [
  'result.received',
  'note.received',
  'medication.prescribed',
  'stale_high_priority',
  'manual',
  'initial',
] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

/**
 * `completed`: the agent submitted its findings. `degraded`: the agent could
 * not finish (budget, provider down, step limit) and the detector signals
 * were stored as is. `skipped`: no enabled category for the patient.
 * `failed`: nothing could be stored.
 */
export const REVIEW_RUN_STATUSES = ['completed', 'degraded', 'skipped', 'failed'] as const;
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

/** Why a proposed finding was not stored. */
export const DISCARD_REASONS = [
  'no_citation',
  'unknown_document',
  'quote_not_found',
  'quote_too_short',
  'category_disabled',
  'category_reserved',
  'patient_directed',
  'duplicate',
  'merged',
] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

/** One tool call (or the final submission) of the agent, for the audit trail. Ids only, no note text. */
export interface ReviewStep {
  readonly index: number;
  readonly tool: string;
  /** Validated arguments (test names, document handles, drug names), never note text. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** `ok`, or why the call was rejected (`invalid_arguments`, `unknown_tool`, `tool_budget_exhausted`). */
  readonly outcome: string;
  /** A short machine summary of the result (`3 points`, `found: high`). */
  readonly summary: string;
}

/** One review of one patient: what it cost and what it kept (PRD `clinical_review_runs`). */
export interface ClinicalReviewRun {
  readonly id: string;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly trigger: ReviewTrigger;
  readonly status: ReviewRunStatus;
  /** Deterministic detector signals offered to the agent. */
  readonly signalsCount: number;
  /** Findings stored by this run. */
  readonly findingsCount: number;
  /** Proposals dropped by validation (no citation, quote not found, disabled category...). */
  readonly discardedCount: number;
  /** Proposals that repeated a finding open or reviewed in the last 90 days. */
  readonly duplicateCount: number;
  readonly discarded: readonly { readonly reason: DiscardReason; readonly count: number }[];
  /** Model calls (each one returns a tool call or the submission). */
  readonly steps: number;
  /** Read-only tool calls executed. */
  readonly toolCalls: number;
  readonly trace: readonly ReviewStep[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly modelId: string;
  readonly promptVersion: string;
  /** Why the agent stopped: `submitted`, `step_limit`, `token_budget`, `llm_budget`, `error`. */
  readonly stopReason: string;
  readonly error?: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

/**
 * A finding category for a clinic, optionally for one specialty (PRD
 * `finding_flags`). Every category starts `enabled: false, mode: 'shadow'`;
 * it goes `live` only with `validatedBy` recorded (the clinical team's
 * sign-off after the shadow review).
 */
export interface FindingFlag {
  readonly clinicId: ClinicId;
  readonly category: FindingCategory;
  /** `undefined`: every specialty. A specialty's own flag wins over the clinic-wide one. */
  readonly specialty?: string;
  readonly enabled: boolean;
  readonly mode: FindingMode;
  readonly validatedBy?: string;
  readonly validatedAt?: Date;
  readonly updatedBy?: string;
  readonly updatedAt: Date;
}

/**
 * A finding's words in `locale`: its own rendering in that language when it
 * has one, else the stored (clinic-locale) text.
 */
export function findingTextIn(
  finding: Pick<ClinicalFinding, 'summary' | 'rationale' | 'suggestion' | 'texts'>,
  locale: string,
): FindingText {
  const own = (REVIEW_LOCALES as readonly string[]).includes(locale)
    ? finding.texts?.[locale as ReviewLocale]
    : undefined;
  return (
    own ?? {
      summary: finding.summary,
      rationale: finding.rationale,
      suggestion: finding.suggestion,
    }
  );
}
