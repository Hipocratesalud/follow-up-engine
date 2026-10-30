import type { StaffTaskKind } from '@follow-up-engine/core';
import { type Arm, ARMS } from './cohort.ts';
import { type OrderKind, PERSONA_IDS, type PersonaId, type SimulationConfig } from './config.ts';
import {
  FULFILMENT_PATHS,
  type FulfilmentPath,
  type SimulatedEngineFactory,
} from './engine-port.ts';
import { fnv1a } from './rng.ts';
import { type OrderOutcome, type PatientTrace, runSeed, type SeedRun } from './simulate.ts';

/**
 * The simulation report: every metric per arm, as the mean over seeded
 * runs with a 95 % interval (the 2.5th and 97.5th percentiles across
 * seeds), plus the paired difference agent − control per seed. JSON for
 * the API and the inbox, markdown for docs/evals/simulation.
 */

export const REPORT_VERSION = 'simulation-report.v1';

/**
 * Version of the simulation model (the arms' logic in simulate.ts). Bump it
 * whenever a change to the model can change a number: a stored report of
 * another model version is stale.
 */
export const SIMULATION_MODEL_VERSION = 'sim-model.v1';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
}

/** A short fingerprint of a config and the model version: equal fingerprints, equal reports. */
export function simulationFingerprint(config: SimulationConfig): string {
  return `${SIMULATION_MODEL_VERSION}:${fnv1a(JSON.stringify(canonical(config)))
    .toString(16)
    .padStart(8, '0')}`;
}

const DAY_MS = 86_400_000;
const ORDER_KINDS: readonly OrderKind[] = ['lab', 'imaging', 'visit', 'urgent'];
const TASK_KINDS: readonly StaffTaskKind[] = [
  'call_patient',
  'doctor_notice',
  'update_phone',
  'call_other_contact',
];

/** Mean over seeds and the 95 % interval across them. */
export interface Interval {
  readonly mean: number;
  readonly low: number;
  readonly high: number;
}

/** One seed's numbers for one arm (the unit the intervals are taken over). */
export interface ArmSample {
  readonly patients: number;
  readonly orders: number;
  readonly fulfilled: number;
  readonly fulfilledShare: number;
  readonly medianDaysToFulfilment: number;
  readonly byKind: Readonly<
    Record<OrderKind, { readonly orders: number; readonly fulfilledShare: number }>
  >;
  readonly urgentOrders: number;
  readonly urgentWithin7Share: number;
  readonly urgentWithin14Share: number;
  readonly unreachableShare: number;
  readonly markedUnreachableShare: number;
  readonly optedOutShare: number;
  readonly tasksPer100: Readonly<Record<StaffTaskKind | 'total', number>>;
  readonly callsAnsweredPer100: number;
  readonly messagesPerPatient: number;
  readonly proactivePerPatient: number;
  readonly maxProactiveIn7Days: number;
  readonly consultationsBookedPer100: number;
  readonly consultationsAttendedPer100: number;
  readonly labVisitsAttendedPer100: number;
  /** Share of all orders fulfilled through each path. */
  readonly paths: Readonly<Record<FulfilmentPath, number>>;
  readonly agentActions: number;
}

type IntervalOf<T> = { readonly [K in keyof T]: T[K] extends number ? Interval : IntervalOf<T[K]> };

export type ArmSummary = IntervalOf<Omit<ArmSample, 'maxProactiveIn7Days' | 'agentActions'>> & {
  /** The most proactive messages any patient got in a rolling 7 days, over every run. */
  readonly maxProactiveIn7Days: number;
  /** Agent-only actions over every run (0 for the control arm). */
  readonly agentActions: number;
};

export interface PersonaSummary {
  readonly persona: PersonaId;
  readonly weight: number;
  readonly patientsPerRun: Interval;
  readonly control: Interval;
  readonly agent: Interval;
  /** Agent − control, in share points, paired by seed. */
  readonly difference: Interval;
}

