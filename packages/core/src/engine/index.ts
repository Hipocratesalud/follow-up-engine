/**
 * The follow-up engine: rules first, AI second, human last. See
 * packages/core/README.md for layers, precedence and state machines.
 */
export { createFollowUpEngine } from './application/engine.ts';
export type {
  BackfillCommands,
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
export { Catalog, protocolRuleId, type ExpectationDefinition } from './catalog.ts';
export type { CaseAction, CaseCommands, FeedbackInput } from './case-manager/commands.ts';
export {
  CASE_TRANSITIONS,
  canTransition,
  isActiveCaseStatus,
} from './case-manager/state-machine.ts';
export { computeCasePriority, PRIORITY_WEIGHTS } from './case-manager/priority.ts';
export type { EscalationReport, EscalationStepRecord } from './escalation/escalation.ts';
export { FALLBACK_ESCALATION_POLICY, nextActionAfter } from './escalation/schedule.ts';
export {
  decidePatientContact,
  type PatientContactDecision,
  type PatientContactDenial,
} from './patient-contact/policy.ts';
export { caseDedupKey, type WatcherReport } from './watcher/watcher.ts';
export { codeMatchKey, matchKeyFor, parseCodeMatchKey } from './matching/match-key.ts';
export { matchesFilter } from './matching/filter.ts';
export { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from './settings.ts';
