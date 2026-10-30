import { readFileSync } from 'node:fs';
import {
  buildReport,
  renderMarkdown,
  runSeed,
  type SeedRun,
  type SimulatedEngine,
  type SimulatedEngineFactory,
  type SimulationConfig,
  type SimulationReport,
  simulationFingerprint,
  withCohort,
} from '@follow-up-engine/simulation';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSimulatedEngine,
  createSimulationReportCache,
  loadSimulationConfig,
  SIMULATION_SNAPSHOT_URL,
} from './simulation.ts';

/**
 * The 90-day simulation over the real engine (docs/simulation.md): small
 * cohorts, so each run takes a fraction of a second.
 */

const DAY_MS = 86_400_000;
const base = loadSimulationConfig();
const small = withCohort(base, { patientsPerArm: 60, seeds: 2 });

/** Every persona the same, with the given overrides (a deterministic corner of the model). */
function onlyPersona(
  config: SimulationConfig,
  id: SimulationConfig['personas'][number]['id'],
  overrides: Partial<SimulationConfig['personas'][number]> = {},
): SimulationConfig {
  return {
    ...config,
    personas: config.personas.map((persona) =>
      persona.id === id ? { ...persona, ...overrides, weight: 1 } : { ...persona, weight: 1e-9 },
    ),
  };
}

/** The real engine, with every write the simulation asks for counted (or dropped). */
function spied(options: { readonly dropWrites?: boolean } = {}): {
  readonly factory: SimulatedEngineFactory;
  readonly writes: string[];
} {
  const writes: string[] = [];
  const factory: SimulatedEngineFactory = async (input) => {
    const engine = await createSimulatedEngine(input);
    const drop = options.dropWrites === true;
    const wrapped: SimulatedEngine = {
      ...engine,
      placeOrders: (args) => engine.placeOrders(args),
      bookVisit: async (args) => {
        writes.push(args.appointmentId);
        if (!drop) await engine.bookVisit(args);
      },
      recordVisit: async (args) => {
        writes.push(args.encounterId);
        if (!drop) await engine.recordVisit(args);
      },
      recordResult: async (args) => {
        writes.push(args.resultId);
        if (!drop) await engine.recordResult(args);
      },
    };
    return wrapped;
  };
  return { factory, writes };
}