export interface SimulationReport {
  readonly reportVersion: typeof REPORT_VERSION;
  readonly configVersion: string;
  /** {@link simulationFingerprint} of the config the report ran on. */
  readonly fingerprint: string;
  readonly notice: string;
  readonly seeds: readonly number[];
  readonly cohort: SimulationConfig['cohort'];
  readonly arms: Readonly<Record<Arm, ArmSummary>>;
  /** Agent − control per seed, then the interval. */
  readonly difference: {
    readonly fulfilledShare: Interval;
    readonly medianDaysToFulfilment: Interval;
    readonly urgentWithin7Share: Interval;
    readonly urgentWithin14Share: Interval;
    readonly consultationsAttendedPer100: Interval;
    readonly unreachableShare: Interval;
  };
  readonly personas: readonly PersonaSummary[];
  /** Each seed's headline numbers (the snapshot check reruns one and compares). */
  readonly perSeed: readonly {
    readonly seed: number;
    readonly control: { readonly orders: number; readonly fulfilled: number };
    readonly agent: { readonly orders: number; readonly fulfilled: number };
  }[];
  readonly economics: SimulationConfig['economics'] & {
    /** Extra attended consultations per patient with orders (agent − control). */
    readonly recoveredConsultationsPerPatient: Interval;
    /** At the default patients per month and price. */
    readonly recoveredConsultationsPerMonth: Interval;
    readonly recoveredRevenuePerMonth: Interval;
  };
  readonly invariants: {
    readonly maxProactiveIn7Days: number;
    readonly controlAgentActions: number;
    readonly unmappedOrders: number;
  };
  readonly personaConfig: readonly {
    readonly id: PersonaId;
    readonly weight: number;
    readonly summary: string;
    readonly rationale: string;
  }[];
  readonly assumptions: readonly string[];
  /** Wall-clock milliseconds of the whole run (not part of the deterministic content). */
  readonly elapsedMs?: number;
}

/** Linear-interpolated quantile of sorted values. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export function intervalOf(values: readonly number[]): Interval {
  const sorted = [...values].sort((left, right) => left - right);
  const mean =
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return { mean, low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
}

function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((left, right) => left - right),
    0.5,
  );
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function daysToClose(order: OrderOutcome): number | undefined {
  return order.status === 'fulfilled' && order.closedAt !== undefined
    ? (order.closedAt.getTime() - order.createdAt.getTime()) / DAY_MS
    : undefined;
}

function per100(patients: readonly PatientTrace[], pick: (trace: PatientTrace) => number): number {
  return ratio(100 * patients.reduce((sum, trace) => sum + pick(trace), 0), patients.length);
}

/** One seed's numbers for one arm. */
export function armSample(run: SeedRun, arm: Arm): ArmSample {
  const patients = run.patients.filter((trace) => trace.arm === arm);
  const orders = run.orders.filter((order) => order.arm === arm);
  const fulfilled = orders.filter((order) => order.status === 'fulfilled');
  const days = fulfilled.flatMap((order) => {
    const value = daysToClose(order);
    return value === undefined ? [] : [value];
  });
  const urgent = orders.filter((order) => order.kind === 'urgent');
  const within = (limit: number): number =>
    ratio(
      urgent.filter((order) => (daysToClose(order) ?? Infinity) <= limit).length,
      urgent.length,
    );
  const pendingPatients = new Set(
    orders.filter((order) => order.status !== 'fulfilled').map((order) => order.patientId),
  );
  const unreachable = patients.filter(
    (trace) =>
      pendingPatients.has(trace.patientId) && trace.inbound === 0 && trace.callsAnswered === 0,
  );
  const byKind = Object.fromEntries(
    ORDER_KINDS.map((kind) => {
      const ofKind = orders.filter((order) => order.kind === kind);
      return [
        kind,
        {
          orders: ofKind.length,
          fulfilledShare: ratio(
            ofKind.filter((order) => order.status === 'fulfilled').length,
            ofKind.length,
          ),
        },
      ];
    }),
  ) as Record<OrderKind, { orders: number; fulfilledShare: number }>;
  const tasks = Object.fromEntries(
    TASK_KINDS.map((kind) => [kind, per100(patients, (trace) => trace.tasks[kind])]),
  ) as Record<StaffTaskKind, number>;
  const paths = Object.fromEntries(
    FULFILMENT_PATHS.map((path) => [
      path,
      ratio(fulfilled.filter((order) => order.path === path).length, orders.length),
    ]),
  ) as Record<FulfilmentPath, number>;
  return {
    patients: patients.length,
    orders: orders.length,
    fulfilled: fulfilled.length,
    fulfilledShare: ratio(fulfilled.length, orders.length),
    medianDaysToFulfilment: median(days),
    byKind,
    urgentOrders: urgent.length,
    urgentWithin7Share: within(7),
    urgentWithin14Share: within(14),
    unreachableShare: ratio(unreachable.length, patients.length),
    markedUnreachableShare: ratio(
      patients.filter((trace) => trace.markedUnreachable).length,
      patients.length,
    ),
    optedOutShare: ratio(patients.filter((trace) => trace.optedOut).length, patients.length),
    tasksPer100: { ...tasks, total: TASK_KINDS.reduce((sum, kind) => sum + tasks[kind], 0) },
    callsAnsweredPer100: per100(patients, (trace) => trace.callsAnswered),
    messagesPerPatient: ratio(
      patients.reduce((sum, trace) => sum + trace.outbound, 0),
      patients.length,
    ),
    proactivePerPatient: ratio(
      patients.reduce((sum, trace) => sum + trace.proactive, 0),
      patients.length,
    ),
    maxProactiveIn7Days: Math.max(0, ...patients.map((trace) => trace.maxProactiveIn7Days)),
    consultationsBookedPer100: per100(patients, (trace) => trace.consultationsBooked),
    consultationsAttendedPer100: per100(patients, (trace) => trace.consultationsAttended),
    labVisitsAttendedPer100: per100(patients, (trace) => trace.labVisitsAttended),
    paths,
    agentActions: patients.reduce((sum, trace) => sum + trace.agentActions, 0),
  };
}

