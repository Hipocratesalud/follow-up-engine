/**
 * `GET /api/inbox/value/simulation`: the 90-day outcome simulation report
 * (docs/simulation.md), the fields the Value view reads. Mirrors
 * `SimulationReport` of packages/simulation/src/report.ts (the inbox talks
 * HTTP only, so the shape is restated here).
 */

export const SIMULATION_PERSONA_IDS = [
  'fast_responder',
  'second_try',
  'slot_friction',
  'wrong_number',
  'reads_never_answers',
  'never_answers',
  'opts_out',
  'elsewhere_photo',
] as const;
export type SimulationPersonaId = (typeof SIMULATION_PERSONA_IDS)[number];

export const SIMULATION_ORDER_KINDS = ['lab', 'imaging', 'visit', 'urgent'] as const;
export type SimulationOrderKind = (typeof SIMULATION_ORDER_KINDS)[number];

export const SIMULATION_TASK_KINDS = [
  'call_patient',
  'doctor_notice',
  'update_phone',
  'call_other_contact',
] as const;
export type SimulationTaskKind = (typeof SIMULATION_TASK_KINDS)[number];

/** Mean over seeded runs and the 95 % interval across them. */
export interface Interval {
  mean: number;
  low: number;
  high: number;
}

export interface SimulationArmView {
  orders: Interval;
  fulfilledShare: Interval;
  medianDaysToFulfilment: Interval;
  byKind: Record<SimulationOrderKind, { orders: Interval; fulfilledShare: Interval }>;
  urgentWithin7Share: Interval;
  urgentWithin14Share: Interval;
  unreachableShare: Interval;
  markedUnreachableShare: Interval;
  optedOutShare: Interval;
  tasksPer100: Record<SimulationTaskKind | 'total', Interval>;
  callsAnsweredPer100: Interval;
  messagesPerPatient: Interval;
  proactivePerPatient: Interval;
  maxProactiveIn7Days: number;
  consultationsBookedPer100: Interval;
  consultationsAttendedPer100: Interval;
  labVisitsAttendedPer100: Interval;
}

export interface SimulationPersonaView {
  persona: SimulationPersonaId;
  weight: number;
  control: Interval;
  agent: Interval;
  difference: Interval;
}

export interface SimulationReportView {
  reportVersion: string;
  configVersion: string;
  fingerprint: string;
  notice: string;
  seeds: number[];
  cohort: { patientsPerArm: number; horizonDays: number; enrolmentDays: number; seeds: number };
  arms: { control: SimulationArmView; agent: SimulationArmView };
  difference: {
    fulfilledShare: Interval;
    medianDaysToFulfilment: Interval;
    urgentWithin7Share: Interval;
    urgentWithin14Share: Interval;
    consultationsAttendedPer100: Interval;
    unreachableShare: Interval;
  };
  personas: SimulationPersonaView[];
  economics: {
    consultationPrice: number;
    currency: string;
    patientsPerMonth: number;
    recoveredConsultationsPerPatient: Interval;
  };
  invariants: { maxProactiveIn7Days: number; controlAgentActions: number };
}

/** A size not computed yet: the API runs it in the background. */
export interface SimulationRunning {
  status: 'running';
  seedsDone: number;
  seeds: number;
}

export type SimulationResponse = SimulationReportView | SimulationRunning;

export function isRunning(response: SimulationResponse): response is SimulationRunning {
  return 'status' in response;
}
