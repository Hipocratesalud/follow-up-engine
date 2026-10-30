import { describe, expect, it } from 'vitest';
import { clinicId, patientId } from '../../domain/ids.ts';
import type { AgentMessage, OfferedSlot } from '../../domain/order-agent.ts';
import { checkBookingConfirmation, isAffirmative } from './confirmation.ts';
import { contactPolicy, isOptOut, MAX_PROACTIVE_PER_WINDOW } from './contact-policy.ts';
import { dueRungs, LADDER, startTrack } from './ladder.ts';
import { checkOutboundText } from './outbound-safety.ts';
import { availableSlots, formatSlotLine, MIN_LEAD_HOURS, slotFromId } from './slots.ts';
import { zonedParts } from './zoned-time.ts';

const TZ = 'America/Caracas';
const CLINIC = clinicId('clinic-test');
const PATIENT = patientId('pat-1');
/** Monday 2026-01-05, 08:00 in Caracas. */
const NOW = new Date('2026-01-05T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function message(
  id: string,
  direction: AgentMessage['direction'],
  at: Date,
  text: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id,
    clinicId: CLINIC,
    patientId: PATIENT,
    direction,
    kind: 'text',
    text,
    at,
    ...(direction === 'outbound' ? { deliveryStatus: 'delivered' as const } : {}),
    ...extra,
  };
}

describe('slots', () => {
  it('offers up to three free slots, one per day, never within the lead time', () => {
    const slots = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'professional',
      preference: 'earliest',
    });
    expect(slots).toHaveLength(3);
    const days = new Set(slots.map((slot) => zonedParts(slot.start, TZ).day));
    expect(days.size).toBe(3);
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + MIN_LEAD_HOURS * HOUR);
      const local = zonedParts(slot.start, TZ);
      expect(local.hour).toBeGreaterThanOrEqual(8);
      expect(local.hour).toBeLessThan(12);
    }
  });

  it('skips excluded weekdays, booked and already offered slots', () => {
    const first = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'professional',
      preference: 'earliest',
    });
    const again = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'professional',
      preference: 'earliest',
      excludeWeekdays: ['tuesday'],
      previouslyOffered: first.slice(0, 1),
      booked: new Set([first[1]?.id ?? '']),
    });
    for (const slot of again) {
      expect(zonedParts(slot.start, TZ).weekday).not.toBe(2);
      expect(slot.id).not.toBe(first[0]?.id);
      expect(slot.id).not.toBe(first[1]?.id);
    }
  });

  it('keeps urgent orders within the week and Saturday preferences on Saturdays', () => {
    const urgent = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'lab',
      preference: 'earliest',
      urgent: true,
    });
    for (const slot of urgent) expect(slot.start.getTime()).toBeLessThan(NOW.getTime() + 8 * DAY);
    const saturday = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'lab',
      preference: 'saturday',
      count: 2,
    });
    expect(saturday.length).toBeGreaterThan(0);
    for (const slot of saturday) {
      expect(zonedParts(slot.start, TZ).weekday).toBe(6);
      expect(slot.resource).toBe('lab_north');
    }
  });

  it('accepts only ids the schedule really has', () => {
    const [slot] = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'professional',
      preference: 'earliest',
    });
    expect(slot).toBeDefined();
    expect(slotFromId(slot?.id ?? '', TZ)?.start.toISOString()).toBe(slot?.start.toISOString());
    expect(slotFromId('professional@20260106T0300Z', TZ)).toBeUndefined();
    expect(slotFromId('made-up', TZ)).toBeUndefined();
    expect(slotFromId(slot?.id ?? '', TZ, new Set([slot?.id ?? '']))).toBeUndefined();
  });

  it('formats a slot line in the conversation language', () => {
    const [slot] = availableSlots({
      now: NOW,
      timeZone: TZ,
      kind: 'professional',
      preference: 'earliest',
    });
    if (slot === undefined) throw new Error('no slot');
    expect(formatSlotLine(slot, 'es', TZ)).toContain('Dra. Elena Ruiz');
    expect(formatSlotLine(slot, 'en', TZ)).toContain('Dr. Elena Ruiz');
  });
});

