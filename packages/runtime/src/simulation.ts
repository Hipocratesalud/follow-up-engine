import { readFileSync } from 'node:fs';
import {
  FakeNoteExtractor,
  FileEscalationPolicySource,
  FileProtocolSource,
  FileRuleSource,
  SequentialIdGenerator,
} from '@follow-up-engine/adapter-memory';
import {
  type ClinicId,
  createFollowUpEngine,
  FakeClock,
  type FollowUpEngine,
} from '@follow-up-engine/core';
import {
  buildAgentAppointmentBundle,
  buildAgentResultBundle,
  buildConsultationBundle,
  buildPatientBundle,
  buildRecordBundle,
  type Bundle,
} from '@follow-up-engine/fhir';
import {
  parseSimulationConfig,
  renderMarkdown,
  runSimulation,
  simulationFingerprint,
  type SimulatedEngine,
  type SimulatedEngineFactory,
  type SimulationConfig,
  type SimulationReport,
  withCohort,
} from '@follow-up-engine/simulation';
import { IngestionService } from './ingestion.ts';
import { createMemoryStorage } from './storage.ts';

/**
 * The simulation's engine (docs/simulation.md#method): the real engine over
 * memory adapters, its own fake clock, the repository's rules and
 * protocols, the rule-based note reader. Every action of the simulation is
 * a FHIR `transaction` Bundle through the same {@link IngestionService} as
 * `POST /fhir`, so the engine alone decides what each booking, visit or
 * result fulfils.
 */

export const SIMULATION_CLINIC_ID = 'clinic-simulation' as ClinicId;

/** The versioned config at the repository root. */
export const DEFAULT_SIMULATION_CONFIG_URL = new URL(
  '../../../config/simulation/simulation.v1.json',
  import.meta.url,
);

export function loadSimulationConfig(url: URL = DEFAULT_SIMULATION_CONFIG_URL): SimulationConfig {
  return parseSimulationConfig(JSON.parse(readFileSync(url, 'utf8')) as unknown);
}

interface SharedSources {
  readonly rules: FileRuleSource;
  readonly protocols: FileProtocolSource;
  readonly escalationPolicies: FileEscalationPolicySource;
}

let sources: SharedSources | undefined;

function sharedSources(): SharedSources {
  sources ??= {
    rules: new FileRuleSource(),
    protocols: new FileProtocolSource(),
    escalationPolicies: new FileEscalationPolicySource(),
  };
  return sources;
}

