/**
 * The follow-up engine: rules first, AI second, human last. See
 * packages/core/README.md for layers, precedence and state machines.
 */
export { createFollowUpEngine } from './application/engine.ts';
export type {
  BackfillCommands,
  ContactCommands,
  FollowUpEngine,
  FollowUpEngineDeps,
  PatientContactStatus,
} from './application/engine.ts';
export {
  isBudgetExceeded,
  replayBatches,
  type BackfillOptions,
  type BackfillReport,
  type ReplayBatch,
} from './backfill/backfill.ts';
export { BACKFILL_RELEASE_DEFAULTS, type BackfillReleasePlan } from './backfill/release.ts';
export type { IngestReport, NoteExtractionOutcome } from './application/ingest.ts';
export {
  NOTE_EXTRACTION_JOB,
  NOTE_EXTRACTION_MAX_ATTEMPTS,
  deriveFromExtraction,
  type NoteExtractionJobPayload,
} from './application/note-extraction.ts';
export {
  conditionId,
  parseConditionId,
  type ConditionCommands,
  type RejectConditionResult,
} from './application/condition-commands.ts';
export type { ClosedExpectation } from './annotator/annotate.ts';
export {
  Catalog,
  protocolRuleId,
  type CatalogOptions,
  type ExpectationDefinition,
} from './catalog.ts';
export {
  CALL_OUTCOMES,
  type CallOutcome,
  type CaseAction,
  type CaseCommands,
  type DismissInput,
  type DismissResult,
  type FeedbackInput,
} from './case-manager/commands.ts';
export {
  CALIBRATION_FEEDBACK_LIMIT,
  type CalibrationReport,
  type RuleCalibration,
} from './calibration/calibration.ts';
export type {
  CommunicationInput,
  CommunicationRecordResult,
  ContactReaction,
} from './patient-contact/outcomes.ts';
export { summarizeAttempt, type AttemptSummary } from './patient-contact/history.ts';
export { SUPPRESSED_FOR_PATIENT, type SuppressionCommands } from './suppression/suppressions.ts';
export {
  CASE_TRANSITIONS,
  canTransition,
  isActiveCaseStatus,
} from './case-manager/state-machine.ts';
export {
  computeCasePriority,
  overdueFactor,
  PRIORITY_MODEL,
  type PriorityCategory,
  priorityCategory,
} from './case-manager/priority.ts';
export { priorityOfCase } from './case-manager/case-priority.ts';
export type { EscalationReport, EscalationStepRecord } from './escalation/escalation.ts';
export {
  FALLBACK_ESCALATION_POLICY,
  nextActionAfter,
  pinnedPolicyId,
  policyOf,
} from './escalation/schedule.ts';
export {
  decidePatientContact,
  PatientContactNotAllowedError,
  type ContactSkipReason,
  type PatientContactDecision,
  type PatientContactDenial,
} from './patient-contact/policy.ts';
export { caseDedupKey, type WatcherReport } from './watcher/watcher.ts';
export { codeMatchKey, matchKeyFor, parseCodeMatchKey } from './matching/match-key.ts';
export { matchesFilter } from './matching/filter.ts';
export { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from './settings.ts';