describe('booking confirmation', () => {
  const slots = availableSlots({
    now: NOW,
    timeZone: TZ,
    kind: 'professional',
    preference: 'earliest',
  });
  const offered: OfferedSlot[] = slots.map((slot) => ({
    ...slot,
    orderId: 'exp-visit' as OfferedSlot['orderId'],
  }));
  const offer = message('m1', 'outbound', NOW, 'Options:', { offeredSlots: offered });
  const check = (reply: string, slotIndex = 1, extra: AgentMessage[] = []) =>
    checkBookingConfirmation({
      orderId: 'exp-visit',
      slotId: offered[slotIndex]?.id ?? '',
      confirmationMessageId: 'm2',
      messages: [offer, message('m2', 'inbound', new Date(NOW.getTime() + HOUR), reply), ...extra],
      slotStillFree: true,
      timeZone: TZ,
    });

  it('books a slot the latest reply singles out', () => {
    expect(check('La 2 me sirve, gracias').ok).toBe(true);
    expect(check('Sí, la segunda').ok).toBe(true);
    expect(check('2').ok).toBe(true);
  });

  it('refuses refusals, questions, ambiguity and stale messages', () => {
    expect(check('No puedo ninguna de esas')).toMatchObject({
      ok: false,
      reason: 'not_affirmative',
    });
    expect(check('¿La 2 es por la mañana?')).toMatchObject({ ok: false });
    expect(check('Sí, cualquiera')).toMatchObject({ ok: false, reason: 'ambiguous_choice' });
    expect(check('La 1 o la 2')).toMatchObject({ ok: false, reason: 'ambiguous_choice' });
    expect(
      check('La 2', 1, [message('m3', 'inbound', new Date(NOW.getTime() + 2 * HOUR), 'mejor no')]),
    ).toMatchObject({
      ok: false,
      reason: 'not_latest_inbound',
    });
  });

  it('never books a tentative or bare reply: "maybe", "ok" to several options, "ok" to nothing', () => {
    expect(check('Quizás la 2')).toMatchObject({ ok: false, reason: 'hesitant' });
    expect(check('Maybe the second one')).toMatchObject({ ok: false, reason: 'hesitant' });
    expect(check('La 2, déjame ver y te aviso')).toMatchObject({ ok: false, reason: 'hesitant' });
    expect(check('Ok')).toMatchObject({ ok: false, reason: 'ambiguous_choice' });
    expect(check('ok', 0)).toMatchObject({ ok: false, reason: 'ambiguous_choice' });
    expect(isAffirmative('Sí, tal vez')).toBe(false);
    // "ok" with no slot offered at all: nothing to book.
    const unoffered = checkBookingConfirmation({
      orderId: 'exp-visit',
      slotId: offered[0]?.id ?? '',
      confirmationMessageId: 'm2',
      messages: [
        message('m1', 'outbound', NOW, 'Hola, tu médico pidió un control.'),
        message('m2', 'inbound', new Date(NOW.getTime() + HOUR), 'ok'),
      ],
      slotStillFree: true,
      timeZone: TZ,
    });
    expect(unoffered).toMatchObject({ ok: false, reason: 'slot_not_offered' });
    // "maybe" to a single offered slot is not a yes either.
    const single = message('m1', 'outbound', NOW, 'One:', { offeredSlots: offered.slice(0, 1) });
    expect(
      checkBookingConfirmation({
        orderId: 'exp-visit',
        slotId: offered[0]?.id ?? '',
        confirmationMessageId: 'm2',
        messages: [single, message('m2', 'inbound', NOW, 'maybe')],
        slotStillFree: true,
        timeZone: TZ,
      }),
    ).toMatchObject({ ok: false, reason: 'hesitant' });
  });

  it('refuses a booking the agent confirms with its own message', () => {
    expect(
      checkBookingConfirmation({
        orderId: 'exp-visit',
        slotId: offered[0]?.id ?? '',
        confirmationMessageId: 'm1',
        messages: [offer],
        slotStillFree: true,
        timeZone: TZ,
      }),
    ).toMatchObject({ ok: false, reason: 'not_inbound' });
  });

  it('keeps a yes when a photo follows it', () => {
    const photo = message('m3', 'inbound', new Date(NOW.getTime() + 2 * HOUR), '', {
      kind: 'image',
    });
    expect(check('La 2', 1, [photo]).ok).toBe(true);
  });

  it('refuses a slot that was never offered, or is no longer free', () => {
    const notOffered = checkBookingConfirmation({
      orderId: 'exp-visit',
      slotId: 'professional@20260120T1300Z',
      confirmationMessageId: 'm2',
      messages: [offer, message('m2', 'inbound', NOW, 'sí')],
      slotStillFree: true,
      timeZone: TZ,
    });
    expect(notOffered).toMatchObject({ ok: false, reason: 'slot_not_offered' });
    const taken = checkBookingConfirmation({
      orderId: 'exp-visit',
      slotId: offered[0]?.id ?? '',
      confirmationMessageId: 'm2',
      messages: [offer, message('m2', 'inbound', NOW, 'la 1')],
      slotStillFree: false,
      timeZone: TZ,
    });
    expect(taken).toMatchObject({ ok: false, reason: 'slot_not_free' });
  });

  it('accepts a plain yes when one slot was offered', () => {
    const single = message('m1', 'outbound', NOW, 'One:', { offeredSlots: offered.slice(0, 1) });
    const result = checkBookingConfirmation({
      orderId: 'exp-visit',
      slotId: offered[0]?.id ?? '',
      confirmationMessageId: 'm2',
      messages: [single, message('m2', 'inbound', NOW, 'Yes, that works')],
      slotStillFree: true,
      timeZone: TZ,
    });
    expect(result.ok).toBe(true);
    expect(isAffirmative("Yes but I can't on Tuesday")).toBe(false);
  });
});

