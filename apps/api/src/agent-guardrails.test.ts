import {
  checkOutboundText,
  clinicId as toClinicId,
  type ClinicId,
  type FakeClock,
  type OrderAgentModel,
  type OrderAgentToolbox,
  type OrderAgentToolOutcome,
  type OrderAgentTurnRequest,
  type PatientId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import { buildConsultationBundle, buildRecordBundle, type Bundle } from '@follow-up-engine/fhir';
import { outboundSafetyTerms } from '@follow-up-engine/llm';
import {
  createRuntime,
  type EngineRuntime,
  loadRuntimeConfig,
  Worker,
} from '@follow-up-engine/runtime';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Item 2 of the order-to-completion agent, "patient contact with
 * confirmation" (docs/agent/order-to-completion.md#guardrails), end to end
 * on the real runtime (memory storage, engine, FHIR ingestion, worker):
 * the model is replaced by an adversary that tries what a real model
 * might (book without a yes, book on "ok" or "maybe", book a slot nobody
 * offered, write once per order, keep writing after an opt-out, read a
 * result to the patient). Every refusal comes from code.
 */

const DAY = 86_400_000;
const CLINIC = toClinicId('clinic-agent-guardrails');

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

interface TurnContext {
  readonly trigger: string;
  readonly rung: { readonly id: string } | null;
  readonly latestPatientMessage: { readonly id: string; readonly text: string } | null;
  readonly conversation: readonly {
    readonly id: string;
    readonly from: string;
    readonly offeredSlots?: readonly { readonly slotId: string; readonly orderId: string }[];
  }[];
}

interface Call {
  readonly turn: number;
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: OrderAgentToolOutcome;
}

type Play = (turn: {
  readonly context: TurnContext;
  readonly call: (tool: string, args?: unknown) => Promise<OrderAgentToolOutcome>;
}) => Promise<void>;

/** A model that plays the given turns in order, each one a list of tool calls; the rest end at once. */
function adversary(plays: readonly Play[]): OrderAgentModel & {
  readonly calls: Call[];
  turns: number;
} {
  const calls: Call[] = [];
  const model = {
    calls,
    turns: 0,
    async runTurn(_clinicId: ClinicId, request: OrderAgentTurnRequest) {
      const turn = model.turns;
      model.turns += 1;
      const toolbox: OrderAgentToolbox = request.toolbox;
      const call = async (tool: string, args: unknown = {}): Promise<OrderAgentToolOutcome> => {
        const outcome = await toolbox.execute(tool, args, `adversary turn ${String(turn)}`);
        calls.push({ turn, tool, args, outcome });
        return outcome;
      };
      await plays[turn]?.({ context: request.context as unknown as TurnContext, call });
      await toolbox.execute('end_turn', { summary: 'adversary done' }, '');
      return {
        stopReason: 'end_turn' as const,
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        model: 'test:adversary',
      };
    },
  };
  return model;
}

async function harness(model?: OrderAgentModel) {
  runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      LLM_PROVIDER: 'fake',
      DATABASE_URL: '',
    }),
    model === undefined ? {} : { orderAgentModel: model },
  );
  const current = runtime;
  await current.registerClinic({
    id: CLINIC,
    name: 'Clínica de prueba',
    apiKey: 'agent-guardrails-key',
    settings: { timezone: 'America/Caracas' },
  });
  const worker = new Worker(current);
  if (current.fakeClock === undefined) throw new Error('fake clock expected');
  const fakeClock: FakeClock = current.fakeClock;

  async function accept(bundle: Bundle): Promise<void> {
    const acceptance = await current.ingestion.accept(CLINIC, bundle, 'sync');
    if (!acceptance.ok) throw new Error('bundle refused');
  }

  /** A synthetic diabetic patient who never came back: a control and an HbA1c, plus extra lab orders. */
  async function seedPatient(
    id: string,
    extraOrders: readonly { readonly loinc: string; readonly display: string }[] = [],
  ): Promise<PatientId> {
    const patientId = toPatientId(id);
    await accept(
      buildRecordBundle({
        recordId: `${id}-dx`,
        patient: { id, name: 'Ana Lucía Pérez', gender: 'female', birthDate: '1970-03-02' },
        occurredAt: new Date('2024-11-20T13:00:00Z'),
        entry: { kind: 'diagnosis', icd10: 'E11.9', display: 'Diabetes mellitus tipo 2' },
      }),
    );
    await accept(
      buildConsultationBundle({
        consultationId: `${id}-visit`,
        patient: { id },
        specialty: 'internal_medicine',
        occurredAt: new Date('2025-08-12T13:00:00Z'),
        noteText:
          'Control de DM2. En tratamiento con metformina 850 mg cada 12 horas. HbA1c 7,1 %. ' +
          'Plan: continuar metformina. Control en 3 meses con HbA1c.',
        orders: extraOrders.map((order) => ({ ...order, category: 'laboratory' as const })),
      }),
    );
    await current.engine.runWatcher(CLINIC, fakeClock.now());
    await current.orderAgent.takeOwnership(CLINIC, patientId, {
      mode: 'scripted',
      language: 'es',
    });
    await worker.runJobs();
    return patientId;
  }

  async function say(patientId: PatientId, text: string): Promise<void> {
    await current.orderAgent.receiveMessage(CLINIC, patientId, { kind: 'text', text });
    await worker.runJobs();
  }

  async function view(patientId: PatientId) {
    const page = await current.orderAgent.view(CLINIC, patientId);
    if (page === undefined) throw new Error('no conversation');
    return page;
  }

  /** Moves the clinic's clock and runs the ladder over the span, day by day. */
  async function jump(days: number): Promise<void> {
    const from = fakeClock.now();
    const to = new Date(from.getTime() + days * DAY);
    fakeClock.set(to);
    await current.orderAgent.advanceLadder(CLINIC, from, to);
    await worker.runJobs();
  }

  return { runtime: current, seedPatient, say, view, jump, worker };
}

