import { z } from 'zod';
import type { OrderAgentToolDefinition } from '../../ports/order-agent.ts';
import { SLOT_PREFERENCES, WEEKDAY_NAMES } from './slots.ts';

/**
 * The agent's tools (docs/agent/order-to-completion.md#tools). Arguments
 * are validated with these schemas before any tool runs; every one is
 * closed (strict-compatible for providers with strict tool schemas).
 */
export const ORDER_AGENT_TOOL_NAMES = [
  'list_open_orders',
  'read_patient_summary',
  'get_contact_policy',
  'get_available_slots',
  'send_message',
  'propose_slots',
  'create_appointment',
  'match_result_to_order',
  'submit_fhir_result',
  'create_staff_task',
  'end_turn',
] as const;
export type OrderAgentToolName = (typeof ORDER_AGENT_TOOL_NAMES)[number];

export const END_TURN_TOOL = 'end_turn';

const NoArgs = z.object({}).strict();

const OrderId = z.string().min(1).max(80).describe('An orderId from list_open_orders');
const MessageId = z.string().min(1).max(80).describe('A message id from the conversation');
const Text = z
  .string()
  .min(1)
  .max(600)
  .describe(
    'The message to the patient, in their language. Write {first_name} where their name goes. ' +
      'No results, values, diagnoses or condition names.',
  );

export const GetAvailableSlotsArgs = z
  .object({
    orderId: OrderId,
    preference: z
      .enum(SLOT_PREFERENCES)
      .nullable()
      .describe('How to choose: the rung suggests one; null = the rung default'),
    excludeWeekdays: z
      .array(z.enum(WEEKDAY_NAMES))
      .max(6)
      .nullable()
      .describe('Weekdays the patient said they cannot make, or null'),
  })
  .strict();

export const SendMessageArgs = z.object({ text: Text }).strict();

export const ProposeSlotsArgs = z
  .object({
    orderId: OrderId,
    slotIds: z
      .array(z.string().min(1).max(60))
      .min(1)
      .max(3)
      .describe('Slot ids returned by get_available_slots in this turn'),
    text: Text.describe(
      'Short lead-in in the patient language; code appends the numbered list of the slots. ' +
        'Write {first_name} where their name goes. Do not write the dates or times yourself.',
    ),
  })
  .strict();

export const CreateAppointmentArgs = z
  .object({
    orderId: OrderId,
    slotId: z.string().min(1).max(60).describe('The offered slot the patient chose'),
    confirmationMessageId: MessageId.describe(
      "The id of the patient's message that explicitly confirms that slot",
    ),
  })
  .strict();

export const MatchResultArgs = z
  .object({ messageId: MessageId.describe('The id of the patient message with the photo') })
  .strict();

export const SubmitResultArgs = z
  .object({
    orderId: OrderId,
    messageId: MessageId.describe('The id of the patient message with the photo'),
  })
  .strict();

export const CreateStaffTaskArgs = z
  .object({
    reason: z
      .enum(['patient_question', 'patient_request'])
      .describe('patient_question: asks something only the clinic team can answer'),
  })
  .strict();

export const EndTurnArgs = z
  .object({ summary: z.string().min(1).max(300).describe('What this turn did, for the trace') })
  .strict();

export const ORDER_AGENT_TOOLS: readonly OrderAgentToolDefinition[] = [
  {
    name: 'list_open_orders',
    description:
      "The doctor's orders this patient still has to complete (only these: never invent another goal), with what each asks for, its due date and its stage.",
    parameters: NoArgs,
    terminal: false,
  },
  {
    name: 'read_patient_summary',
    description:
      'A pseudonymous summary: age, sex, language, time since the last visit, upcoming appointments. No name, no phone.',
    parameters: NoArgs,
    terminal: false,
  },
  {
    name: 'get_contact_policy',
    description:
      'Whether a message may be sent now (cap of proactive messages, reply window, opt-out, phone status) and the ladder rung this turn applies.',
    parameters: NoArgs,
    terminal: false,
  },
  {
    name: 'get_available_slots',
    description:
      "Two or three free slots for an order, computed by code from the treating professional's or the lab's schedule.",
    parameters: GetAvailableSlotsArgs,
    terminal: false,
  },
  {
    name: 'send_message',
    description:
      'Sends a WhatsApp message to the patient (no slots). Code checks it first: no results, values, diagnoses or condition names, and the contact policy.',
    parameters: SendMessageArgs,
    terminal: false,
  },
  {
    name: 'propose_slots',
    description:
      'Sends a message offering slots for an order; code appends them as a numbered list (date, time, place).',
    parameters: ProposeSlotsArgs,
    terminal: false,
  },
  {
    name: 'create_appointment',
    description:
      "Books an offered slot. Only after the patient's latest message explicitly confirms that slot: code verifies the slot was offered, is free, and the message is a yes for it.",
    parameters: CreateAppointmentArgs,
    terminal: false,
  },
  {
    name: 'match_result_to_order',
    description:
      'Which open order a lab report photo the patient sent answers (read by the vision model; values are not shown to you).',
    parameters: MatchResultArgs,
    terminal: false,
  },
  {
    name: 'submit_fhir_result',
    description:
      'Submits the result read from the photo to the engine as a FHIR Observation. The engine, not you, decides whether the order is fulfilled.',
    parameters: SubmitResultArgs,
    terminal: false,
  },
  {
    name: 'create_staff_task',
    description:
      'Hands the conversation to the clinic team (a task for reception) when the patient asks something you must not answer (a result, a symptom, a treatment).',
    parameters: CreateStaffTaskArgs,
    terminal: false,
  },
  {
    name: 'end_turn',
    description: 'Ends this turn. Call it once everything this turn needs is done.',
    parameters: EndTurnArgs,
    terminal: true,
  },
];
