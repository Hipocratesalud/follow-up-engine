import { describe, expect, it } from 'vitest';
import { Agenda } from './agenda.ts';
import { assignArm, buildCohort } from './cohort.ts';
import { PERSONA_IDS, type SimulationConfig } from './config.ts';
import { pathOfResourceId, simResourceId } from './engine-port.ts';
import { intervalOf } from './report.ts';
import { createRng } from './rng.ts';

/** Pure parts of the simulation; the runs over the real engine are in packages/runtime. */

const persona = (id: (typeof PERSONA_IDS)[number]): SimulationConfig['personas'][number] => ({
  id,
  weight: 1,
  summary: id,
  rationale: 'ASSUMPTION: test',
  delivery: 'ok',
  engage: [0.5],
  slotFit: { earliest: 0.5, other_time: 0.5, saturday: 0.5 },
  selfBooksAfterReminder: 0.5,
  answersCall: 0.5,
  optOutOnReply: 0,
  testDoneElsewhere: 0,
  sendsPhoto: 0,
  selfCompletion: { probability: 0.5, days: [1, 10] },
  showUp: 0.8,
});

const config: SimulationConfig = {
  version: 'test',
  notice: 'test',
  cohort: {
    patientsPerArm: 50,
    controlShare: 0.5,
    enrolmentDays: 10,
    horizonDays: 30,
    start: '2026-01-05T09:00:00Z',
    timeZone: 'America/Caracas',
    seeds: 1,
  },
  orderSets: [
    { id: 'lab', weight: 1, orders: [{ kind: 'lab', tests: ['hba1c'] }] },
    { id: 'urgent', weight: 1, orders: [{ kind: 'urgent', tests: ['renal'] }] },
  ],
  personas: PERSONA_IDS.map(persona),
  operations: {
    staffCompletesTask: 1,
    phoneFoundByReception: 1,
    otherContactReached: 1,
    callBooks: 1,
    keepsTalking: 1,
    replyDelayHours: [1, 2],
    labResultLagDays: [1, 2],
    imagingResultLagDays: [1, 2],
    selfBookLeadDays: [1, 2],
    photoAgeDays: [1, 2],
    visitWindowDays: 14,
    urgentSelfCompletionFactor: 0.5,
  },
  economics: { consultationPrice: 40, currency: 'USD', patientsPerMonth: 100 },
  assumptions: ['ASSUMPTION: test'],
};

describe('seeded randomness', () => {
  it('repeats a stream for the same seed and differs for another', () => {
    const draws = (seed: string): number[] => {
      const rng = createRng(seed);
      return Array.from({ length: 5 }, () => rng.next());
    };
    expect(draws('a')).toEqual(draws('a'));
    expect(draws('a')).not.toEqual(draws('b'));
    for (const value of draws('c')) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('honours probabilities and weights roughly', () => {
    const rng = createRng('rates');
    let hits = 0;
    const counts = [0, 0, 0];
    for (let index = 0; index < 20_000; index += 1) {
      if (rng.chance(0.3)) hits += 1;
      const pick = rng.weighted([1, 2, 1]);
      counts[pick] = (counts[pick] ?? 0) + 1;
    }
    expect(hits / 20_000).toBeCloseTo(0.3, 1);
    expect((counts[1] ?? 0) / 20_000).toBeCloseTo(0.5, 1);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });
});

describe('arm assignment', () => {
  it('is a deterministic hash of the patient id with the configured share', () => {
    expect(assignArm('patient-1', 0.5)).toBe(assignArm('patient-1', 0.5));
    const ids = Array.from({ length: 4000 }, (_, index) => `p${String(index)}`);
    const control = ids.filter((id) => assignArm(id, 0.5) === 'control').length / ids.length;
    expect(control).toBeGreaterThan(0.46);
    expect(control).toBeLessThan(0.54);
    const tenPercent = ids.filter((id) => assignArm(id, 0.1) === 'control').length / ids.length;
    expect(tenPercent).toBeGreaterThan(0.07);
    expect(tenPercent).toBeLessThan(0.13);
  });
});

describe('the cohort', () => {
  it('fills both arms exactly, the same way for the same seed', () => {
    const cohort = buildCohort(config, 7);
    expect(cohort.filter((patient) => patient.arm === 'control')).toHaveLength(50);
    expect(cohort.filter((patient) => patient.arm === 'agent')).toHaveLength(50);
    expect(buildCohort(config, 7)).toEqual(cohort);
    expect(buildCohort(config, 8).map((patient) => patient.id)).not.toEqual(
      cohort.map((patient) => patient.id),
    );
    for (const patient of cohort) {
      expect(patient.arm).toBe(assignArm(patient.id, 0.5));
      const start = new Date(config.cohort.start).getTime();
      expect(patient.orderedAt.getTime()).toBeGreaterThanOrEqual(start);
      expect(patient.orderedAt.getTime()).toBeLessThan(start + 11 * 86_400_000);
    }
  });

  it('takes tests from the engine catalog with their LOINC order code', () => {
    const tests = buildCohort(config, 1).flatMap((patient) =>
      patient.orders.flatMap((order) => (order.kind === 'visit' ? [] : [order.test])),
    );
    expect(new Set(tests.map((test) => test.loinc))).toEqual(new Set(['4548-4', '2160-0']));
  });
});

describe('the agenda', () => {
  it('runs actions in time order, ties in scheduling order, and stops before the end', async () => {
    const agenda = new Agenda();
    const seen: string[] = [];
    const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 5, 0, minutes));
    agenda.at(at(10), () => {
      seen.push('b');
      agenda.at(at(5), () => {
        seen.push('late');
        return Promise.resolve();
      });
      return Promise.resolve();
    });
    agenda.at(at(1), () => {
      seen.push('a');
      return Promise.resolve();
    });
    agenda.at(at(10), () => {
      seen.push('c');
      return Promise.resolve();
    });
    agenda.at(at(60), () => {
      seen.push('never');
      return Promise.resolve();
    });
    await agenda.runUntil(at(30));
    // An action scheduled in the past runs at the current instant, after those already due.
    expect(seen).toEqual(['a', 'b', 'c', 'late']);
  });
});

describe('fulfilment paths', () => {
  it('round-trips through the resource id', () => {
    expect(pathOfResourceId(simResourceId('photo', 'result', 's1p0001', 3))).toBe('photo');
    expect(pathOfResourceId(`${simResourceId('agent', 'appt', 's1p0001', 1)}-appt`)).toBe('agent');
    expect(pathOfResourceId('appointment-from-the-host')).toBeUndefined();
  });
});

describe('intervals', () => {
  it('reports the mean and the 2.5th and 97.5th percentiles', () => {
    const interval = intervalOf(Array.from({ length: 41 }, (_, index) => index));
    expect(interval.mean).toBe(20);
    expect(interval.low).toBeCloseTo(1, 5);
    expect(interval.high).toBeCloseTo(39, 5);
    expect(intervalOf([0.5])).toEqual({ mean: 0.5, low: 0.5, high: 0.5 });
  });
});
