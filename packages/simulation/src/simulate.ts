import {
  addLocalDays,
  type AgentConversation,
  type AgentMessage,
  availableSlots,
  type ClinicId,
  contactPolicy,
  describeOrder,
  dueRungs,
  type Expectation,
  type ExpectationId,
  isAgentOwned,
  isPending,
  isUrgentOrder,
  LADDER,
  type LadderRung,
  type LadderState,
  type LadderTrack,
  MIN_LEAD_HOURS,
  rungDueAt,
  type Slot,
  type SlotPreference,
  type SlotResourceKind,
  type StaffTaskKind,
  startTrack,
  UNREACHABLE_RETRY_DAYS,
  zonedInstant,
} from '@follow-up-engine/core';
import { Agenda } from './agenda.ts';
import { type Arm, buildCohort, personaById, type SimPatient } from './cohort.ts';
import type { OrderKind, Persona, PersonaId, SimulationConfig, SlotFit } from './config.ts';
import {
  type BookingOrigin,
  type FulfilmentPath,
  pathOfResourceId,
  type SimOrder,
  type SimulatedEngine,
  type SimulatedEngineFactory,
  simResourceId,
} from './engine-port.ts';
import { createRng, type Rng } from './rng.ts';

/**
 * One seeded 90-day run (docs/simulation.md#method). Both arms live in the
 * same simulated clinic and the same engine; only what happens between the
 * order and its completion differs:
 *
 * - control: one generic reminder when an order is due and one 7 days
 *   later, under the same contact cap; no booking help, no ladder, no staff
 *   task. The patient books or does it on their own, or not.
 * - agent: the order agent's real policy from core — the no-response
 *   ladder (`LADDER`, `dueRungs`, `startTrack`), the contact cap
 *   (`contactPolicy`: at most 2 proactive messages per 7 days), the urgent
 *   track, the undelivered track, slots from the synthetic schedule
 *   (`availableSlots`), booking on the patient's "yes", staff call tasks,
 *   outside results by photo. The patient's side of the conversation is a
 *   persona model (no LLM): it decides whether they reply, whether a slot
 *   fits, whether they opt out or send a photo.
 *
 * Fulfilment is never decided here: bookings, visits and results become
 * FHIR writes through the engine, its watcher runs daily, and the outcome of
 * every order is read back from the engine's expectations at the end.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SIM_CLINIC = 'clinic-sim' as ClinicId;

/** What happened to one patient, for the report's averages and the tests' invariants. */
export interface PatientTrace {
  readonly patientId: string;
  readonly arm: Arm;
  readonly persona: PersonaId;
  /** Messages sent to the patient (proactive and replies), delivered or not. */
  outbound: number;
  proactive: number;
  /** The most proactive messages in any rolling 7 days (the cap is 2). */
  maxProactiveIn7Days: number;
  undelivered: number;
  /** Messages from the patient. */
  inbound: number;
  callsMade: number;
  callsAnswered: number;
  readonly tasks: Record<StaffTaskKind, number>;
  /** Actions only the agent arm has (offers, bookings on a "yes", tasks, photo results). */
  agentActions: number;
  optedOut: boolean;
  /** The ladder ended unreachable at least once. */
  markedUnreachable: boolean;
  consultationsBooked: number;
  consultationsAttended: number;
  labVisitsAttended: number;
  /** Proactive message instants (epoch ms), for the cap invariant. */
  readonly proactiveAt: number[];
}

/** One order (an agent-owned engine expectation) and what the engine says about it at the end. */
export interface OrderOutcome {
  readonly patientId: string;
  readonly arm: Arm;
  readonly persona: PersonaId;
  readonly kind: OrderKind;
  readonly ruleId: string;
  readonly createdAt: Date;
  readonly dueAt: Date;
  readonly status: Expectation['status'];
  readonly closedAt?: Date;
  /** How it was fulfilled, read from the resource that closed it. */
  readonly path?: FulfilmentPath;
}

export interface SeedRun {
  readonly seed: number;
  readonly patients: readonly PatientTrace[];
  readonly orders: readonly OrderOutcome[];
  /** Orders whose engine expectation could not be found (should be 0). */
  readonly unmappedOrders: number;
}

interface Booking {
  readonly kind: SlotResourceKind;
  readonly start: Date;
  readonly orders: readonly ExpectationId[];
}

interface Conversation {
  status: AgentConversation['status'];
  phoneStatus: AgentConversation['phoneStatus'];
  ladder: LadderState;
  retryAt?: Date;
  flagAtNextContact?: boolean;
}

type Stage = 'contacted' | 'booked' | 'result_received' | 'unreachable';