describe('outbound safety', () => {
  const terms = { conditionTerms: ['diabetes', 'dm2', 'hipertension'] };

  it('lets a plain scheduling message through', () => {
    expect(
      checkOutboundText(
        'Hola María, tu médico pidió un control y un examen de laboratorio. ¿Te sirve el jueves a las 9:30?',
        terms,
      ),
    ).toEqual([]);
    expect(
      checkOutboundText(
        'Hi Maria, your doctor asked for a follow-up visit and a lab test. Does Thursday at 9:30 work?',
        terms,
      ),
    ).toEqual([]);
  });

  it('blocks the name of a test: it tells whoever reads the phone what it monitors', () => {
    const kinds = (text: string) => [
      ...new Set(checkOutboundText(text, terms).map((item) => item.kind)),
    ];
    expect(kinds('Tu médico pidió un control y un examen de HbA1c.')).toEqual(['test_name']);
    expect(kinds('Your doctor asked for a hemoglobin A1c test.')).toEqual(['test_name']);
    expect(kinds('Recuerda tu mamografía del jueves')).toEqual(['test_name']);
    expect(kinds('Your PSA is due')).toEqual(['test_name']);
    expect(kinds('Te espera la prueba de VIH')).toContain('test_name');
    expect(kinds('Your HbA1c of 8.4 shows your diabetes is worse')).toEqual(
      expect.arrayContaining(['result_value', 'result_judgement', 'condition_term', 'test_name']),
    );
  });

  it('blocks values spelled out, verdicts either way and everyday names of conditions', () => {
    const kinds = (text: string) => checkOutboundText(text, terms).map((item) => item.kind);
    expect(kinds('Tu examen salió en ocho coma cuatro')).toContain('result_value');
    expect(kinds('It came back at eight point four')).toContain('result_value');
    expect(kinds('Te salió 8 por ciento')).toContain('result_value');
    expect(kinds('Buenas noticias: todo normal')).toContain('result_judgement');
    expect(kinds('Your lab test is within range')).toContain('result_judgement');
    expect(kinds('El examen del azúcar')).toContain('condition_term');
    expect(kinds('Let us check your blood pressure')).toContain('condition_term');
  });

  it('blocks values, verdicts, condition names and advice', () => {
    const kinds = (text: string) => checkOutboundText(text, terms).map((item) => item.kind);
    expect(kinds('Tu HbA1c salió en 8,4 %')).toContain('result_value');
    expect(kinds('Your result was 8.4')).toContain('result_value');
    expect(kinds('El resultado está elevado')).toContain('result_judgement');
    expect(kinds('Your result is high')).toContain('result_judgement');
    expect(kinds('Control de tu diabetes')).toContain('condition_term');
    expect(kinds('Por tu diagnóstico de DM2')).toEqual(
      expect.arrayContaining(['diagnosis_word', 'condition_term']),
    );
    expect(kinds('Aumenta la dosis de metformina')).toContain('medical_advice');
  });
});

