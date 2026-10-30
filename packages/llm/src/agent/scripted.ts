import {
  fold,
  isAffirmative,
  isNegative,
  WEEKDAY_NAMES,
  type WeekdayName,
} from '@follow-up-engine/core';
import type { FakeResponder } from '../providers/fake.ts';
import type { ProviderRequest } from '../usage.ts';
import { ORDER_AGENT_ACTION_NAME, type OrderAgentAction } from './prompt.ts';

/** Model id of the scripted order agent on the fake provider. */
export const FAKE_ORDER_AGENT_MODEL = 'fake-order-agent';

type Language = 'en' | 'es';

interface ContextMessage {
  readonly id: string;
  readonly from: 'agent' | 'patient';
  readonly text: string;
  readonly offeredSlots?: readonly { option: number; slotId: string; orderId: string }[];
}

interface TurnContext {
  readonly trigger: string;
  readonly patientLanguage: Language;
  readonly rung: { readonly id: string; readonly brief: string | null } | null;
  readonly latestPatientMessage: {
    readonly id: string;
    readonly kind: string;
    readonly text: string;
    readonly hasLabPhoto: boolean;
  } | null;
  readonly conversation: readonly ContextMessage[];
}

interface Observation {
  readonly tool: string;
  readonly body: Record<string, unknown>;
}

interface OrderView {
  readonly orderId: string;
  readonly kind: 'visit' | 'test';
  readonly test?: string;
  readonly stage: string;
}

function parseContext(content: string): TurnContext | undefined {
  const match = /<turn_context>([\s\S]*)<\/turn_context>/.exec(content);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(match[1]) as TurnContext;
  } catch {
    return undefined;
  }
}