/** A fresh engine for one seeded run: an empty clinic in the given time zone. */
export const createSimulatedEngine: SimulatedEngineFactory = async ({ start, timeZone }) => {
  const clock = new FakeClock(start);
  const storage = createMemoryStorage(clock);
  const clinicId = SIMULATION_CLINIC_ID;
  await storage.registerClinic({
    id: clinicId,
    name: 'Simulated clinic',
    settings: { timezone: timeZone },
  });
  const engine: FollowUpEngine = createFollowUpEngine({
    unitOfWork: storage.unitOfWork,
    noteExtractor: new FakeNoteExtractor(),
    ...sharedSources(),
    ruleOverrides: storage.stores.ruleOverrides,
    clinics: storage.clinics,
    clock,
    ids: new SequentialIdGenerator(),
  });
  const ingestion = new IngestionService({ storage, engine, clock });

  async function ingest(at: Date, bundle: Bundle): Promise<void> {
    if (at.getTime() > clock.now().getTime()) clock.set(at);
    const acceptance = await ingestion.accept(clinicId, bundle, 'sync');
    if (!acceptance.ok) {
      throw new Error(
        `The engine refused a simulation bundle: ${JSON.stringify(acceptance.outcome)}`,
      );
    }
  }

  const simulated: SimulatedEngine = {
    async placeOrders({ patientId, name, at, orders }) {
      await ingest(at, buildPatientBundle({ id: patientId, name }));
      const visit = orders.find((order) => order.kind === 'visit');
      const tests = orders.flatMap((order) =>
        order.kind === 'lab' || order.kind === 'imaging' ? [order] : [],
      );
      if (visit !== undefined) {
        // A consultation: the note's plan ("control en 4 semanas") and its orders, one Encounter.
        await ingest(
          at,
          buildConsultationBundle({
            consultationId: `${visit.id}-consult`,
            patient: { id: patientId },
            specialty: 'internal_medicine',
            occurredAt: at,
            noteText: visit.noteText,
            orders: tests.map((order) => ({
              loinc: order.test.loinc,
              display: order.test.display,
              category: order.kind === 'imaging' ? 'imaging' : 'laboratory',
            })),
          }),
        );
      } else {
        for (const order of tests) {
          await ingest(
            at,
            buildRecordBundle({
              recordId: order.id,
              patient: { id: patientId },
              occurredAt: at,
              entry: {
                kind: 'order',
                loinc: order.test.loinc,
                display: order.test.display,
                category: order.kind === 'imaging' ? 'imaging' : 'laboratory',
              },
            }),
          );
        }
      }
      for (const order of orders) {
        if (order.kind !== 'urgent') continue;
        await ingest(
          at,
          buildRecordBundle({
            recordId: order.id,
            patient: { id: patientId },
            occurredAt: at,
            entry: {
              kind: 'result',
              loinc: order.test.loinc,
              display: order.test.display,
              interpretation: 'abnormal',
            },
          }),
        );
      }
    },

    async bookVisit({ patientId, appointmentId, start: visitStart, end, at, origin }) {
      if (origin === 'patient') {
        await ingest(
          at,
          buildRecordBundle({
            recordId: appointmentId,
            patient: { id: patientId },
            occurredAt: at,
            entry: { kind: 'appointment_booked', scheduledFor: visitStart },
          }),
        );
        return;
      }
      await ingest(
        at,
        buildAgentAppointmentBundle({
          appointmentId,
          patientId,
          start: visitStart,
          end,
          practitionerName: 'Dr. Elena Ruiz',
          location: 'Office 2, main clinic',
          bookedAt: at,
        }),
      );
    },

    async recordVisit({ patientId, encounterId, at }) {
      await ingest(
        at,
        buildRecordBundle({
          recordId: encounterId,
          patient: { id: patientId },
          occurredAt: at,
          entry: { kind: 'visit' },
        }),
      );
    },

    async recordResult({ patientId, resultId, test, effectiveAt, at, channel }) {
      if (channel === 'patient_photo') {
        await ingest(
          at,
          buildAgentResultBundle({
            observationId: resultId,
            patientId,
            code: { system: 'http://loinc.org', code: test.loinc, display: test.display },
            value: 1,
            effectiveAt,
            receivedAt: at,
          }),
        );
        return;
      }
      await ingest(
        at,
        buildRecordBundle({
          recordId: resultId,
          patient: { id: patientId },
          occurredAt: effectiveAt,
          entry: { kind: 'result', loinc: test.loinc, display: test.display },
        }),
      );
    },

    async runWatcher(at) {
      if (at.getTime() > clock.now().getTime()) clock.set(at);
      await engine.runWatcher(clinicId, at);
    },

    expectations(patientId) {
      return storage.stores.expectations.listByPatient(clinicId, patientId);
    },
  };
  return simulated;
};

export interface OutcomeSimulationOptions {
  readonly config?: SimulationConfig;
  readonly patientsPerArm?: number;
  readonly seeds?: number;
  readonly onSeed?: (seed: number) => void;
}

/** Runs the simulation over the real engine and returns the report (and its markdown). */
export async function runOutcomeSimulation(
  options: OutcomeSimulationOptions = {},
): Promise<{ readonly report: SimulationReport; readonly markdown: string }> {
  const base = options.config ?? loadSimulationConfig();
  const config = withCohort(base, {
    ...(options.patientsPerArm === undefined ? {} : { patientsPerArm: options.patientsPerArm }),
    ...(options.seeds === undefined ? {} : { seeds: options.seeds }),
  });
  const startedAt = performance.now();
  const { report } = await runSimulation(config, createSimulatedEngine, {
    onSeed: (run) => options.onSeed?.(run.seed),
  });
  const timed = { ...report, elapsedMs: Math.round(performance.now() - startedAt) };
  return { report: timed, markdown: renderMarkdown(timed) };
}

/** Where the CLI keeps the latest report next to the code, so a server serves it at once. */
export const SIMULATION_SNAPSHOT_URL = new URL('../assets/simulation/latest.json', import.meta.url);

