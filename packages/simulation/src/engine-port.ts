import type { Expectation, PatientId } from '@follow-up-engine/core';

/**
 * The engine the simulation drives, as a port: the simulation never decides
 * what is fulfilled. Every action becomes a FHIR write through the real
 * ingestion (the runtime's adapter, `createSimulatedEngine`), the engine's
 * own watcher runs on the simulated clock, and the simulation only reads
 * the expectations back. Calls arrive in non-decreasing time order.
 */

/** A test of the order catalog (`TEST_GROUPS`): its usual order code and label. */
export interface SimTest {
  readonly group: string;
  readonly kind: 'lab' | 'imaging';
  readonly loinc: string;
  readonly display: string;
}

/** What the doctor ordered at the consultation (one patient, one instant). */
export type SimOrder =
  | { readonly kind: 'lab' | 'imaging'; readonly id: string; readonly test: SimTest }
  | { readonly kind: 'visit'; readonly id: string; readonly noteText: string }
  /** An abnormal result arrived: the engine asks for a visit within 7 days. */
  | { readonly kind: 'urgent'; readonly id: string; readonly test: SimTest };

/** Who made a booking: the agent (on the patient's "yes"), reception (on a call), the patient. */
export type BookingOrigin = 'agent' | 'staff' | 'patient';

/** How a result reached the clinic. */
export type ResultChannel = 'lab' | 'patient_photo' | 'patient_brought';

export interface SimulatedEngine {
  /** Registers the patient and ingests the consultation's orders at `at`. */
  placeOrders(input: {
    readonly patientId: PatientId;
    readonly name: string;
    readonly at: Date;
    readonly orders: readonly SimOrder[];
  }): Promise<void>;
  /** A visit booked for `start` (an `Appointment`). */
  bookVisit(input: {
    readonly patientId: PatientId;
    readonly appointmentId: string;
    readonly start: Date;
    readonly end: Date;
    readonly at: Date;
    readonly origin: BookingOrigin;
  }): Promise<void>;
  /** The patient attended a visit (a finished `Encounter`). */
  recordVisit(input: {
    readonly patientId: PatientId;
    readonly encounterId: string;
    readonly at: Date;
  }): Promise<void>;
  /** A result of `test` (an `Observation`), taken at `effectiveAt`, received at `at`. */
  recordResult(input: {
    readonly patientId: PatientId;
    readonly resultId: string;
    readonly test: SimTest;
    readonly effectiveAt: Date;
    readonly at: Date;
    readonly channel: ResultChannel;
  }): Promise<void>;
  /** The engine's deadline watcher at `at` (expiry, lapsed bookings). */
  runWatcher(at: Date): Promise<void>;
  /** Every expectation of the patient, as the engine has them now. */
  expectations(patientId: PatientId): Promise<readonly Expectation[]>;
}

/** Builds a fresh engine (empty clinic, its own clock at `start`) for one seeded run. */
export type SimulatedEngineFactory = (options: {
  readonly start: Date;
  readonly timeZone: string;
}) => Promise<SimulatedEngine>;

/**
 * How an order got done, encoded in the id of every resource the
 * simulation writes. The engine stores which resource closed an
 * expectation (`closedBy`), so the report reads the path from the engine's
 * own record: `agent` (booked on the patient's "yes" to the agent),
 * `staff` (booked on a reception or doctor call the agent asked for),
 * `photo` (an outside result the patient sent the agent), `reminder`
 * (control arm: the patient acted on a generic reminder), `self` (no
 * contact at all: the patient did it on their own).
 */
export const FULFILMENT_PATHS = ['agent', 'staff', 'photo', 'reminder', 'self'] as const;
export type FulfilmentPath = (typeof FULFILMENT_PATHS)[number];

/** `sim-<path>-<kind>-<patient>-<n>`: a deterministic resource id that carries its path. */
export function simResourceId(
  path: FulfilmentPath,
  kind: 'appt' | 'visit' | 'result',
  patientId: string,
  serial: number,
): string {
  return `sim-${path}-${kind}-${patientId}-${String(serial)}`;
}

/** The path a resource id written by {@link simResourceId} carries, if any. */
export function pathOfResourceId(id: string): FulfilmentPath | undefined {
  const match = /^sim-([a-z]+)-/.exec(id);
  const path = match?.[1];
  return FULFILMENT_PATHS.find((candidate) => candidate === path);
}