/** Turns a list of same-shaped samples into intervals, field by field. */
function summarize<T extends object>(samples: readonly T[]): IntervalOf<T> {
  const first = samples[0];
  if (first === undefined) throw new Error('No samples to summarize');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(first)) {
    const values = samples.map((sample) => (sample as Record<string, unknown>)[key]);
    out[key] =
      typeof values[0] === 'number'
        ? intervalOf(values as number[])
        : summarize(values as object[]);
  }
  return out as IntervalOf<T>;
}

function armSummary(samples: readonly ArmSample[]): ArmSummary {
  const intervals = summarize(
    samples.map((sample): Omit<ArmSample, 'maxProactiveIn7Days' | 'agentActions'> => {
      const rest: Record<string, unknown> = { ...sample };
      delete rest['maxProactiveIn7Days'];
      delete rest['agentActions'];
      return rest as unknown as Omit<ArmSample, 'maxProactiveIn7Days' | 'agentActions'>;
    }),
  );
  return {
    ...intervals,
    maxProactiveIn7Days: Math.max(0, ...samples.map((sample) => sample.maxProactiveIn7Days)),
    agentActions: samples.reduce((sum, sample) => sum + sample.agentActions, 0),
  };
}

function personaShare(run: SeedRun, arm: Arm, persona: PersonaId): number {
  const orders = run.orders.filter((order) => order.arm === arm && order.persona === persona);
  return ratio(orders.filter((order) => order.status === 'fulfilled').length, orders.length);
}