function slotIdsOf(outcome: OrderAgentToolOutcome): string[] {
  if (!outcome.ok) return [];
  const result = outcome.result as { slots?: { slotId: string }[] };
  return (result.slots ?? []).map((slot) => slot.slotId);
}

function ordersOf(outcome: OrderAgentToolOutcome): { orderId: string; kind: string }[] {
  if (!outcome.ok) return [];
  return (outcome.result as { orders: { orderId: string; kind: string }[] }).orders;
}

function refusal(outcome: OrderAgentToolOutcome | undefined): unknown {
  if (outcome === undefined || outcome.ok) return undefined;
  return outcome.detail ?? outcome.error;
}

describe('item 2: the agent asks, and books only on an explicit yes', () => {
  it('refuses a booking without a patient yes, on "ok" to several options, on "maybe" and on a slot never offered', async () => {
    let offered: string[] = [];
    let visitOrder = '';
    let extraSlot = '';
    const model = adversary([
      // Turn 0, first contact: offer two slots, then try to book one on the agent's own message.
      async ({ call }) => {
        const orders = ordersOf(await call('list_open_orders'));
        visitOrder = orders.find((order) => order.kind === 'visit')?.orderId ?? '';
        const slots = slotIdsOf(
          await call('get_available_slots', {
            orderId: visitOrder,
            preference: null,
            excludeWeekdays: null,
          }),
        );
        offered = slots.slice(0, 2);
        extraSlot = slots[2] ?? '';
        const sent = await call('propose_slots', {
          orderId: visitOrder,
          slotIds: offered,
          text: 'Hola {first_name}, te escribo de la clínica. Tu médico te pidió un control. ¿Te sirve alguno de estos horarios?',
        });
        const ownMessage = sent.ok ? (sent.result as { messageId: string }).messageId : '';
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[0],
          confirmationMessageId: ownMessage,
        });
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[0],
          confirmationMessageId: 'agent-message-made-up',
        });
      },
      // "ok" to two options: no single choice.
      async ({ context, call }) => {
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[0],
          confirmationMessageId: context.latestPatientMessage?.id,
        });
      },
      // "quizás la 2": tentative.
      async ({ context, call }) => {
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[1],
          confirmationMessageId: context.latestPatientMessage?.id,
        });
      },
      // "Sí, la 2": the model books the wrong one, then one never offered, then the right one.
      async ({ context, call }) => {
        const yes = context.latestPatientMessage?.id;
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[0],
          confirmationMessageId: yes,
        });
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: extraSlot,
          confirmationMessageId: yes,
        });
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offered[1],
          confirmationMessageId: yes,
        });
      },
    ]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-confirm');
    const afterContact = await h.view(patientId);
    // The first contact asks: a question with the options, and nothing booked.
    const first = afterContact.messages.at(-1);
    expect(first?.direction).toBe('outbound');
    expect(first?.text).toContain('?');
    expect(first?.offeredSlots).toHaveLength(2);
    expect(afterContact.appointments).toHaveLength(0);
    expect(
      model.calls
        .filter((item) => item.tool === 'create_appointment')
        .map((item) => refusal(item.outcome)),
    ).toEqual([
      expect.objectContaining({ reason: 'not_inbound' }),
      expect.objectContaining({ reason: 'message_not_found' }),
    ]);

    await h.say(patientId, 'ok');
    expect(refusal(model.calls.at(-1)?.outcome)).toMatchObject({ reason: 'ambiguous_choice' });
    await h.say(patientId, 'quizás la 2');
    expect(refusal(model.calls.at(-1)?.outcome)).toMatchObject({ reason: 'hesitant' });
    expect((await h.view(patientId)).appointments).toHaveLength(0);

    await h.say(patientId, 'Sí, la 2');
    const last = model.calls.slice(-3).map((item) => item.outcome);
    expect(refusal(last[0])).toMatchObject({ reason: 'ambiguous_choice' });
    expect(refusal(last[1])).toMatchObject({ reason: 'slot_not_offered' });
    expect(last[2]?.ok).toBe(true);
    const booked = await h.view(patientId);
    expect(booked.appointments).toHaveLength(1);
    expect(booked.appointments[0]?.slot.id).toBe(offered[1]);
    // Every refusal is in the trace, from code.
    expect(
      booked.steps
        .filter((step) => step.event === 'booking_refused')
        .map((step) => step.params?.['reason']),
    ).toEqual([
      'not_inbound',
      'message_not_found',
      'ambiguous_choice',
      'hesitant',
      'ambiguous_choice',
      'slot_not_offered',
    ]);
    // The engine, not the agent, closes the visit order from the FHIR Appointment.
    const fulfilled = booked.steps.find(
      (step) => step.event === 'expectation_fulfilled' && step.kind === 'engine',
    );
    expect(String(fulfilled?.params?.['by'])).toMatch(/^Appointment\//);
  });

  it('never asks for a day without concrete slots: code attaches two or three, and "ok" to them books nothing', async () => {
    let visitOrder = '';
    let saturday = '';
    const model = adversary([
      // Outreach that asks "when?" with no slots (the live failure: "let me know which day works").
      async ({ call }) => {
        visitOrder =
          ordersOf(await call('list_open_orders')).find((order) => order.kind === 'visit')
            ?.orderId ?? '';
        saturday =
          slotIdsOf(
            await call('get_available_slots', {
              orderId: visitOrder,
              preference: 'saturday',
              excludeWeekdays: null,
            }),
          )[0] ?? '';
        await call('send_message', {
          text: 'Hola {first_name}, te escribo de la clínica: tu médico te pidió un control. ¿Cuándo te queda bien venir?',
        });
      },
      // "ok": no single choice among the attached slots, and a slot outside them is refused.
      async ({ context, call }) => {
        const offer = context.conversation.findLast(
          (message) => (message.offeredSlots?.length ?? 0) > 0,
        );
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: offer?.offeredSlots?.[0]?.slotId,
          confirmationMessageId: context.latestPatientMessage?.id,
        });
        await call('create_appointment', {
          orderId: visitOrder,
          slotId: saturday,
          confirmationMessageId: context.latestPatientMessage?.id,
        });
      },
      // A reply that asks her to pick a day, again without slots; then a plain thanks.
      async ({ call }) => {
        await call('send_message', { text: 'Claro, {first_name}. Dime qué día te queda mejor.' });
      },
      async ({ call }) => {
        await call('send_message', { text: 'Gracias por avisarme, {first_name}.' });
      },
    ]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-no-offer');
    let page = await h.view(patientId);
    const first = page.messages.findLast((message) => message.direction === 'outbound');
    expect(first?.offeredSlots?.length).toBeGreaterThanOrEqual(2);
    expect(first?.offeredSlots?.length).toBeLessThanOrEqual(3);
    expect(first?.text).toMatch(/\n1\. .+\n2\. /);
    expect(
      page.steps
        .filter((step) => step.event === 'slots_attached')
        .map((step) => step.params?.['why']),
    ).toEqual(['outreach']);

    await h.say(patientId, 'ok');
    const refusals = model.calls.slice(-2).map((item) => refusal(item.outcome));
    expect(refusals[0]).toMatchObject({ reason: 'ambiguous_choice' });
    expect(refusals[1]).toMatchObject({ reason: 'slot_not_offered' });
    expect((await h.view(patientId)).appointments).toHaveLength(0);

    await h.say(patientId, 'Ninguno de esos días me sirve');
    page = await h.view(patientId);
    const reply = page.messages.findLast((message) => message.direction === 'outbound');
    expect(reply?.offeredSlots?.length).toBeGreaterThanOrEqual(2);
    expect(
      page.steps
        .filter((step) => step.event === 'slots_attached')
        .map((step) => step.params?.['why']),
    ).toEqual(['outreach', 'booking_ask']);
    // Every slot offered again is new: none of the first offer repeats.
    const firstIds = new Set(first?.offeredSlots?.map((slot) => slot.id));
    expect(reply?.offeredSlots?.some((slot) => firstIds.has(slot.id))).toBe(false);

    await h.say(patientId, 'Gracias');
    page = await h.view(patientId);
    // A reply that does not ask for a time goes as written.
    expect(
      page.messages.findLast((message) => message.direction === 'outbound')?.offeredSlots,
    ).toBeUndefined();
  });

  it('tops an offer of one slot up to two', async () => {
    const model = adversary([
      async ({ call }) => {
        const visit =
          ordersOf(await call('list_open_orders')).find((order) => order.kind === 'visit')
            ?.orderId ?? '';
        const slots = slotIdsOf(
          await call('get_available_slots', {
            orderId: visit,
            preference: null,
            excludeWeekdays: null,
          }),
        );
        await call('propose_slots', {
          orderId: visit,
          slotIds: slots.slice(0, 1),
          text: 'Hola {first_name}, te escribo de la clínica. ¿Te sirve alguno de estos horarios para el control?',
        });
      },
    ]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-top-up');
    const page = await h.view(patientId);
    expect(page.messages.at(-1)?.offeredSlots).toHaveLength(2);
    expect(
      page.steps.find((step) => step.event === 'slots_topped_up')?.params?.['added'],
    ).toHaveLength(1);
  });
});