describe('contact policy', () => {
  it('caps proactive messages at two per rolling week, replies aside', () => {
    const conversation = { status: 'active' as const, phoneStatus: 'ok' as const };
    const sent = [
      message('a', 'outbound', NOW, 'one', { proactive: true }),
      message('b', 'outbound', new Date(NOW.getTime() + 4 * DAY), 'two', { proactive: true }),
    ];
    const blocked = contactPolicy(conversation, sent, new Date(NOW.getTime() + 5 * DAY));
    expect(blocked).toMatchObject({ canSend: false, block: 'cap_reached', proactiveRemaining: 0 });
    expect(blocked.nextProactiveAllowedAt.toISOString()).toBe(
      new Date(NOW.getTime() + 7 * DAY).toISOString(),
    );
    const later = contactPolicy(conversation, sent, new Date(NOW.getTime() + 7 * DAY + HOUR));
    expect(later.canSend).toBe(true);
    expect(MAX_PROACTIVE_PER_WINDOW).toBe(2);
    const replying = contactPolicy(
      conversation,
      [...sent, message('c', 'inbound', new Date(NOW.getTime() + 5 * DAY), 'hola')],
      new Date(NOW.getTime() + 5 * DAY + HOUR),
    );
    expect(replying).toMatchObject({ canSend: true, sendKind: 'reply' });
  });

  it('never sends after an opt-out or to an undelivered phone', () => {
    expect(contactPolicy({ status: 'opted_out', phoneStatus: 'ok' }, [], NOW).block).toBe(
      'opted_out',
    );
    expect(contactPolicy({ status: 'active', phoneStatus: 'undelivered' }, [], NOW).block).toBe(
      'phone_undelivered',
    );
    expect(isOptOut('STOP')).toBe(true);
    expect(isOptOut('Por favor no me escriban más')).toBe(true);
    expect(isOptOut('No puedo el martes')).toBe(false);
  });
});

describe('ladder', () => {
  it('fires each routine rung on its day and waits while the patient is talking', () => {
    const state = startTrack('routine', NOW, { firstDone: true });
    expect(dueRungs(state, new Date(NOW.getTime() + 3 * DAY), undefined)).toEqual([]);
    expect(
      dueRungs(state, new Date(NOW.getTime() + 4 * DAY), undefined).map((rung) => rung.id),
    ).toEqual(['routine:4d']);
    expect(
      dueRungs(state, new Date(NOW.getTime() + 21 * DAY), undefined).map((rung) => rung.id),
    ).toEqual(LADDER.routine.slice(1).map((rung) => rung.id));
    expect(
      dueRungs(state, new Date(NOW.getTime() + 9 * DAY), new Date(NOW.getTime() + DAY)),
    ).toEqual([]);
  });

  it('runs the urgent track by hours and the undelivered track regardless of replies', () => {
    const urgent = startTrack('urgent', NOW, { firstDone: true });
    expect(
      dueRungs(urgent, new Date(NOW.getTime() + 2 * DAY), undefined).map((rung) => rung.action),
    ).toEqual(['message', 'call_task']);
    const undelivered = startTrack('undelivered', NOW);
    expect(
      dueRungs(undelivered, NOW, new Date(NOW.getTime() + HOUR)).map((rung) => rung.action),
    ).toEqual(['update_phone_task']);
  });
});