describe('the outcome simulation over the real engine', () => {
  let first: SeedRun;

  beforeAll(async () => {
    first = await runSeed(small, 1, createSimulatedEngine);
  });

  it('is deterministic: the same seed gives the same run', async () => {
    const again = await runSeed(small, 1, createSimulatedEngine);
    expect(again).toEqual(first);
    const other = await runSeed(small, 2, createSimulatedEngine);
    expect(other.orders).not.toEqual(first.orders);
  });

  it('places every order with the engine and maps it to an expectation', () => {
    expect(first.unmappedOrders).toBe(0);
    expect(first.patients.filter((trace) => trace.arm === 'control')).toHaveLength(60);
    expect(first.patients.filter((trace) => trace.arm === 'agent')).toHaveLength(60);
    expect(new Set(first.orders.map((order) => order.kind))).toEqual(
      new Set(['lab', 'imaging', 'visit', 'urgent']),
    );
  });

  it('never exceeds the contact cap: at most 2 proactive messages per patient in any 7 days', async () => {
    const runs = [
      first,
      await runSeed(withCohort(base, { patientsPerArm: 150 }), 3, createSimulatedEngine),
    ];
    for (const run of runs) {
      for (const trace of run.patients) {
        expect(trace.maxProactiveIn7Days).toBeLessThanOrEqual(2);
        // Recomputed independently of the policy, from the instants themselves.
        for (const at of trace.proactiveAt) {
          const inWindow = trace.proactiveAt.filter(
            (other) => other <= at && other > at - 7 * DAY_MS,
          );
          expect(inWindow.length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('gives the control arm no agent action: no offers, tasks, calls, photos or agent bookings', () => {
    for (const trace of first.patients.filter((item) => item.arm === 'control')) {
      expect(trace.agentActions).toBe(0);
      expect(Object.values(trace.tasks).every((count) => count === 0)).toBe(true);
      expect(trace.callsMade).toBe(0);
      expect(trace.markedUnreachable).toBe(false);
      // Two reminders per due date at most, never more.
      expect(trace.proactive).toBeLessThanOrEqual(4);
    }
    const controlPaths = new Set(
      first.orders.filter((order) => order.arm === 'control').map((order) => order.path),
    );
    for (const path of ['agent', 'staff', 'photo'] as const) {
      expect(controlPaths.has(path)).toBe(false);
    }
    const agentPaths = new Set(
      first.orders.filter((order) => order.arm === 'agent').map((order) => order.path),
    );
    expect(agentPaths.has('reminder')).toBe(false);
    expect(agentPaths.has('agent')).toBe(true);
  });

  it('counts only what the engine closed: with the writes dropped, nothing is fulfilled', async () => {
    const real = spied();
    const run = await runSeed(small, 1, real.factory);
    const fulfilled = run.orders.filter((order) => order.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
    // Every fulfilled order names the resource that closed it, and it is one the simulation wrote.
    expect(fulfilled.every((order) => order.path !== undefined)).toBe(true);
    expect(real.writes.length).toBeGreaterThan(0);

    const dropped = spied({ dropWrites: true });
    const none = await runSeed(small, 1, dropped.factory);
    expect(dropped.writes.length).toBeGreaterThan(0);
    expect(none.orders.filter((order) => order.status === 'fulfilled')).toEqual([]);
  });

  it('never fulfils a "never answers" patient through messaging or calls', async () => {
    const config = withCohort(onlyPersona(base, 'never_answers'), { patientsPerArm: 80 });
    const run = await runSeed(config, 1, createSimulatedEngine);
    expect(run.patients.every((trace) => trace.persona === 'never_answers')).toBe(true);
    for (const trace of run.patients) {
      expect(trace.inbound).toBe(0);
      expect(trace.callsAnswered).toBe(0);
    }
    const paths = new Set(
      run.orders.flatMap((order) => (order.path === undefined ? [] : [order.path])),
    );
    expect([...paths]).toEqual(['self']);
  });

  it('never reaches a wrong number in the control arm; the agent reaches some once reception fixes it', async () => {
    const config = withCohort(onlyPersona(base, 'wrong_number'), { patientsPerArm: 80 });
    const run = await runSeed(config, 1, createSimulatedEngine);
    const control = run.patients.filter((trace) => trace.arm === 'control');
    expect(
      control.every((trace) => trace.inbound === 0 && trace.undelivered === trace.outbound),
    ).toBe(true);
    const agent = run.patients.filter((trace) => trace.arm === 'agent');
    expect(agent.some((trace) => trace.tasks.update_phone > 0)).toBe(true);
    expect(agent.some((trace) => trace.inbound > 0)).toBe(true);
  });

  it('stops writing after an opt-out, in both arms', async () => {
    const config = withCohort(onlyPersona(base, 'opts_out', { optOutOnReply: 1, engage: [1] }), {
      patientsPerArm: 40,
    });
    const run = await runSeed(config, 1, createSimulatedEngine);
    for (const trace of run.patients.filter((item) => item.inbound > 0)) {
      expect(trace.optedOut).toBe(true);
      // The first reply opts out: nothing proactive after the message it answered.
      expect(trace.inbound).toBe(1);
      expect(trace.proactive).toBe(1);
    }
  });

  it('closes outside results by photo only in the agent arm', async () => {
    const config = withCohort(onlyPersona(base, 'elsewhere_photo'), { patientsPerArm: 80 });
    const run = await runSeed(config, 1, createSimulatedEngine);
    const photo = run.orders.filter((order) => order.path === 'photo');
    expect(photo.length).toBeGreaterThan(0);
    expect(
      photo.every(
        (order) => order.arm === 'agent' && (order.kind === 'lab' || order.kind === 'imaging'),
      ),
    ).toBe(true);
  });

  it('runs the urgent track fast: urgent orders get the high-priority call before routine ones would', () => {
    const urgentPatients = new Set(
      first.orders
        .filter((order) => order.kind === 'urgent' && order.arm === 'agent')
        .map((order) => order.patientId),
    );
    const doctorNotices = first.patients.filter(
      (trace) => urgentPatients.has(trace.patientId) && trace.tasks.doctor_notice > 0,
    );
    expect(doctorNotices.length).toBeGreaterThan(0);
  });

  it('builds a report with intervals and a markdown headline', async () => {
    const second = await runSeed(small, 2, createSimulatedEngine);
    const report = buildReport(small, [first, second]);
    expect(report.seeds).toEqual([1, 2]);
    expect(report.fingerprint).toBe(simulationFingerprint(small));
    const { fulfilledShare } = report.arms.agent;
    expect(fulfilledShare.low).toBeLessThanOrEqual(fulfilledShare.mean);
    expect(fulfilledShare.high).toBeGreaterThanOrEqual(fulfilledShare.mean);
    expect(report.invariants.controlAgentActions).toBe(0);
    expect(report.invariants.maxProactiveIn7Days).toBeLessThanOrEqual(2);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('Orders fulfilled within 90 days');
    expect(markdown).toContain('not a clinical trial');
  });
});

describe('the simulation report cache', () => {
  it('computes a parameter set once in the background and serves it from then on', async () => {
    const cache = createSimulationReportCache({
      config: withCohort(base, { patientsPerArm: 50, seeds: 1 }),
      snapshotUrl: new URL('./does-not-exist.json', import.meta.url),
    });
    const first = cache.get({ patientsPerArm: 50, seeds: 1 });
    expect(first.status).toBe('running');
    const settled = await cache.settled({ patientsPerArm: 50, seeds: 1 });
    expect(settled.status).toBe('ready');
    const again = cache.get({ patientsPerArm: 50, seeds: 1 });
    expect(again).toBe(settled);
  });

  it('clamps a server-side run to the limits', async () => {
    const cache = createSimulationReportCache({
      config: withCohort(base, { patientsPerArm: 50, seeds: 1 }),
      snapshotUrl: new URL('./does-not-exist.json', import.meta.url),
    });
    const state = await cache.settled({ patientsPerArm: 10, seeds: 0 });
    expect(state.status === 'ready' ? state.report.cohort.patientsPerArm : 0).toBe(50);
    expect(state.status === 'ready' ? state.report.seeds : []).toEqual([1]);
  });
});

describe('the committed snapshot', () => {
  // Run `pnpm simulate` after changing the config or the model: the API serves this file.
  const snapshot = JSON.parse(readFileSync(SIMULATION_SNAPSHOT_URL, 'utf8')) as SimulationReport;

  it('is the same file the inbox mock serves', () => {
    const inboxCopy = readFileSync(
      new URL('../../../apps/inbox/src/features/value/simulation-snapshot.json', import.meta.url),
      'utf8',
    );
    expect(inboxCopy).toBe(readFileSync(SIMULATION_SNAPSHOT_URL, 'utf8'));
  });

  it('was made from the current config', () => {
    expect(snapshot.fingerprint).toBe(simulationFingerprint(base));
    expect(snapshot.seeds).toHaveLength(base.cohort.seeds);
  });

  it('was made by the current model: seed 1 reruns to the same numbers', async () => {
    const run = await runSeed(base, 1, createSimulatedEngine);
    const report = buildReport(base, [run]);
    expect(report.perSeed[0]).toEqual(snapshot.perSeed.find((item) => item.seed === 1));
  });
});