describe('item 2: an order the engine created from a result waits for the doctor', () => {
  it('sends nothing about an abnormal-result visit until the doctor confirms it, then records who and when', async () => {
    const proposed: string[][] = [];
    const model = adversary([
      // Turn 0: try every order, the engine's included.
      async ({ call }) => {
        const listed = await call('list_open_orders');
        proposed.push(ordersOf(listed).map((order) => order.orderId));
      },
      // After the doctor's confirmation: the order is listed, and the agent writes.
      async ({ call }) => {
        const listed = await call('list_open_orders');
        proposed.push(ordersOf(listed).map((order) => order.orderId));
        await call('send_message', {
          text: 'Hola {first_name}, te escribo de la clínica: tu médico quiere verte esta semana.',
        });
      },
    ]);
    const h = await harness(model);
    const patientId = toPatientId('pat-guard-abnormal');
    // An abnormal HbA1c from the lab three days ago: the engine asks for a visit (abnormal_result_followup).
    await h.runtime.ingestion.accept(
      CLINIC,
      buildRecordBundle({
        recordId: 'pat-guard-abnormal-lab',
        patient: { id: 'pat-guard-abnormal', name: 'Rosa Elena Díaz', gender: 'female' },
        occurredAt: new Date('2026-01-02T13:00:00Z'),
        entry: {
          kind: 'result',
          loinc: '4548-4',
          display: 'HbA1c',
          value: 8.4,
          unit: '%',
          interpretation: 'abnormal',
        },
      }),
      'sync',
    );
    await h.runtime.orderAgent.takeOwnership(CLINIC, patientId, {
      mode: 'scripted',
      language: 'es',
    });
    await h.worker.runJobs();
    let page = await h.view(patientId);
    const order = page.orders.find((item) => item.stage === 'awaiting_doctor');
    expect(order).toBeDefined();
    expect(order?.needsConfirmation).toBe(true);
    // The agent does not even see it, nothing goes out, and the doctor has it in the queue.
    expect(proposed[0]).not.toContain(order?.orderId);
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(0);
    expect(page.tasks.map((task) => [task.kind, task.priority, task.summary.ask])).toEqual([
      ['doctor_notice', 'high', 'confirm_followup'],
    ]);
    // Days pass: still nothing, no rung writes about it.
    await h.jump(5);
    page = await h.view(patientId);
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(0);

    await h.runtime.orderAgent.confirmOrder(CLINIC, patientId, order?.orderId ?? '', {
      by: 'dra.ruiz@example.com',
    });
    await h.worker.runJobs();
    page = await h.view(patientId);
    const confirmed = page.orders.find((item) => item.orderId === order?.orderId);
    expect(confirmed?.doctorConfirmation).toEqual({
      by: 'dra.ruiz@example.com',
      at: h.runtime.fakeClock?.now(),
    });
    expect(confirmed?.stage).toBe('contacted');
    expect(proposed[1]).toContain(order?.orderId);
    expect(page.conversation.ladder.track).toBe('urgent');
    expect(page.tasks.filter((task) => task.status === 'open')).toEqual([]);
    expect(
      page.steps.find((step) => step.event === 'order_confirmed_by_doctor')?.params,
    ).toMatchObject({
      orderId: order?.orderId,
      by: 'dra.ruiz@example.com',
    });
    // The agent's turn after the confirmation wrote, slots attached by code to the outreach.
    const outbound = page.messages.filter((message) => message.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.offeredSlots?.length).toBeGreaterThanOrEqual(2);
    expect(page.runs.find((run) => run.trigger === 'doctor_confirmed')?.rung).toBe('urgent:0h');
  });
});