interface Offer {
  readonly preference: SlotPreference;
  readonly slots: ReadonlyMap<SlotResourceKind, Slot>;
}

interface PatientState {
  readonly patient: SimPatient;
  readonly persona: Persona;
  readonly rng: Rng;
  readonly trace: PatientTrace;
  /** Engine expectation id → the order the simulation placed. */
  readonly orders: Map<ExpectationId, SimOrder>;
  readonly messages: AgentMessage[];
  readonly bookings: Booking[];
  readonly stages: Map<ExpectationId, Stage>;
  readonly offered: Slot[];
  /** Messages that reached the patient: indexes the persona's `engage` curve. */
  delivered: number;
  phoneFixed: boolean;
  conversation?: Conversation;
  /** Bumped on every ladder change: a scheduled tick of an older version is stale. */
  ladderVersion: number;
  serial: number;
  /** Control arm: reminders already sent, by `<expectation>:<index>`. */
  readonly reminded: Set<string>;
  controlOptedOut: boolean;
}

function emptyTrace(patient: SimPatient): PatientTrace {
  return {
    patientId: patient.id,
    arm: patient.arm,
    persona: patient.persona,
    outbound: 0,
    proactive: 0,
    maxProactiveIn7Days: 0,
    undelivered: 0,
    inbound: 0,
    callsMade: 0,
    callsAnswered: 0,
    tasks: { call_patient: 0, update_phone: 0, call_other_contact: 0, doctor_notice: 0 },
    agentActions: 0,
    optedOut: false,
    markedUnreachable: false,
    consultationsBooked: 0,
    consultationsAttended: 0,
    labVisitsAttended: 0,
    proactiveAt: [],
  };
}

function uniform(rng: Rng, [min, max]: readonly [number, number]): number {
  return min + rng.next() * (max - min);
}

function engageProbability(persona: Persona, index: number): number {
  return persona.engage[Math.min(index, persona.engage.length - 1)] ?? 0;
}

function fitOf(preference: SlotPreference): SlotFit {
  return preference === 'nearer_lab' ? 'other_time' : preference;
}

/** The next kind of slot the agent offers after a "that time does not work". */
function alternativeTo(preference: SlotPreference): SlotPreference {
  switch (preference) {
    case 'earliest':
    case 'nearer_lab':
      return 'other_time';
    case 'other_time':
      return 'saturday';
    case 'saturday':
      return 'other_time';
  }
}

function resourceKindOf(order: SimOrder): SlotResourceKind {
  return order.kind === 'lab' || order.kind === 'imaging' ? 'lab' : 'professional';
}