/** Bounds of a server-side run (anything larger is the CLI's job). */
export const SIMULATION_LIMITS = {
  patientsPerArm: { min: 50, max: 400 },
  seeds: { min: 1, max: 20 },
} as const;

export type SimulationReportState =
  | { readonly status: 'ready'; readonly report: SimulationReport }
  | { readonly status: 'running'; readonly seedsDone: number; readonly seeds: number }
  | { readonly status: 'failed'; readonly error: string };

export interface SimulationReportCache {
  /** The report of a parameter set: ready (cached), or running (started now or before). */
  get(params?: {
    readonly patientsPerArm?: number;
    readonly seeds?: number;
  }): SimulationReportState;
  /** Resolves once the parameter set is no longer running (tests, the CLI). */
  settled(params?: {
    readonly patientsPerArm?: number;
    readonly seeds?: number;
  }): Promise<SimulationReportState>;
}

function readSnapshot(url: URL): SimulationReport | undefined {
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as SimulationReport;
  } catch {
    return undefined;
  }
}

/**
 * The simulation reports a server hands out, one per parameter set
 * (patients per arm, seeds), computed once in the background and kept. The
 * shipped snapshot answers the default parameters at once when it was made
 * from the same config and model ({@link simulationFingerprint}); any other
 * set is computed on first request (seconds to a minute) while the caller
 * polls. The run yields to the event loop as it goes.
 */
export function createSimulationReportCache(
  options: {
    readonly config?: SimulationConfig;
    readonly snapshotUrl?: URL;
  } = {},
): SimulationReportCache {
  const config = options.config ?? loadSimulationConfig();
  const states = new Map<string, SimulationReportState>();
  const running = new Map<string, Promise<SimulationReportState>>();
  const snapshot = readSnapshot(options.snapshotUrl ?? SIMULATION_SNAPSHOT_URL);
  if (snapshot?.fingerprint === simulationFingerprint(config)) {
    states.set(keyOf(config.cohort.patientsPerArm, config.cohort.seeds), {
      status: 'ready',
      report: snapshot,
    });
  }

  function keyOf(patientsPerArm: number, seeds: number): string {
    return `${String(patientsPerArm)}x${String(seeds)}`;
  }

  function resolve(params: { readonly patientsPerArm?: number; readonly seeds?: number } = {}) {
    const clamp = (value: number, bounds: { min: number; max: number }): number =>
      Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
    const patientsPerArm = clamp(
      params.patientsPerArm ?? config.cohort.patientsPerArm,
      SIMULATION_LIMITS.patientsPerArm,
    );
    const seeds = clamp(params.seeds ?? config.cohort.seeds, SIMULATION_LIMITS.seeds);
    return { patientsPerArm, seeds, key: keyOf(patientsPerArm, seeds) };
  }

  function start(
    patientsPerArm: number,
    seeds: number,
    key: string,
  ): Promise<SimulationReportState> {
    const existing = running.get(key);
    if (existing !== undefined) return existing;
    states.set(key, { status: 'running', seedsDone: 0, seeds });
    const job = (async (): Promise<SimulationReportState> => {
      try {
        const sized = withCohort(config, { patientsPerArm, seeds });
        const startedAt = performance.now();
        let done = 0;
        const { report } = await runSimulation(sized, createSimulatedEngine, {
          onSeed: () => {
            done += 1;
            states.set(key, { status: 'running', seedsDone: done, seeds });
          },
          pause: () => new Promise((resume) => setImmediate(resume)),
        });
        const state: SimulationReportState = {
          status: 'ready',
          report: { ...report, elapsedMs: Math.round(performance.now() - startedAt) },
        };
        states.set(key, state);
        return state;
      } catch (error) {
        const state: SimulationReportState = {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        states.set(key, state);
        return state;
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, job);
    return job;
  }

  return {
    get(params) {
      const { patientsPerArm, seeds, key } = resolve(params);
      const state = states.get(key);
      if (state !== undefined && state.status !== 'failed') return state;
      void start(patientsPerArm, seeds, key);
      return states.get(key) ?? { status: 'running', seedsDone: 0, seeds };
    },
    async settled(params) {
      const { patientsPerArm, seeds, key } = resolve(params);
      const state = states.get(key);
      if (state?.status === 'ready') return state;
      return running.get(key) ?? start(patientsPerArm, seeds, key);
    },
  };
}