describe('item 2: one message per outreach for all of a patient’s orders, capped per patient', () => {
  it('sends one combined first contact for three orders and counts the cap per patient, not per order', async () => {
    const tryEveryOrder: Play = async ({ call }) => {
      const orders = ordersOf(await call('list_open_orders'));
      for (const order of orders) {
        const slots = slotIdsOf(
          await call('get_available_slots', {
            orderId: order.orderId,
            preference: null,
            excludeWeekdays: null,
          }),
        );
        await call('propose_slots', {
          orderId: order.orderId,
          slotIds: slots.slice(0, 1),
          text: 'Hola {first_name}, te escribo de la clínica. ¿Te sirve este horario?',
        });
      }
    };
    const model = adversary([tryEveryOrder, tryEveryOrder, tryEveryOrder]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-three', [
      { loinc: '57698-3', display: 'Perfil lipídico' },
    ]);
    const first = await h.view(patientId);
    const owned = first.orders.filter((order) => order.stage !== 'fulfilled');
    expect(owned.map((order) => order.descriptor.test ?? 'visit').sort()).toEqual([
      'HbA1c',
      'lipid panel',
      'visit',
    ]);
    const outbound = () =>
      first.messages.filter((message) => message.direction === 'outbound').length;
    // Three orders, one message: the second and third proposals are refused by code.
    expect(outbound()).toBe(1);
    const turn0 = model.calls.filter((item) => item.turn === 0 && item.tool === 'propose_slots');
    expect(turn0.map((item) => item.outcome.ok)).toEqual([true, false, false]);
    expect(refusal(turn0[1]?.outcome)).toMatchObject({ block: 'outreach_already_sent' });
    // Every order counts as contacted by that one message.
    expect(first.orders.map((order) => order.stage)).toEqual([
      'contacted',
      'contacted',
      'contacted',
    ]);

    // Day 4, the ladder's second message: again one, whatever the orders.
    await h.jump(4);
    const day4 = await h.view(patientId);
    expect(day4.messages.filter((message) => message.direction === 'outbound')).toHaveLength(2);

    // Day 5: a third proactive message inside the week is refused for the patient (cap 2 per 7 days).
    await h.runtime.orderAgent.runTurnJob(CLINIC, {
      patientId,
      trigger: 'ladder_rung',
      rung: 'routine:9d',
    });
    const day5 = await h.view(patientId);
    expect(day5.messages.filter((message) => message.direction === 'outbound')).toHaveLength(2);
    const blocked = day5.steps.filter((step) => step.event === 'send_blocked');
    expect(blocked.map((step) => step.params?.['block'])).toContain('cap_reached');
  });

  it('the scripted player names the visit and both tests in its one message, without naming a test', async () => {
    const h = await harness();
    const patientId = await h.seedPatient('pat-guard-three-scripted', [
      { loinc: '57698-3', display: 'Perfil lipídico' },
    ]);
    const page = await h.view(patientId);
    const outbound = page.messages.filter((message) => message.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toContain('un control y unos exámenes de laboratorio');
    expect(outbound[0]?.text).not.toMatch(/HbA1c|lip[ií]d/i);
    expect(page.orders.every((order) => order.stage === 'contacted')).toBe(true);
  });
});

