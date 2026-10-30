/**
 * The clinical reviewer (PRD V3): deterministic detectors over a patient's
 * structured record, an LLM agent with read-only tools that confirms,
 * discards, merges or adds findings, and code that checks every citation
 * verbatim and decides coverage. See docs/reviewer.md.
 */
export {
  buildDossier,
  type CitableDocument,
  type MedicationEntry,
  type NoteDocument,
  type ObservationComponent,
  type PatientRecordSnapshot,
  type ReviewDossier,
  reviewInputOf,
} from './dossier.ts';
export { detectSignals, type Signal, signalView } from './detectors.ts';
export {
  anyEnabled,
  applyFlagUpdate,
  categoryGate,
  type FlagUpdate,
  INBOX_EXCLUDED_CATEGORIES,
  inboxCategories,
  inInbox,
  modeOf,
  resolveFlag,
  shadowPilotFlags,
} from './flags.ts';
export {
  DRUG_CLASSES,
  DRUG_CONDITION_RULES,
  findMeasurement,
  INTERACTION_RULES,
  MEASUREMENTS,
  type MeasurementDefinition,
  SCREENING_RULES,
  SYMPTOMS,
} from './knowledge.ts';
export { coverageOf } from './coverage.ts';
export {
  type CategoryGate,
  reviewRecord,
  type ReviewedFinding,
  type ReviewOptions,
  type ReviewOutcome,
  withLocaleTexts,
} from './pipeline.ts';
export {
  CLINICAL_REVIEW_JOB,
  CLINICAL_REVIEW_PROMPT_FALLBACK,
  clinicDay,
  DEFAULT_DAILY_FINDING_CAP,
  FINDING_TRANSLATION_JOB,
  UNASSIGNED_DOCTOR,
  type ClinicalReviewer,
  type ClinicalReviewerDeps,
  type ClinicalReviewJobPayload,
  createClinicalReviewer,
  DEFAULT_REVIEWER_SETTINGS,
  type InboxFindingList,
  observationComponents,
  type ResolvedFlag,
  type ReviewerSettings,
  type ReviewReport,
  scheduleReviewAfterIngest,
} from './service.ts';
export {
  createReviewToolbox,
  ProposedFindingSchema,
  REVIEW_TOOL_DEFINITIONS,
  REVIEW_TOOL_NAMES,
  type ReviewToolName,
  SUBMIT_FINDINGS_TOOL,
  SubmitFindingsArgs,
  SubmitFindingsDraftArgs,
} from './tools.ts';
export { ckdEpi2021, summarizeTrend, type TrendSummary } from './trends.ts';
export { checkProposal, findingDedupKey, type FindingDraft } from './validation.ts';
export { locateVerbatim } from './text.ts';
export { LOCALE_LANGUAGE, REVIEWER_COPY, reviewerCopy, type ReviewerCopy } from './copy.ts';