/** Runs one seed of the simulation over a fresh engine. */
export async function runSeed(
  config: SimulationConfig,
  seed: number,
  createEngine: SimulatedEngineFactory,
  options: { readonly pause?: () => Promise<void> } = {},
): Promise<SeedRun> {
  const { cohort, operations } = config;
  const start = new Date(cohort.start);
  const end = new Date(start.getTime() + cohort.horizonDays * DAY_MS);
  const timeZone = cohort.timeZone;
  const engine: SimulatedEngine = await createEngine({ start, timeZone });
  const agenda = new Agenda();
  const states: PatientState[] = [];
  let unmappedOrders = 0;

  // --- engine reads ------------------------------------------------------------------

  async function owned(state: PatientState): Promise<Expectation[]> {
    const expectations = await engine.expectations(state.patient.id);
    return expectations.filter((item) => state.orders.has(item.id));
  }

  async function pendingOwned(state: PatientState): Promise<Expectation[]> {
    return (await owned(state)).filter(isPending);
  }

  // --- messages (both arms, same cap) ------------------------------------------------

  function canSend(
    state: PatientState,
    conversation: Pick<Conversation, 'status' | 'phoneStatus'>,
    at: Date,
  ) {
    return contactPolicy(conversation, state.messages, at);
  }

  function recordOutbound(
    state: PatientState,
    at: Date,
    proactive: boolean,
    rung?: string,
  ): AgentMessage {
    state.serial += 1;
    const message: AgentMessage = {
      id: `${state.patient.id}-m${String(state.serial)}`,
      clinicId: SIM_CLINIC,
      patientId: state.patient.id,
      direction: 'outbound',
      kind: 'text',
      text: rung ?? 'reply',
      at,
      proactive,
      ...(rung === undefined ? {} : { rung }),
    };
    state.messages.push(message);
    state.trace.outbound += 1;
    if (proactive) {
      state.trace.proactive += 1;
      state.trace.proactiveAt.push(at.getTime());
      const windowStart = at.getTime() - 7 * DAY_MS;
      const inWindow = state.trace.proactiveAt.filter((time) => time > windowStart).length;
      state.trace.maxProactiveIn7Days = Math.max(state.trace.maxProactiveIn7Days, inWindow);
    }
    return message;
  }

  function recordInbound(state: PatientState, at: Date): void {
    state.serial += 1;
    state.messages.push({
      id: `${state.patient.id}-m${String(state.serial)}`,
      clinicId: SIM_CLINIC,
      patientId: state.patient.id,
      direction: 'inbound',
      kind: 'text',
      text: 'reply',
      at,
    });
    state.trace.inbound += 1;
  }

  function nextId(
    state: PatientState,
    path: FulfilmentPath,
    kind: 'appt' | 'visit' | 'result',
  ): string {
    state.serial += 1;
    return simResourceId(path, kind, state.patient.id, state.serial);
  }

  // --- completing orders (writes go to the engine) ----------------------------------

  function testsOf(state: PatientState, ids: readonly ExpectationId[]) {
    return ids.flatMap((id) => {
      const order = state.orders.get(id);
      return order !== undefined && (order.kind === 'lab' || order.kind === 'imaging')
        ? [order]
        : [];
    });
  }

  function slotFor(
    kind: SlotResourceKind,
    at: Date,
    preference: SlotPreference,
    urgent: boolean,
    previouslyOffered: readonly Slot[],
  ): Slot | undefined {
    return availableSlots({
      now: at,
      timeZone,
      kind,
      preference,
      urgent,
      previouslyOffered,
      count: 1,
    })[0];
  }

  /** A visit at `start` and/or a lab visit at `labStart`, booked by `origin`; attendance by the persona. */
  async function book(
    state: PatientState,
    at: Date,
    orderIds: readonly ExpectationId[],
    origin: BookingOrigin,
    path: FulfilmentPath,
    offer?: Offer,
  ): Promise<void> {
    const byKind = new Map<SlotResourceKind, ExpectationId[]>();
    let urgent = false;
    for (const id of orderIds) {
      const order = state.orders.get(id);
      if (order === undefined) continue;
      if (order.kind === 'urgent') urgent = true;
      const kind = resourceKindOf(order);
      byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    }
    for (const [kind, ids] of byKind) {
      const offered = offer?.slots.get(kind);
      const slot =
        offered !== undefined && offered.start.getTime() >= at.getTime() + MIN_LEAD_HOURS * HOUR_MS
          ? offered
          : slotFor(kind, at, 'earliest', urgent, []);
      if (slot === undefined) continue;
      state.bookings.push({ kind, start: slot.start, orders: ids });
      for (const id of ids) state.stages.set(id, 'booked');
      if (kind === 'professional') {
        state.trace.consultationsBooked += 1;
        await engine.bookVisit({
          patientId: state.patient.id,
          appointmentId: nextId(state, path, 'appt'),
          start: slot.start,
          end: slot.end,
          at,
          origin,
        });
      }
      const attends = state.rng.chance(state.persona.showUp);
      if (!attends) continue;
      agenda.at(slot.start, async () => {
        if (kind === 'professional') {
          state.trace.consultationsAttended += 1;
          await engine.recordVisit({
            patientId: state.patient.id,
            encounterId: nextId(state, path, 'visit'),
            at: slot.start,
          });
          return;
        }
        state.trace.labVisitsAttended += 1;
        for (const order of testsOf(state, ids)) {
          const lag = uniform(
            state.rng,
            order.test.kind === 'imaging'
              ? operations.imagingResultLagDays
              : operations.labResultLagDays,
          );
          const receivedAt = new Date(slot.start.getTime() + lag * DAY_MS);
          agenda.at(receivedAt, () =>
            engine.recordResult({
              patientId: state.patient.id,
              resultId: nextId(state, path, 'result'),
              test: order.test,
              effectiveAt: slot.start,
              at: receivedAt,
              channel: 'lab',
            }),
          );
        }
      });
    }
  }

  /** The patient does it on their own (control after a reminder, or with no contact at all). */
  async function selfAct(
    state: PatientState,
    at: Date,
    expectations: readonly Expectation[],
    path: 'reminder' | 'self',
  ): Promise<void> {
    for (const expectation of expectations) {
      const order = state.orders.get(expectation.id);
      if (order === undefined) continue;
      const elsewhere = state.patient.doneElsewhere.has(order.id);
      const lead = path === 'self' ? 0 : uniform(state.rng, operations.selfBookLeadDays) * DAY_MS;
      const when = new Date(at.getTime() + lead);
      if (order.kind === 'visit' || order.kind === 'urgent') {
        if (path === 'reminder') {
          // Booked by phone for a later day; the visit happens if they show up.
          state.trace.consultationsBooked += 1;
          await engine.bookVisit({
            patientId: state.patient.id,
            appointmentId: nextId(state, path, 'appt'),
            start: when,
            end: new Date(when.getTime() + 30 * 60_000),
            at,
            origin: 'patient',
          });
          state.stages.set(expectation.id, 'booked');
          if (!state.rng.chance(state.persona.showUp)) continue;
        }
        agenda.at(when, async () => {
          state.trace.consultationsAttended += 1;
          await engine.recordVisit({
            patientId: state.patient.id,
            encounterId: nextId(state, path, 'visit'),
            at: when,
          });
        });
        continue;
      }
      if (elsewhere) {
        // An outside result: the patient brings the paper (no lab visit here).
        agenda.at(when, () =>
          engine.recordResult({
            patientId: state.patient.id,
            resultId: nextId(state, path, 'result'),
            test: order.test,
            effectiveAt: new Date(
              Math.max(state.patient.orderedAt.getTime() + HOUR_MS, when.getTime() - 2 * DAY_MS),
            ),
            at: when,
            channel: 'patient_brought',
          }),
        );
        continue;
      }
      if (path === 'reminder' && !state.rng.chance(state.persona.showUp)) continue;
      const lag = uniform(
        state.rng,
        order.test.kind === 'imaging'
          ? operations.imagingResultLagDays
          : operations.labResultLagDays,
      );
      const receivedAt = new Date(when.getTime() + lag * DAY_MS);
      agenda.at(when, () => {
        state.trace.labVisitsAttended += 1;
        agenda.at(receivedAt, () =>
          engine.recordResult({
            patientId: state.patient.id,
            resultId: nextId(state, path, 'result'),
            test: order.test,
            effectiveAt: when,
            at: receivedAt,
            channel: 'lab',
          }),
        );
        return Promise.resolve();
      });
    }
  }

  function upcomingBooking(state: PatientState, kind: SlotResourceKind, at: Date): boolean {
    return state.bookings.some(
      (booking) => booking.kind === kind && booking.start.getTime() > at.getTime(),
    );
  }

  /** Self-completion with no contact at all: the same draw in both arms. */
  function scheduleSelfCompletion(
    state: PatientState,
    expectation: Expectation,
    order: SimOrder,
  ): void {
    const days = state.patient.selfCompletionDays.get(order.id);
    if (days === undefined) return;
    const base =
      order.kind === 'visit'
        ? Math.max(state.patient.orderedAt.getTime(), expectation.dueAt.getTime() - 7 * DAY_MS)
        : state.patient.orderedAt.getTime();
    const at = new Date(base + days * DAY_MS);
    const expectationId = expectation.id;
    if (at.getTime() >= end.getTime()) return;
    agenda.at(at, async () => {
      const pending = (await pendingOwned(state)).find((item) => item.id === expectationId);
      if (pending === undefined) return;
      // Already booked for later: they go to that appointment instead.
      if (upcomingBooking(state, resourceKindOf(order), at)) return;
      await selfAct(state, at, [pending], 'self');
    });
  }

  // --- control arm: fixed reminders --------------------------------------------------

  function scheduleControlReminders(state: PatientState, expectation: Expectation): void {
    for (const [index, offsetDays] of [0, 7].entries()) {
      const at = new Date(expectation.dueAt.getTime() + offsetDays * DAY_MS);
      if (at.getTime() >= end.getTime()) continue;
      agenda.at(at, () => controlReminder(state, at, index));
    }
  }

  async function controlReminder(state: PatientState, at: Date, index: number): Promise<void> {
    if (state.controlOptedOut) return;
    // One reminder covers every order of the patient due for this reminder now (±12 h).
    const pending = (await pendingOwned(state)).filter((item) => {
      const slot = item.dueAt.getTime() + (index === 0 ? 0 : 7 * DAY_MS);
      return (
        Math.abs(slot - at.getTime()) <= 12 * HOUR_MS &&
        !state.reminded.has(`${item.id}:${String(index)}`)
      );
    });
    if (pending.length === 0) return;
    for (const item of pending) state.reminded.add(`${item.id}:${String(index)}`);
    // The fixed reminder honours the same cap; a wrong number simply does not receive it.
    const policy = canSend(state, { status: 'active', phoneStatus: 'ok' }, at);
    if (!policy.canSend) return;
    recordOutbound(state, at, true, `reminder:${String(index)}`);
    if (state.persona.delivery === 'undelivered') {
      state.trace.undelivered += 1;
      return;
    }
    const engaged = state.rng.chance(engageProbability(state.persona, state.delivered));
    state.delivered += 1;
    if (!engaged) return;
    const replyAt = new Date(
      at.getTime() + uniform(state.rng, operations.replyDelayHours) * HOUR_MS,
    );
    agenda.at(replyAt, async () => {
      recordInbound(state, replyAt);
      if (state.rng.chance(state.persona.optOutOnReply)) {
        state.controlOptedOut = true;
        state.trace.optedOut = true;
        return;
      }
      if (!state.rng.chance(state.persona.selfBooksAfterReminder)) return;
      const still = (await pendingOwned(state)).filter((item) =>
        pending.some((p) => p.id === item.id),
      );
      await selfAct(state, replyAt, still, 'reminder');
    });
  }

  // --- agent arm: the order agent's policy ------------------------------------------

  function chasable(order: SimOrder, expectation: Expectation, at: Date): boolean {
    if (order.kind !== 'visit') return true;
    return at.getTime() >= expectation.dueAt.getTime() - operations.visitWindowDays * DAY_MS;
  }

  /** Orders the agent still has to move: owned, pending, in their window, not booked or answered. */
  async function chasing(state: PatientState, at: Date): Promise<Expectation[]> {
    const pending = await pendingOwned(state);
    return pending.filter((expectation) => {
      const order = state.orders.get(expectation.id);
      if (order === undefined || !chasable(order, expectation, at)) return false;
      // Like the service, a booked or answered order stays covered (no re-chasing after a no-show).
      const stage = state.stages.get(expectation.id);
      if (stage === 'booked' || stage === 'result_received' || stage === 'unreachable')
        return false;
      // A visit order is covered by any visit already booked.
      if (resourceKindOf(order) === 'professional' && upcomingBooking(state, 'professional', at))
        return false;
      return true;
    });
  }

  function scheduleTick(state: PatientState): void {
    const conversation = state.conversation;
    if (conversation === undefined) return;
    const version = ++state.ladderVersion;
    let next: Date | undefined;
    if (conversation.status === 'unreachable' && conversation.retryAt !== undefined) {
      next = conversation.retryAt;
    } else if (conversation.status === 'active') {
      const lastInbound = state.messages.findLast((message) => message.direction === 'inbound');
      if (
        conversation.ladder.track !== 'undelivered' &&
        lastInbound !== undefined &&
        lastInbound.at.getTime() >= conversation.ladder.anchorAt.getTime()
      ) {
        // The patient wrote since the anchor: the ladder waits for the agent's next message.
        return;
      }
      next = LADDER[conversation.ladder.track]
        .filter((rung) => !conversation.ladder.done.includes(rung.id))
        .map((rung) => rungDueAt(conversation.ladder, rung))
        .sort((left, right) => left.getTime() - right.getTime())[0];
    }
    if (next === undefined || next.getTime() >= end.getTime()) return;
    // A rung due in the past that `dueRungs` did not return would loop: tick no earlier than a minute on.
    if (next.getTime() <= agenda.now.getTime()) next = new Date(agenda.now.getTime() + 60_000);
    agenda.at(next, () =>
      state.ladderVersion === version ? tick(state, agenda.now) : Promise.resolve(),
    );
  }

  async function startConversation(state: PatientState, at: Date): Promise<void> {
    const current = state.conversation;
    if (current !== undefined && current.status !== 'done') return;
    const orders = await chasing(state, at);
    if (orders.length === 0) return;
    const track: LadderTrack = orders.some(isUrgentOrder) ? 'urgent' : 'routine';
    state.conversation = {
      status: 'active',
      phoneStatus: current?.phoneStatus ?? 'ok',
      ladder: startTrack(track, at, { firstDone: true }),
    };
    state.trace.agentActions += 1;
    const first = LADDER[track][0];
    if (first !== undefined) await sendOffer(state, at, first);
    scheduleTick(state);
  }

  async function sendOffer(state: PatientState, at: Date, rung: LadderRung): Promise<void> {
    const conversation = state.conversation;
    if (conversation?.status !== 'active') return;
    const policy = canSend(state, conversation, at);
    if (!policy.canSend) return;
    const orders = await chasing(state, at);
    if (orders.length === 0) return;
    const preference = rung.slotPreference ?? 'earliest';
    const urgent = orders.some(isUrgentOrder);
    const slots = new Map<SlotResourceKind, Slot>();
    for (const expectation of orders) {
      const order = state.orders.get(expectation.id);
      if (order === undefined) continue;
      const kind = resourceKindOf(order);
      if (slots.has(kind)) continue;
      const slot = slotFor(kind, at, preference, urgent, state.offered);
      if (slot !== undefined) {
        slots.set(kind, slot);
        state.offered.push(slot);
      }
    }
    for (const expectation of orders) {
      if (!state.stages.has(expectation.id)) state.stages.set(expectation.id, 'contacted');
    }
    recordOutbound(state, at, policy.sendKind === 'proactive', rung.id);
    state.trace.agentActions += 1;
    await deliver(state, at, { preference, slots });
  }

  /** The channel's verdict on a message, then the persona's answer to it. */
  async function deliver(state: PatientState, at: Date, offer: Offer): Promise<void> {
    const conversation = state.conversation;
    if (conversation === undefined) return;
    if (state.persona.delivery === 'undelivered' && !state.phoneFixed) {
      state.trace.undelivered += 1;
      if (conversation.phoneStatus !== 'undelivered') {
        const resumeTrack =
          conversation.ladder.track === 'undelivered'
            ? (conversation.ladder.resumeTrack ?? 'routine')
            : conversation.ladder.track;
        conversation.phoneStatus = 'undelivered';
        conversation.ladder = startTrack('undelivered', at, { resumeTrack });
        await tick(state, at);
      }
      return;
    }
    const engaged = state.rng.chance(engageProbability(state.persona, state.delivered));
    state.delivered += 1;
    if (!engaged) return;
    const replyAt = new Date(
      at.getTime() + uniform(state.rng, operations.replyDelayHours) * HOUR_MS,
    );
    agenda.at(replyAt, () => patientReplies(state, replyAt, offer, 2));
  }

  async function patientReplies(
    state: PatientState,
    at: Date,
    offer: Offer,
    alternativesLeft: number,
  ): Promise<void> {
    recordInbound(state, at);
    const conversation = state.conversation;
    if (conversation?.status !== 'active') return;
    if (state.rng.chance(state.persona.optOutOnReply)) {
      conversation.status = 'opted_out';
      state.trace.optedOut = true;
      state.ladderVersion += 1;
      return;
    }
    let orders = await chasing(state, at);
    // An outside result: the patient sends a photo, the agent submits it, the engine decides.
    const elsewhere = orders.filter((expectation) => {
      const order = state.orders.get(expectation.id);
      return order !== undefined && state.patient.doneElsewhere.has(order.id);
    });
    if (elsewhere.length > 0 && state.rng.chance(state.persona.sendsPhoto)) {
      for (const expectation of elsewhere) {
        const order = state.orders.get(expectation.id);
        if (order === undefined || (order.kind !== 'lab' && order.kind !== 'imaging')) continue;
        const age = uniform(state.rng, operations.photoAgeDays) * DAY_MS;
        const effectiveAt = new Date(
          Math.max(state.patient.orderedAt.getTime() + HOUR_MS, at.getTime() - age),
        );
        state.stages.set(expectation.id, 'result_received');
        state.trace.agentActions += 1;
        await engine.recordResult({
          patientId: state.patient.id,
          resultId: nextId(state, 'photo', 'result'),
          test: order.test,
          effectiveAt,
          at,
          channel: 'patient_photo',
        });
      }
      orders = await chasing(state, at);
    }
    if (orders.length > 0) {
      if (state.rng.chance(state.persona.slotFit[fitOf(offer.preference)])) {
        await book(
          state,
          at,
          orders.map((item) => item.id),
          'agent',
          'agent',
          offer,
        );
        state.trace.agentActions += 1;
        recordOutbound(state, at, false);
      } else if (alternativesLeft > 0 && canSend(state, conversation, at).canSend) {
        // "That day does not work": the agent answers at once with another kind of slot.
        const preference = alternativeTo(offer.preference);
        const urgent = orders.some(isUrgentOrder);
        const slots = new Map<SlotResourceKind, Slot>();
        for (const expectation of orders) {
          const order = state.orders.get(expectation.id);
          if (order === undefined) continue;
          const kind = resourceKindOf(order);
          const slot = slotFor(kind, at, preference, urgent, state.offered);
          if (slot !== undefined && !slots.has(kind)) {
            slots.set(kind, slot);
            state.offered.push(slot);
          }
        }
        recordOutbound(state, at, false);
        state.trace.agentActions += 1;
        if (state.rng.chance(operations.keepsTalking)) {
          const next = new Date(
            at.getTime() + uniform(state.rng, operations.replyDelayHours) * HOUR_MS,
          );
          agenda.at(next, () =>
            patientReplies(state, next, { preference, slots }, alternativesLeft - 1),
          );
          return;
        }
      }
    }
    await afterTurn(state, at);
  }

  /** After a turn on a patient message: done when nothing is left to chase, else the ladder starts again. */
  async function afterTurn(state: PatientState, at: Date): Promise<void> {
    const conversation = state.conversation;
    if (conversation?.status !== 'active') return;
    const pending = await chasing(state, at);
    if (pending.length === 0) {
      conversation.status = 'done';
      state.ladderVersion += 1;
      return;
    }
    if (conversation.ladder.track !== 'undelivered') {
      // Re-anchored at the agent's answer, which comes just after the patient's message.
      const track: LadderTrack = pending.some(isUrgentOrder) ? 'urgent' : 'routine';
      conversation.ladder = startTrack(track, new Date(at.getTime() + 60_000), { firstDone: true });
    }
    scheduleTick(state);
  }

  async function tick(state: PatientState, at: Date): Promise<void> {
    const conversation = state.conversation;
    if (conversation === undefined) return;
    if (
      conversation.status === 'unreachable' &&
      conversation.retryAt !== undefined &&
      conversation.retryAt.getTime() <= at.getTime()
    ) {
      conversation.status = 'active';
      conversation.ladder = startTrack('routine', at);
      delete conversation.retryAt;
      for (const [id, stage] of state.stages) {
        if (stage === 'unreachable') state.stages.delete(id);
      }
    }
    if (conversation.status !== 'active') return;
    if ((await chasing(state, at)).length === 0) {
      conversation.status = 'done';
      state.ladderVersion += 1;
      return;
    }
    const lastInbound = state.messages.findLast((message) => message.direction === 'inbound');
    for (const rung of dueRungs(conversation.ladder, at, lastInbound?.at)) {
      if (state.conversation?.status !== 'active' || conversation.ladder.track !== rung.track)
        break;
      conversation.ladder = {
        ...conversation.ladder,
        done: [...conversation.ladder.done, rung.id],
      };
      await applyRung(state, rung, at);
    }
    scheduleTick(state);
  }

  function addTask(state: PatientState, kind: StaffTaskKind): void {
    state.trace.tasks[kind] += 1;
    state.trace.agentActions += 1;
  }

  async function applyRung(state: PatientState, rung: LadderRung, at: Date): Promise<void> {
    const conversation = state.conversation;
    if (conversation === undefined) return;
    switch (rung.action) {
      case 'message':
        await sendOffer(state, at, rung);
        return;
      case 'call_task': {
        addTask(state, 'call_patient');
        const due = new Date(at.getTime() + (rung.track === 'urgent' ? 2 : 2 * 24) * HOUR_MS);
        agenda.at(due, () => staffCall(state, due));
        return;
      }
      case 'doctor_notice': {
        addTask(state, 'doctor_notice');
        const due = new Date(at.getTime() + 3 * HOUR_MS);
        agenda.at(due, () => staffCall(state, due));
        return;
      }
      case 'update_phone_task': {
        addTask(state, 'update_phone');
        const due = new Date(at.getTime() + 4 * HOUR_MS);
        agenda.at(due, () => phoneTask(state, due, operations.phoneFoundByReception));
        return;
      }
      case 'other_contact_task': {
        addTask(state, 'call_other_contact');
        const due = new Date(at.getTime() + DAY_MS);
        agenda.at(due, () => phoneTask(state, due, operations.otherContactReached));
        return;
      }
      case 'unreachable': {
        const urgent = rung.track === 'urgent' || conversation.ladder.resumeTrack === 'urgent';
        conversation.status = 'unreachable';
        state.trace.markedUnreachable = true;
        for (const expectation of await chasing(state, at)) {
          state.stages.set(expectation.id, 'unreachable');
        }
        if (urgent) {
          conversation.flagAtNextContact = true;
        } else {
          conversation.retryAt = new Date(at.getTime() + UNREACHABLE_RETRY_DAYS * DAY_MS);
          addTask(state, 'doctor_notice');
        }
        return;
      }
    }
  }

  /** Reception (or the doctor) calls the patient about the orders still open. */
  async function staffCall(state: PatientState, at: Date): Promise<void> {
    if (!state.rng.chance(operations.staffCompletesTask)) return;
    const conversation = state.conversation;
    if (conversation?.status !== 'active') return;
    const orders = await chasing(state, at);
    if (orders.length === 0) return;
    state.trace.callsMade += 1;
    if (state.persona.delivery === 'undelivered' && !state.phoneFixed) return;
    if (!state.rng.chance(state.persona.answersCall)) return;
    state.trace.callsAnswered += 1;
    if (!state.rng.chance(operations.callBooks)) return;
    await book(
      state,
      at,
      orders.map((item) => item.id),
      'staff',
      'staff',
    );
    if ((await chasing(state, at)).length === 0) {
      conversation.status = 'done';
      state.ladderVersion += 1;
    }
  }

  /** Reception looks for the right number (or reaches another contact); on success the ladder restarts. */
  async function phoneTask(state: PatientState, at: Date, success: number): Promise<void> {
    const conversation = state.conversation;
    if (conversation?.phoneStatus !== 'undelivered') return;
    if (!state.rng.chance(operations.staffCompletesTask) || !state.rng.chance(success)) return;
    state.phoneFixed = true;
    const track = conversation.ladder.resumeTrack ?? 'routine';
    conversation.phoneStatus = 'ok';
    if (conversation.status === 'unreachable') conversation.status = 'active';
    conversation.ladder = startTrack(track, at, { firstDone: true });
    const first = LADDER[track][0];
    if (first !== undefined) await sendOffer(state, at, first);
    scheduleTick(state);
  }

  // --- the cohort ------------------------------------------------------------------

  async function place(state: PatientState): Promise<void> {
    const { patient } = state;
    await engine.placeOrders({
      patientId: patient.id,
      name: patient.name,
      at: patient.orderedAt,
      orders: patient.orders,
    });
    const expectations = (await engine.expectations(patient.id)).filter(
      (item) => isAgentOwned(item) && isPending(item),
    );
    const unlinked = [...patient.orders];
    for (const expectation of expectations) {
      const descriptor = describeOrder(expectation);
      const index = unlinked.findIndex((order) => {
        if (expectation.ruleId === 'abnormal_result_followup') return order.kind === 'urgent';
        if (descriptor.kind === 'visit') return order.kind === 'visit';
        return (
          (order.kind === 'lab' || order.kind === 'imaging') &&
          descriptor.code?.code === order.test.loinc
        );
      });
      const order = unlinked[index];
      if (order === undefined) continue;
      unlinked.splice(index, 1);
      state.orders.set(expectation.id, order);
      scheduleSelfCompletion(state, expectation, order);
      if (patient.arm === 'control') {
        scheduleControlReminders(state, expectation);
      } else if (order.kind === 'visit') {
        const opens = new Date(expectation.dueAt.getTime() - operations.visitWindowDays * DAY_MS);
        if (opens.getTime() > patient.orderedAt.getTime()) {
          agenda.at(opens, () => startConversation(state, opens));
        }
      }
    }
    unmappedOrders += unlinked.length;
    if (patient.arm === 'agent') await startConversation(state, patient.orderedAt);
  }

  for (const patient of buildCohort(config, seed)) {
    const state: PatientState = {
      patient,
      persona: personaById(config, patient.persona),
      rng: createRng(`${String(seed)}:${patient.id}:behaviour`),
      trace: emptyTrace(patient),
      orders: new Map(),
      messages: [],
      bookings: [],
      stages: new Map(),
      offered: [],
      delivered: 0,
      phoneFixed: false,
      ladderVersion: 0,
      serial: 0,
      reminded: new Set(),
      controlOptedOut: false,
    };
    states.push(state);
    agenda.at(patient.orderedAt, () => place(state));
  }
  // The engine's own deadline watcher, every day before the clinic opens.
  for (let day = 0; day < cohort.horizonDays; day += 1) {
    const at = zonedInstant(addLocalDays(start, day, timeZone), 5, 0, timeZone);
    agenda.at(at, () => engine.runWatcher(at));
  }
  await agenda.runUntil(end, options.pause === undefined ? {} : { pause: options.pause });
  await engine.runWatcher(end);

  const orders: OrderOutcome[] = [];
  for (const state of states) {
    for (const expectation of await owned(state)) {
      const order = state.orders.get(expectation.id);
      if (order === undefined) continue;
      const path =
        expectation.status === 'fulfilled' && expectation.closedBy !== undefined
          ? pathOfResourceId(expectation.closedBy.id)
          : undefined;
      orders.push({
        patientId: state.patient.id,
        arm: state.patient.arm,
        persona: state.patient.persona,
        kind: order.kind,
        ruleId: expectation.ruleId,
        createdAt: expectation.createdAt,
        dueAt: expectation.dueAt,
        status: expectation.status,
        ...(expectation.closedAt === undefined ? {} : { closedAt: expectation.closedAt }),
        ...(path === undefined ? {} : { path }),
      });
    }
  }
  return { seed, patients: states.map((state) => state.trace), orders, unmappedOrders };
}
