/**
 * `@follow-up-engine/testkit`: shared contract tests that every adapter of a
 * port must pass, plus synthetic fixtures. Test-only: production code must
 * never import it (enforced by `pnpm boundaries`).
 *
 * Every patient, note and result here is synthetic. No real patient data.
 */

// Constants
export {
  ALL_RULE_IDS,
  BASE_DATE,
  dayToDate,
  DEMO_CLINIC_ID,
  DEMO_CLINIC_NAME,
  RULE_IDS,
  type RuleId,
  SPECIALTIES,
  type Specialty,
  SYSTEMS,
} from './constants.ts';

// FHIR R4 validation
export {
  assertValidFhirR4,
  FHIR_R4_SCHEMA_SHA256,
  type FhirValidationIssue,
  type FhirValidationResult,
  validateFhirR4,
} from './fhir/validate.ts';

// Fixtures
export {
  FIXTURES_DIR,
  loadGoldNotes,
  loadScenarios,
  loadSyntheticClinic,
} from './fixtures/load.ts';
export type { GoldNote } from './fixtures/schemas.ts';
export type {
  CaseAssertion,
  ClosedExpectationAssertion,
  ExpectationAssertion,
  LlmFixtureExtraction,
  Scenario,
  ScenarioCheckpoint,
  ScenarioStep,
} from './scenarios/types.ts';
export {
  DEFAULT_SEED,
  generateSyntheticClinic,
  type SyntheticClinic,
  type SyntheticClinicDirectory,
  type SyntheticClinicStats,
  type SyntheticPatient,
} from './synthetic/clinic.ts';
export {
  noteTextOf,
  type FhirResource,
  type TransactionBundle,
} from './synthetic/fhir-builders.ts';
export type { TimelineEntry, TimelineEntryKind } from './synthetic/timeline.ts';

// Contract suites
export { describeClockContract } from './clock-contract.ts';
export { describeCaseRepositoryContract } from './contracts/case-repository.contract.ts';
export {
  aClinic,
  type ClinicSeed,
  describeClinicDirectoryContract,
  describeLlmUsageLogContract,
  hashApiKey,
} from './contracts/clinic-directory.contract.ts';
export { describeClinicalRecordRepositoryContract } from './contracts/clinical-record-repository.contract.ts';
export { describeExpectationRepositoryContract } from './contracts/expectation-repository.contract.ts';
export {
  describeJobQueueContract,
  describeOutboxContract,
  type OutboxContractSubject,
} from './contracts/job-queue.contract.ts';
export {
  describeAuditLogContract,
  describeConditionRepositoryContract,
  describeFeedbackRepositoryContract,
  describeQualityFindingRepositoryContract,
} from './contracts/small-repositories.contract.ts';
export {
  describeUnitOfWorkContract,
  type UnitOfWorkContractSubject,
} from './contracts/unit-of-work.contract.ts';
export type { ContractSubject, MakeSubject } from './contracts/harness.ts';
export { describeBackfillProgressStoreContract } from './contracts/backfill-progress.contract.ts';
export * as contractBuilders from './contracts/builders.ts';