function parseObservation(content: string): Observation | undefined {
  const match = /<tool_result step="\d+" tool="([a-z_]+)">([\s\S]*)<\/tool_result>/.exec(content);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  try {
    return { tool: match[1], body: JSON.parse(match[2]) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

function act(thought: string, tool: string, args: unknown): OrderAgentAction {
  return { thought, tool, arguments: JSON.stringify(args) };
}

const WEEKDAY_WORDS: Readonly<Record<string, WeekdayName>> = {
  domingo: 'sunday',
  lunes: 'monday',
  martes: 'tuesday',
  miercoles: 'wednesday',
  jueves: 'thursday',
  viernes: 'friday',
  sabado: 'saturday',
  ...Object.fromEntries(WEEKDAY_NAMES.map((name) => [name, name])),
};

function weekdaysIn(text: string): WeekdayName[] {
  const folded = fold(text);
  return Object.entries(WEEKDAY_WORDS)
    .filter(([word]) => folded.includes(` ${word} `))
    .map(([, name]) => name)
    .filter((name, index, all) => all.indexOf(name) === index);
}

const ORDINAL_WORDS: readonly (readonly string[])[] = [
  ['1', 'uno', 'primera', 'primero', 'first', 'one'],
  ['2', 'dos', 'segunda', 'segundo', 'second', 'two'],
  ['3', 'tres', 'tercera', 'tercero', 'third', 'three'],
];

/** The option the patient picked from the last offer, when they named exactly one. */
function chosenOption(text: string, options: number): number | undefined {
  const folded = fold(text);
  const named = ORDINAL_WORDS.slice(0, options)
    .map((words, index) => (words.some((word) => folded.includes(` ${word} `)) ? index + 1 : 0))
    .filter((option) => option > 0);
  if (named.length === 1) return named[0];
  return options === 1 && isAffirmative(text) ? 1 : undefined;
}

/**
 * Every message the scripted player can send (the outbound safety property
 * test runs each variant through the code-side check).
 */
export const SCRIPTED_COPY = {
  firstContact: {
    es: (tests: number): string =>
      tests > 0
        ? `Hola {first_name}, te escribo de la clínica. Tu médico te pidió un control y ${tests > 1 ? 'unos exámenes' : 'un examen'} de laboratorio, y quiero ayudarte a agendarlos. ¿Te sirve alguno de estos horarios para el control?`
        : 'Hola {first_name}, te escribo de la clínica. Tu médico te pidió un control y quiero ayudarte a agendarlo. ¿Te sirve alguno de estos horarios?',
    en: (tests: number): string =>
      tests > 0
        ? `Hi {first_name}, this is the clinic. Your doctor asked for a follow-up visit and ${tests > 1 ? 'some lab tests' : 'a lab test'}, and I would like to help you schedule them. Does one of these times work for the visit?`
        : 'Hi {first_name}, this is the clinic. Your doctor asked for a follow-up visit and I would like to help you schedule it. Does one of these times work for you?',
  },
  firstContactTest: {
    es: 'Hola {first_name}, te escribo de la clínica. Tu médico te pidió un examen de laboratorio y quiero ayudarte a agendarlo. ¿Te sirve alguno de estos horarios?',
    en: 'Hi {first_name}, this is the clinic. Your doctor asked for a lab test and I would like to help you schedule it. Does one of these times work for you?',
  },
  otherTime: {
    es: 'Hola {first_name}, ¿te quedan mejor estos otros horarios? Respóndeme con el número y lo dejo reservado.',
    en: 'Hi {first_name}, would one of these other times suit you better? Reply with its number and I will book it.',
  },
  removeFriction: {
    es: 'Hola {first_name}, sé que a veces cuesta encontrar tiempo. También hay horarios los sábados y en la sede más cerca de casa:',
    en: 'Hi {first_name}, I know finding time can be hard. There are Saturday times too, and a branch closer to home:',
  },
  urgentThisWeek: {
    es: 'Hola {first_name}, te escribo de la clínica: tu médico quiere verte esta semana. ¿Te sirve alguno de estos horarios?',
    en: 'Hi {first_name}, this is the clinic: your doctor would like to see you this week. Does one of these times work for you?',
  },
  urgentOtherHour: {
    es: 'Hola {first_name}, te propongo otras horas esta misma semana para que tu médico te vea:',
    en: 'Hi {first_name}, here are other times this week for your doctor to see you:',
  },
  newOptions: {
    es: (photoHint: boolean): string =>
      photoHint
        ? 'Sin problema, {first_name}. Si ya te hiciste el examen, puedes enviarme aquí una foto del resultado. Para el control te propongo estas opciones:'
        : 'Sin problema, {first_name}. Te propongo estas otras opciones:',
    en: (photoHint: boolean): string =>
      photoHint
        ? 'No problem, {first_name}. If you already had the test, you can send me a photo of the report here. For the visit, here are some options:'
        : 'No problem, {first_name}. Here are some other options:',
  },
  booked: {
    es: (where: string, testPending: boolean): string =>
      `¡Listo, {first_name}! Quedó reservado: ${where}.${testPending ? ' Cuando tengas el resultado del examen, envíame una foto por aquí.' : ''}`,
    en: (where: string, testPending: boolean): string =>
      `Done, {first_name}! You are booked: ${where}.${testPending ? ' When you have the test report, send me a photo here.' : ''}`,
  },
  whichOne: {
    es: '¿Me confirmas cuál de las opciones te sirve? Respóndeme con el número.',
    en: 'Could you confirm which option works for you? Just reply with its number.',
  },
  photoReceived: {
    es: (review: boolean, visitBooked: boolean): string =>
      review
        ? `Gracias, {first_name}. Recibí la foto de tu examen y ya quedó en tu historia. Tu médico lo va a revisar${visitBooked ? ' contigo en tu control' : ''}.`
        : 'Gracias, {first_name}. Recibí la foto de tu examen y ya quedó en tu historia.',
    en: (review: boolean, visitBooked: boolean): string =>
      review
        ? `Thank you, {first_name}. I received the photo of your test and it is now in your record. Your doctor will review it${visitBooked ? ' with you at your visit' : ''}.`
        : 'Thank you, {first_name}. I received the photo of your test and it is now in your record.',
  },
  photoUnreadable: {
    es: 'Gracias, {first_name}. No pude leer bien la foto como un informe de laboratorio. ¿Me envías otra con el informe completo y bien iluminado?',
    en: 'Thank you, {first_name}. I could not read the photo as a lab report. Could you send another one, with the whole report and good light?',
  },
  handOver: {
    es: 'Tu médico es quien revisa eso contigo. Ya le pedí al equipo de la clínica que te contacte.',
    en: 'That is something your doctor reviews with you. I have asked the clinic team to contact you.',
  },
  thanks: {
    es: 'Gracias, {first_name}. Si necesitas cambiar algo, escríbeme por aquí.',
    en: 'Thank you, {first_name}. If you need to change anything, just write to me here.',
  },
} as const;

const QUESTION_WORDS = [
  'resultado',
  'resultados',
  'como salio',
  'esta bien',
  'es grave',
  'que significa',
  'result',
  'results',
  'is it bad',
  'what does it mean',
  'my value',
];

function asksAboutResult(text: string): boolean {
  const folded = fold(text);
  return QUESTION_WORDS.some((word) => folded.includes(` ${word} `)) && text.includes('?');
}

function alreadyDidTest(text: string): boolean {
  const folded = fold(text);
  return [
    ' ya me hice',
    ' ya me lo hice',
    ' ya lo hice',
    ' already had',
    ' already did',
    ' already took',
  ].some((phrase) => folded.includes(phrase));
}

/**
 * A deterministic stand-in for the order agent's model, for CI and the demo
 * without a Meta key: it speaks the real protocol (one tool call per step)
 * through the real gateway, loop and toolbox, so every guardrail runs. It
 * plays María's story (docs/agent/order-to-completion.md#demo-story) and
 * reacts to simple replies by keywords; wording is templated, never clinical.
 */
export const scriptedOrderAgentResponder: FakeResponder = (request: ProviderRequest<unknown>) => {
  if (request.output.name !== ORDER_AGENT_ACTION_NAME) return undefined;
  const context = request.messages
    .map((message) => (message.role === 'user' ? parseContext(message.content) : undefined))
    .find((parsed) => parsed !== undefined);
  if (context === undefined)
    return act('scripted:no_context', 'end_turn', { summary: 'scripted:no_context' });
  const language: Language = context.patientLanguage === 'en' ? 'en' : 'es';
  const observations = request.messages.flatMap((message) => {
    if (message.role !== 'user') return [];
    const observation = parseObservation(message.content);
    return observation === undefined ? [] : [observation];
  });
  const last = (tool: string): Record<string, unknown> | undefined =>
    observations.findLast((item) => item.tool === tool)?.body;
  const called = (tool: string): number => observations.filter((item) => item.tool === tool).length;
  const end = (summary: string): OrderAgentAction => act('scripted:done', 'end_turn', { summary });

  const ordersBody = last('list_open_orders');
  if (ordersBody === undefined) {
    return act('scripted:list_orders', 'list_open_orders', {});
  }
  const orders = (Array.isArray(ordersBody['orders']) ? ordersBody['orders'] : []) as OrderView[];
  const chasing = orders.filter((order) => order.stage === 'open' || order.stage === 'contacted');
  const testsPending = orders.filter(
    (order) => order.kind === 'test' && (order.stage === 'open' || order.stage === 'contacted'),
  ).length;
  const testPending = testsPending > 0;
  const sent = called('send_message') + called('propose_slots');
  const sentOk = observations.filter(
    (item) =>
      (item.tool === 'send_message' || item.tool === 'propose_slots') && item.body['sent'] === true,
  ).length;

  // --- Outreach: first contact, a ladder rung, a fixed phone --------------------------
  if (context.trigger !== 'inbound_message') {
    if (sentOk > 0 || sent >= 2) return end('scripted:outreach_sent');
    const policy = last('get_contact_policy');
    if (policy === undefined) {
      return act('scripted:check_policy', 'get_contact_policy', {});
    }
    if (policy['canSendNow'] !== true) return end('scripted:contact_policy_not_now');
    const target = chasing.find((order) => order.kind === 'visit') ?? chasing[0];
    if (target === undefined) return end('scripted:nothing_to_chase');
    const slots = last('get_available_slots');
    if (slots === undefined) {
      return act('scripted:find_slots', 'get_available_slots', {
        orderId: target.orderId,
        preference: null,
        excludeWeekdays: null,
      });
    }
    const ids = ((slots['slots'] ?? []) as { slotId: string }[]).map((slot) => slot.slotId);
    if (ids.length === 0) return end('scripted:no_free_slot');
    const brief = context.rung?.brief ?? 'first_contact';
    const text =
      brief === 'other_times'
        ? SCRIPTED_COPY.otherTime[language]
        : brief === 'remove_friction'
          ? SCRIPTED_COPY.removeFriction[language]
          : brief === 'urgent_this_week'
            ? SCRIPTED_COPY.urgentThisWeek[language]
            : brief === 'urgent_other_hour'
              ? SCRIPTED_COPY.urgentOtherHour[language]
              : target.kind === 'test'
                ? SCRIPTED_COPY.firstContactTest[language]
                : SCRIPTED_COPY.firstContact[language](testsPending);
    return act('scripted:offer_rung', 'propose_slots', {
      orderId: target.orderId,
      slotIds: ids.slice(0, 2),
      text,
    });
  }

  // --- A patient message ------------------------------------------------------------------
  const inbound = context.latestPatientMessage;
  if (inbound === null) return end('scripted:no_patient_message');
  if (sentOk > 0 || sent >= 2) return end('scripted:answered');

  if (inbound.hasLabPhoto) {
    const match = last('match_result_to_order');
    if (match === undefined) {
      return act('scripted:match_photo', 'match_result_to_order', {
        messageId: inbound.id,
      });
    }
    const matches = (Array.isArray(match['matches']) ? match['matches'] : []) as {
      orderId: string;
    }[];
    if (
      match['isLabReport'] !== true ||
      matches.length === 0 ||
      match['nameOnReport'] === 'mismatch'
    ) {
      return act('scripted:photo_unusable', 'send_message', {
        text: SCRIPTED_COPY.photoUnreadable[language],
      });
    }
    const submitted = observations
      .filter((item) => item.tool === 'submit_fhir_result')
      .map((item) => item.body);
    const next = matches[submitted.length];
    if (next !== undefined) {
      return act('scripted:submit_result', 'submit_fhir_result', {
        orderId: next.orderId,
        messageId: inbound.id,
      });
    }
    const review = submitted.some((body) => body['doctorReview'] === 'requested');
    const upcoming = (
      Array.isArray(ordersBody['upcomingAppointments']) ? ordersBody['upcomingAppointments'] : []
    ) as { kind: string }[];
    const visitBooked =
      upcoming.some((item) => item.kind === 'visit') ||
      orders.some((order) => order.kind === 'visit' && order.stage === 'booked');
    return act('scripted:thank_photo', 'send_message', {
      text: SCRIPTED_COPY.photoReceived[language](review, visitBooked),
    });
  }

  const text = inbound.text;
  if (asksAboutResult(text)) {
    if (last('create_staff_task') === undefined) {
      return act('scripted:hand_over', 'create_staff_task', {
        reason: 'patient_question',
      });
    }
    return act('scripted:tell_handover', 'send_message', {
      text: SCRIPTED_COPY.handOver[language],
    });
  }

  const offer = [...context.conversation]
    .reverse()
    .find((message) => message.from === 'agent' && (message.offeredSlots?.length ?? 0) > 0);
  const offered = offer?.offeredSlots ?? [];

  const booking = last('create_appointment');
  if (booking !== undefined) {
    if (booking['booked'] === true) {
      return act('scripted:confirm_booking', 'send_message', {
        text: SCRIPTED_COPY.booked[language](
          typeof booking['where'] === 'string' ? booking['where'] : '',
          testPending,
        ),
      });
    }
    return act('scripted:booking_refused', 'send_message', {
      text: SCRIPTED_COPY.whichOne[language],
    });
  }

  const excluded = isNegative(text) ? weekdaysIn(text) : [];
  if (isNegative(text) && offered[0] !== undefined) {
    const slots = last('get_available_slots');
    if (slots === undefined) {
      return act('scripted:find_other_slots', 'get_available_slots', {
        orderId: offered[0].orderId,
        preference: excluded.length > 0 ? 'earliest' : 'other_time',
        excludeWeekdays: excluded.length > 0 ? excluded : null,
      });
    }
    const ids = ((slots['slots'] ?? []) as { slotId: string }[]).map((slot) => slot.slotId);
    if (ids.length === 0) return end('scripted:no_free_slot');
    return act('scripted:offer_options', 'propose_slots', {
      orderId: offered[0].orderId,
      slotIds: ids.slice(0, 2),
      text: SCRIPTED_COPY.newOptions[language](alreadyDidTest(text) && testPending),
    });
  }

  const option = offered.length > 0 ? chosenOption(text, offered.length) : undefined;
  const chosen = option === undefined ? undefined : offered[option - 1];
  if (chosen !== undefined) {
    return act('scripted:book_choice', 'create_appointment', {
      orderId: chosen.orderId,
      slotId: chosen.slotId,
      confirmationMessageId: inbound.id,
    });
  }
  if (offered.length > 1 && isAffirmative(text)) {
    return act('scripted:ask_which', 'send_message', {
      text: SCRIPTED_COPY.whichOne[language],
    });
  }
  return act('scripted:acknowledge', 'send_message', { text: SCRIPTED_COPY.thanks[language] });
};