/** The report of seeded runs. */
export function buildReport(config: SimulationConfig, runs: readonly SeedRun[]): SimulationReport {
  const samples = Object.fromEntries(
    ARMS.map((arm) => [arm, runs.map((run) => armSample(run, arm))]),
  ) as Record<Arm, ArmSample[]>;
  const paired = (pick: (sample: ArmSample) => number): Interval =>
    intervalOf(
      runs.map((_, index) => {
        const agent = samples.agent[index];
        const control = samples.control[index];
        return agent === undefined || control === undefined ? 0 : pick(agent) - pick(control);
      }),
    );
  const recoveredPerPatient = paired((sample) => sample.consultationsAttendedPer100 / 100);
  const { patientsPerMonth, consultationPrice } = config.economics;
  const scale = (interval: Interval, factor: number): Interval => ({
    mean: interval.mean * factor,
    low: interval.low * factor,
    high: interval.high * factor,
  });
  return {
    reportVersion: REPORT_VERSION,
    configVersion: config.version,
    fingerprint: simulationFingerprint(config),
    notice: config.notice,
    seeds: runs.map((run) => run.seed),
    cohort: config.cohort,
    arms: { control: armSummary(samples.control), agent: armSummary(samples.agent) },
    difference: {
      fulfilledShare: paired((sample) => sample.fulfilledShare),
      medianDaysToFulfilment: paired((sample) => sample.medianDaysToFulfilment),
      urgentWithin7Share: paired((sample) => sample.urgentWithin7Share),
      urgentWithin14Share: paired((sample) => sample.urgentWithin14Share),
      consultationsAttendedPer100: paired((sample) => sample.consultationsAttendedPer100),
      unreachableShare: paired((sample) => sample.unreachableShare),
    },
    personas: PERSONA_IDS.map((persona) => {
      const weight = config.personas.find((item) => item.id === persona)?.weight ?? 0;
      return {
        persona,
        weight,
        patientsPerRun: intervalOf(
          runs.map((run) => run.patients.filter((trace) => trace.persona === persona).length),
        ),
        control: intervalOf(runs.map((run) => personaShare(run, 'control', persona))),
        agent: intervalOf(runs.map((run) => personaShare(run, 'agent', persona))),
        difference: intervalOf(
          runs.map(
            (run) => personaShare(run, 'agent', persona) - personaShare(run, 'control', persona),
          ),
        ),
      };
    }),
    perSeed: runs.map((run, index) => ({
      seed: run.seed,
      control: {
        orders: samples.control[index]?.orders ?? 0,
        fulfilled: samples.control[index]?.fulfilled ?? 0,
      },
      agent: {
        orders: samples.agent[index]?.orders ?? 0,
        fulfilled: samples.agent[index]?.fulfilled ?? 0,
      },
    })),
    economics: {
      ...config.economics,
      recoveredConsultationsPerPatient: recoveredPerPatient,
      recoveredConsultationsPerMonth: scale(recoveredPerPatient, patientsPerMonth),
      recoveredRevenuePerMonth: scale(recoveredPerPatient, patientsPerMonth * consultationPrice),
    },
    invariants: {
      maxProactiveIn7Days: Math.max(
        0,
        ...runs.flatMap((run) => run.patients.map((trace) => trace.maxProactiveIn7Days)),
      ),
      controlAgentActions: samples.control.reduce((sum, sample) => sum + sample.agentActions, 0),
      unmappedOrders: runs.reduce((sum, run) => sum + run.unmappedOrders, 0),
    },
    personaConfig: config.personas.map((persona) => ({
      id: persona.id,
      weight: persona.weight,
      summary: persona.summary,
      rationale: persona.rationale,
    })),
    assumptions: config.assumptions,
  };
}

/** Seeds 1..n of the config (or the given list), run one after another. */
export async function runSimulation(
  config: SimulationConfig,
  createEngine: SimulatedEngineFactory,
  options: {
    readonly seeds?: readonly number[];
    readonly onSeed?: (run: SeedRun) => void;
    /** Called now and then during a run (a server yields to its event loop there). */
    readonly pause?: () => Promise<void>;
  } = {},
): Promise<{ readonly report: SimulationReport; readonly runs: readonly SeedRun[] }> {
  const seeds =
    options.seeds ?? Array.from({ length: config.cohort.seeds }, (_, index) => index + 1);
  const runs: SeedRun[] = [];
  for (const seed of seeds) {
    const run = await runSeed(
      config,
      seed,
      createEngine,
      options.pause === undefined ? {} : { pause: options.pause },
    );
    options.onSeed?.(run);
    runs.push(run);
  }
  return { report: buildReport(config, runs), runs };
}
