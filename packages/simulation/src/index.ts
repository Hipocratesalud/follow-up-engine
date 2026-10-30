/**
 * `@follow-up-engine/simulation`: a deterministic 90-day outcome simulation
 * of the order agent against a fixed-reminder control arm
 * (docs/simulation.md). Pure: it depends on core only; the engine it drives
 * is a port the runtime implements over the real FHIR ingestion.
 */
export const PACKAGE_NAME = '@follow-up-engine/simulation';

export { Agenda } from './agenda.ts';
export {
  ARMS,
  assignArm,
  buildCohort,
  personaById,
  testOf,
  type Arm,
  type SimPatient,
} from './cohort.ts';
export {
  OrderSetSchema,
  OrderSpecSchema,
  parseSimulationConfig,
  PERSONA_IDS,
  PersonaSchema,
  SimulationConfigSchema,
  SLOT_FITS,
  withCohort,
  type OrderKind,
  type OrderSet,
  type OrderSpec,
  type Persona,
  type PersonaId,
  type SimulationConfig,
  type SlotFit,
} from './config.ts';
export {
  FULFILMENT_PATHS,
  pathOfResourceId,
  simResourceId,
  type BookingOrigin,
  type FulfilmentPath,
  type ResultChannel,
  type SimOrder,
  type SimTest,
  type SimulatedEngine,
  type SimulatedEngineFactory,
} from './engine-port.ts';
export { renderMarkdown } from './markdown.ts';
export {
  armSample,
  buildReport,
  intervalOf,
  REPORT_VERSION,
  runSimulation,
  SIMULATION_MODEL_VERSION,
  simulationFingerprint,
  type ArmSample,
  type ArmSummary,
  type Interval,
  type PersonaSummary,
  type SimulationReport,
} from './report.ts';
export { createRng, fnv1a, hashUnit, type Rng } from './rng.ts';
export { runSeed, type OrderOutcome, type PatientTrace, type SeedRun } from './simulate.ts';