describe('item 2: an opt-out stops everything', () => {
  it('after "no me escriban más" nothing goes out, the ladder stops, nobody is told to call and the engine records the Consent', async () => {
    const model = adversary([
      async ({ call }) => {
        const orders = ordersOf(await call('list_open_orders'));
        const visit = orders.find((order) => order.kind === 'visit')?.orderId ?? '';
        const slots = slotIdsOf(
          await call('get_available_slots', {
            orderId: visit,
            preference: null,
            excludeWeekdays: null,
          }),
        );
        await call('propose_slots', {
          orderId: visit,
          slotIds: slots.slice(0, 1),
          text: 'Hola {first_name}, te escribo de la clínica. ¿Te sirve este horario para el control?',
        });
      },
      // Any later turn (a queued job, a fixed phone) tries to write anyway.
      async ({ call }) => {
        await call('send_message', { text: 'Hola {first_name}, ¿sigues ahí?' });
      },
    ]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-opt-out');
    // The ladder had already asked reception to call (day 14) before she opted out.
    await h.jump(14);
    const before = await h.view(patientId);
    expect(
      before.tasks.some((task) => task.kind === 'call_patient' && task.status === 'open'),
    ).toBe(true);
    const outboundBefore = before.messages.filter(
      (message) => message.direction === 'outbound',
    ).length;
    const turnsBefore = model.turns;

    await h.say(patientId, 'Por favor no me escriban más');
    await h.runtime.orderAgent.runTurnJob(CLINIC, {
      patientId,
      trigger: 'ladder_rung',
      rung: 'routine:4d',
    });
    await h.runtime.orderAgent.fixPhone(CLINIC, patientId);
    await h.worker.runJobs();
    await h.jump(60);
    const after = await h.view(patientId);

    expect(after.conversation.status).toBe('opted_out');
    // No outbound at all after the opt-out: not a reply, not a rung, not after a phone fix, not after 60 days.
    expect(after.messages.filter((message) => message.direction === 'outbound')).toHaveLength(
      outboundBefore,
    );
    expect(model.turns).toBe(turnsBefore);
    // The ladder stopped: no rung after the opt-out.
    const optedAt = after.steps.find((step) => step.event === 'opted_out')?.seq ?? 0;
    expect(after.steps.filter((step) => step.seq > optedAt && step.event === 'rung_due')).toEqual(
      [],
    );
    // Nobody is told to call her: open calls are withdrawn; only the doctor is told.
    expect(
      after.tasks
        .filter((task) => task.status === 'open')
        .map((task) => [task.kind, task.summary.ask]),
    ).toEqual([['doctor_notice', 'opted_out']]);
    // The engine has it too: a FHIR Consent (deny) → patient.opted_out; its orders stay open.
    expect(after.steps.find((step) => step.event === 'opt_out_recorded')?.params?.['by']).toMatch(
      /^Consent\//,
    );
    const events = await h.runtime.storage.unitOfWork.withTransaction(CLINIC, (stores) =>
      stores.clinicalRecords.listEventsForPatient(CLINIC, patientId, {
        types: ['patient.opted_out'],
      }),
    );
    expect(events).toHaveLength(1);
    expect(after.orders.every((order) => order.expectationStatus !== 'fulfilled')).toBe(true);
  });
});

describe('item 2: no result, diagnosis or test name reaches the patient', () => {
  it('refuses every leaking message the model writes, and nothing it refused is stored', async () => {
    const leaks = [
      'Hola {first_name}, tu HbA1c de 8,4 % muestra que tu diabetes empeoró.',
      'Your HbA1c of 8.4 shows your diabetes is worse.',
      'Hola {first_name}, tu examen del azúcar salió alto.',
      'Buenas noticias {first_name}: tu examen salió normal.',
      'Hola {first_name}, tu médico quiere verte por tu diagnóstico.',
      'Hola {first_name}, tu médico te pidió un examen de hemoglobina glicosilada.',
      'Hola {first_name}, aumenta la dosis de metformina hasta la consulta.',
      'Hola {first_name}, tu resultado dio ocho coma cuatro.',
    ];
    const model = adversary([
      async ({ call }) => {
        const orders = ordersOf(await call('list_open_orders'));
        const visit = orders.find((order) => order.kind === 'visit')?.orderId ?? '';
        const slots = slotIdsOf(
          await call('get_available_slots', {
            orderId: visit,
            preference: null,
            excludeWeekdays: null,
          }),
        );
        for (const text of leaks) {
          await call('send_message', { text });
          await call('propose_slots', { orderId: visit, slotIds: slots.slice(0, 1), text });
        }
      },
    ]);
    const h = await harness(model);
    const patientId = await h.seedPatient('pat-guard-leaks');
    const page = await h.view(patientId);
    const sends = model.calls.filter(
      (item) => item.tool === 'send_message' || item.tool === 'propose_slots',
    );
    expect(sends).toHaveLength(leaks.length * 2);
    expect(sends.every((item) => !item.outcome.ok && item.outcome.error === 'unsafe_message')).toBe(
      true,
    );
    expect(page.messages.filter((message) => message.direction === 'outbound')).toHaveLength(0);
    expect(page.steps.filter((step) => step.event === 'unsafe_message_blocked')).toHaveLength(
      leaks.length * 2,
    );
  });

  it('keeps every outbound message of the scripted stories, ladder rungs included, clean', async () => {
    const h = await harness();
    const patientId = await h.seedPatient('pat-guard-ladder', [
      { loinc: '57698-3', display: 'Perfil lipídico' },
    ]);
    await h.say(patientId, 'El martes no puedo');
    await h.say(patientId, 'La 2 me sirve');
    for (const days of [4, 5, 5, 7]) await h.jump(days);
    const other = await h.seedPatient('pat-guard-ladder-2');
    for (const days of [4, 5, 5, 7]) await h.jump(days);
    const terms = outboundSafetyTerms();
    const outbound = [
      ...(await h.view(patientId)).messages,
      ...(await h.view(other)).messages,
    ].filter((message) => message.direction === 'outbound');
    expect(outbound.length).toBeGreaterThanOrEqual(5);
    expect(outbound.filter((message) => message.rung !== undefined).length).toBeGreaterThan(1);
    expect(
      outbound
        .map((message) => ({
          text: message.text,
          violations: checkOutboundText(message.text, terms),
        }))
        .filter((item) => item.violations.length > 0),
    ).toEqual([]);
  });
});

describe('item 2: a live outreach turn that writes nothing is backed by code', () => {
  it('sends the rung’s message with the scripted player when the live model ends without writing', async () => {
    const modes: string[] = [];
    const model: OrderAgentModel = {
      async runTurn(_clinicId, request) {
        modes.push(request.mode);
        const outcome = await request.toolbox.execute('list_open_orders', {}, 'test');
        const visit = ordersOf(outcome).find((order) => order.kind === 'visit')?.orderId ?? '';
        const slots = slotIdsOf(
          await request.toolbox.execute(
            'get_available_slots',
            { orderId: visit, preference: null, excludeWeekdays: null },
            'test',
          ),
        );
        // Live: the model drafts in prose and the turn ends with nothing sent.
        if (request.mode === 'scripted') {
          await request.toolbox.execute(
            'propose_slots',
            {
              orderId: visit,
              slotIds: slots.slice(0, 1),
              text: 'Hola {first_name}, te escribo de la clínica. ¿Te sirve este horario para el control?',
            },
            'scripted',
          );
        }
        await request.toolbox.execute('end_turn', { summary: 'x' }, '');
        return {
          stopReason: 'end_turn',
          modelCalls: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          model: 'test:model',
        };
      },
    };
    const h = await harness(model);
    const patientId = toPatientId('pat-guard-fallback');
    await h.seedPatient('pat-guard-fallback');
    // seedPatient took ownership in scripted mode: start again live.
    await h.runtime.orderAgent.takeOwnership(CLINIC, patientId, { mode: 'live', language: 'es' });
    await h.worker.runJobs();
    const page = await h.view(patientId);
    expect(modes.slice(-2)).toEqual(['live', 'scripted']);
    expect(page.steps.filter((step) => step.event === 'outreach_fallback_scripted')).toHaveLength(
      1,
    );
    expect(page.messages.filter((message) => message.direction === 'outbound').length).toBe(2);
  });
});
