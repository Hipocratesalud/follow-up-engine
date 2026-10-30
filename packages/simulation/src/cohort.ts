import {
  addLocalDays,
  type PatientId,
  patientId as toPatientId,
  TEST_GROUPS,
  zonedInstant,
} from '@follow-up-engine/core';
import type { OrderSpec, Persona, PersonaId, SimulationConfig } from './config.ts';
import type { SimOrder, SimTest } from './engine-port.ts';
import { createRng, hashUnit, type Rng } from './rng.ts';

/** The two arms: fixed reminders (usual care), or the order agent. */
export const ARMS = ['control', 'agent'] as const;
export type Arm = (typeof ARMS)[number];

/**
 * Deterministic arm assignment by hash of the patient id (V2 PRD,
 * workstream B: "deterministic by hash of patient_id, configurable
 * percentage"). The share is 50 % here; the PRD's production default is 10 %.
 */
export function assignArm(patientId: string, controlShare: number): Arm {
  return hashUnit(`arm:${patientId}`) < controlShare ? 'control' : 'agent';
}

export interface SimPatient {
  readonly id: PatientId;
  readonly name: string;
  readonly arm: Arm;
  readonly persona: PersonaId;
  /** When the doctor placed the orders (the consultation). */
  readonly orderedAt: Date;
  readonly orders: readonly SimOrder[];
  /** For each test order id: whether it was done at an outside lab. */
  readonly doneElsewhere: ReadonlySet<string>;
  /**
   * For each order id the patient completes with no contact at all: how many
   * days after its start (the order for a test or an urgent visit, a week
   * before the due date for a control visit).
   */
  readonly selfCompletionDays: ReadonlyMap<string, number>;
}

export function testOf(groupId: string): SimTest {
  const group = TEST_GROUPS.find((item) => item.id === groupId);
  const loinc = group?.loinc[0];
  if (group === undefined || loinc === undefined) {
    throw new Error(`Test group ${groupId} has no LOINC order code`);
  }
  return { group: group.id, kind: group.kind, loinc, display: group.label };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[rng.int(0, items.length - 1)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function orderOf(spec: OrderSpec, rng: Rng, id: string): SimOrder {
  switch (spec.kind) {
    case 'lab':
    case 'imaging':
    case 'urgent':
      return { kind: spec.kind, id, test: testOf(pick(rng, spec.tests)) };
    case 'visit':
      return { kind: 'visit', id, noteText: pick(rng, spec.notes) };
  }
}

export function personaById(config: SimulationConfig, id: PersonaId): Persona {
  const persona = config.personas.find((item) => item.id === id);
  if (persona === undefined) throw new Error(`Unknown persona ${id}`);
  return persona;
}

/**
 * The cohort of one seeded run: patients drawn one by one (persona, order
 * set, consultation day) and assigned to an arm by hash of their id, until
 * both arms hold `patientsPerArm`. What a patient is like does not depend
 * on their arm: the same draws whichever arm the hash puts them in.
 */
export function buildCohort(config: SimulationConfig, seed: number): readonly SimPatient[] {
  const { cohort } = config;
  const start = new Date(cohort.start).getTime();
  const personaWeights = config.personas.map((persona) => persona.weight);
  const setWeights = config.orderSets.map((set) => set.weight);
  const counts: Record<Arm, number> = { control: 0, agent: 0 };
  const patients: SimPatient[] = [];
  for (let index = 0; counts.control + counts.agent < 2 * cohort.patientsPerArm; index += 1) {
    const id = toPatientId(`s${String(seed)}p${String(index).padStart(4, '0')}`);
    const arm = assignArm(id, cohort.controlShare);
    if (counts[arm] >= cohort.patientsPerArm) continue;
    counts[arm] += 1;
    const rng = createRng(`${String(seed)}:${id}:profile`);
    const persona = config.personas[rng.weighted(personaWeights)];
    const set = config.orderSets[rng.weighted(setWeights)];
    if (persona === undefined || set === undefined) throw new Error('empty weights');
    // The consultation: a day of the enrolment window, during clinic hours (local time).
    const day = rng.int(0, cohort.enrolmentDays - 1);
    const local = addLocalDays(new Date(start), day, cohort.timeZone);
    const orderedAt = zonedInstant(local, rng.int(9, 16), 0, cohort.timeZone);
    const orders = set.orders.map((spec, position) =>
      orderOf(spec, rng, `${id}-o${String(position)}`),
    );
    const doneElsewhere = new Set<string>();
    const selfCompletionDays = new Map<string, number>();
    for (const order of orders) {
      if (
        (order.kind === 'lab' || order.kind === 'imaging') &&
        rng.chance(persona.testDoneElsewhere)
      ) {
        doneElsewhere.add(order.id);
      }
      const factor = order.kind === 'urgent' ? config.operations.urgentSelfCompletionFactor : 1;
      const draw = rng.next();
      const [min, max] = persona.selfCompletion.days;
      const offset = min + rng.next() * (max - min);
      if (draw < persona.selfCompletion.probability * factor) {
        selfCompletionDays.set(order.id, offset);
      }
    }
    patients.push({
      id,
      name: `Synthetic patient ${id}`,
      arm,
      persona: persona.id,
      orderedAt,
      orders,
      doneElsewhere,
      selfCompletionDays,
    });
  }
  return patients;
}
