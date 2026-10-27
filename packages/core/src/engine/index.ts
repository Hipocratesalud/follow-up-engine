/**
 * The follow-up engine: rules first, AI second, human last. See
 * packages/core/README.md for layers, precedence and state machines.
 */
export { createFollowUpEngine } from './application/engine.ts';
export type { FollowUpEngine, FollowUpEngineDeps } from './application/engine.ts';
export type { IngestReport, NoteExtractionOutcome } from './application/ingest.ts';
export {
  NOTE_EXTRACTION_JOB,
  deriveFromExtraction,
  type NoteExtractionJobPayload,
} from './application/note-extraction.ts';
export type { ClosedExpectation } from './annotator/annotate.ts';
export { Catalog, protocolRuleId, type ExpectationDefinition } from './catalog.ts';
export {
  CASE_TRANSITIONS,
  canTransition,
  isActiveCaseStatus,
} from './case-manager/state-machine.ts';
export { computeCasePriority, PRIORITY_WEIGHTS } from './case-manager/priority.ts';
export { caseDedupKey, type WatcherReport } from './watcher/watcher.ts';
export { codeMatchKey, matchKeyFor, parseCodeMatchKey } from './matching/match-key.ts';
export { matchesFilter } from './matching/filter.ts';
export { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from './settings.ts';
