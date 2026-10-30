import type { AgentMessage, OfferedSlot } from '../../domain/order-agent.ts';
import { zonedParts } from './zoned-time.ts';

/** Lowercase, accents stripped, punctuation turned into spaces, single-spaced. */
export function fold(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim()} `;
}

function hasAny(folded: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => folded.includes(` ${phrase} `));
}

/** Words that say yes (English and Spanish), compared folded and as whole words. */
const AFFIRMATIVE = [
  'si',
  'sip',
  'claro',
  'dale',
  'ok',
  'okay',
  'okey',
  'vale',
  'perfecto',
  'listo',
  'confirmo',
  'confirmado',
  'me sirve',
  'me queda bien',
  'esta bien',
  'de acuerdo',
  'reservala',
  'reservalo',
  'agendala',
  'agendalo',
  'yes',
  'yeah',
  'yep',
  'sure',
  'confirm',
  'confirmed',
  'works for me',
  'that works',
  'sounds good',
  'book it',
  'please book',
  'fine',
  'great',
];

/** Phrases that turn a reply into a refusal or a request for something else. */
const NEGATIVE = [
  'no puedo',
  'no me sirve',
  'no me queda',
  'no voy',
  'no podre',
  'no podria',
  'imposible',
  'otro dia',
  'otra hora',
  'otro horario',
  'prefiero otro',
  'prefiero otra',
  'mejor otro',
  'mejor otra',
  'no gracias',
  'can t',
  'cant',
  'cannot',
  'can not',
  'won t',
  'not available',
  'another day',
  'another time',
  'other day',
  'no thanks',
  'not that',
];

/** Whether a patient's reply is an explicit yes (and not a refusal). */
export function isAffirmative(text: string): boolean {
  const folded = fold(text);
  return hasAny(folded, AFFIRMATIVE) && !hasAny(folded, NEGATIVE);
}

/** Whether a patient's reply refuses or asks for something else. */
export function isNegative(text: string): boolean {
  return hasAny(fold(text), NEGATIVE);
}

const ORDINALS: readonly (readonly string[])[] = [
  ['1', 'uno', 'primera', 'primero', 'first', 'one', 'opcion 1', 'option 1'],
  ['2', 'dos', 'segunda', 'segundo', 'second', 'two', 'opcion 2', 'option 2'],
  ['3', 'tres', 'tercera', 'tercero', 'third', 'three', 'opcion 3', 'option 3'],
];

const WEEKDAY_WORDS: readonly (readonly string[])[] = [
  ['domingo', 'sunday'],
  ['lunes', 'monday'],
  ['martes', 'tuesday'],
  ['miercoles', 'wednesday'],
  ['jueves', 'thursday'],
  ['viernes', 'friday'],
  ['sabado', 'saturday'],
];

/**
 * Whether the reply singles out this offered slot: its option number, its
 * weekday or its time ("la 2", "el jueves", "a las 10:30").
 */
function references(folded: string, slot: OfferedSlot, index: number, timeZone: string): boolean {
  const local = zonedParts(slot.start, timeZone);
  const ordinal = ORDINALS[index] ?? [];
  const weekday = WEEKDAY_WORDS[local.weekday] ?? [];
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  const minute = String(local.minute).padStart(2, '0');
  const times = [
    `${String(local.hour)}:${minute}`,
    `${String(local.hour).padStart(2, '0')}:${minute}`,
    `${String(hour12)}:${minute}`,
    ...(local.minute === 0 ? [`a las ${String(hour12)}`, `at ${String(hour12)}`] : []),
  ];
  return hasAny(folded, [...ordinal, ...weekday, ...times]);
}

export type BookingRefusal =
  | 'message_not_found'
  | 'not_inbound'
  | 'not_latest_inbound'
  | 'slot_not_offered'
  | 'offer_for_other_order'
  | 'slot_not_free'
  | 'not_affirmative'
  | 'ambiguous_choice';

export type BookingCheck =
  | { readonly ok: true; readonly slot: OfferedSlot }
  | { readonly ok: false; readonly reason: BookingRefusal };

/**
 * The code-side check before any booking (docs/agent/order-to-completion.md#guardrails).
 * The model names the slot and the inbound message it read as a "yes";
 * code books only when every condition holds:
 *
 * - the message exists, is from the patient and is their latest text or
 *   voice message (a photo sent after it does not take the yes back);
 * - the slot was offered in the latest offer before that message, for this order;
 * - the slot is still free (`slotStillFree`, checked against the schedule and bookings);
 * - the message is an explicit yes, and when the offer had several slots it
 *   singles this one out (option number, weekday or time) and no other.
 */
export function checkBookingConfirmation(input: {
  readonly orderId: string;
  readonly slotId: string;
  readonly confirmationMessageId: string;
  /** The conversation, oldest first. */
  readonly messages: readonly AgentMessage[];
  readonly slotStillFree: boolean;
  readonly timeZone: string;
}): BookingCheck {
  const index = input.messages.findIndex((message) => message.id === input.confirmationMessageId);
  const message = input.messages[index];
  if (message === undefined) return { ok: false, reason: 'message_not_found' };
  if (message.direction !== 'inbound') return { ok: false, reason: 'not_inbound' };
  const latestInbound = input.messages.findLast(
    (item) => item.direction === 'inbound' && item.kind !== 'image',
  );
  if (latestInbound?.id !== message.id) return { ok: false, reason: 'not_latest_inbound' };
  const offer = input.messages
    .slice(0, index)
    .findLast(
      (item) =>
        item.direction === 'outbound' &&
        item.offeredSlots !== undefined &&
        item.offeredSlots.length > 0,
    );
  const offered = offer?.offeredSlots ?? [];
  const position = offered.findIndex((slot) => slot.id === input.slotId);
  const slot = offered[position];
  if (slot === undefined) return { ok: false, reason: 'slot_not_offered' };
  if (slot.orderId !== input.orderId) return { ok: false, reason: 'offer_for_other_order' };
  if (!input.slotStillFree) return { ok: false, reason: 'slot_not_free' };
  // With several options, naming one ("la 2") is an explicit choice; a question is not.
  const choiceOnly = offered.length > 1 && !isNegative(message.text) && !message.text.includes('?');
  if (!isAffirmative(message.text) && !choiceOnly) {
    return { ok: false, reason: 'not_affirmative' };
  }
  if (offered.length > 1) {
    const folded = fold(message.text);
    const named = offered.filter((item, at) => references(folded, item, at, input.timeZone));
    if (named.length !== 1 || named[0]?.id !== slot.id) {
      return { ok: false, reason: 'ambiguous_choice' };
    }
  }
  return { ok: true, slot };
}
