import type { AgentConversation, AgentMessage } from '../../domain/order-agent.ts';
import { fold } from './confirmation.ts';

/**
 * The contact policy (docs/agent/order-to-completion.md#contact-policy),
 * enforced by code on every send whatever the model asks:
 *
 * - At most {@link MAX_PROACTIVE_PER_WINDOW} proactive messages per patient
 *   per rolling {@link WINDOW_DAYS} days. A message is proactive unless the
 *   patient wrote within the last {@link REPLY_WINDOW_HOURS} hours (then it
 *   is a reply, like WhatsApp's customer-service window).
 * - At most {@link MAX_REPLIES_PER_INBOUND} replies per patient message.
 * - Nothing after an opt-out, nothing while the phone is undelivered.
 */
export const MAX_PROACTIVE_PER_WINDOW = 2;
export const WINDOW_DAYS = 7;
export const REPLY_WINDOW_HOURS = 24;
export const MAX_REPLIES_PER_INBOUND = 3;

const DAY_MS = 86_400_000;

export type SendBlock = 'opted_out' | 'phone_undelivered' | 'cap_reached' | 'reply_limit';

export interface ContactPolicyView {
  readonly optedOut: boolean;
  readonly phoneUndelivered: boolean;
  /** `reply` inside the patient's reply window, otherwise `proactive`. */
  readonly sendKind: 'reply' | 'proactive';
  readonly proactiveSentInWindow: number;
  readonly proactiveRemaining: number;
  /** When the next proactive message is allowed (now, when one is left). */
  readonly nextProactiveAllowedAt: Date;
  readonly repliesLeft: number;
  readonly canSend: boolean;
  readonly block?: SendBlock;
}

/** The policy as of `now`, from the conversation's messages (any order). */
export function contactPolicy(
  conversation: Pick<AgentConversation, 'status' | 'phoneStatus'>,
  messages: readonly AgentMessage[],
  now: Date,
): ContactPolicyView {
  const sorted = [...messages].sort((left, right) => left.at.getTime() - right.at.getTime());
  const lastInbound = sorted.findLast((message) => message.direction === 'inbound');
  const inReplyWindow =
    lastInbound !== undefined &&
    now.getTime() - lastInbound.at.getTime() <= REPLY_WINDOW_HOURS * 3_600_000;
  const windowStart = now.getTime() - WINDOW_DAYS * DAY_MS;
  const proactive = sorted.filter(
    (message) =>
      message.direction === 'outbound' &&
      message.proactive === true &&
      message.at.getTime() > windowStart,
  );
  const remaining = Math.max(0, MAX_PROACTIVE_PER_WINDOW - proactive.length);
  const oldest = proactive[0];
  const nextProactiveAllowedAt =
    remaining > 0 || oldest === undefined
      ? now
      : new Date(oldest.at.getTime() + WINDOW_DAYS * DAY_MS);
  const repliesSince =
    lastInbound === undefined
      ? 0
      : sorted.filter(
          (message) =>
            message.direction === 'outbound' && message.at.getTime() >= lastInbound.at.getTime(),
        ).length;
  const repliesLeft = Math.max(0, MAX_REPLIES_PER_INBOUND - repliesSince);
  const optedOut = conversation.status === 'opted_out';
  const phoneUndelivered = conversation.phoneStatus === 'undelivered';
  const sendKind = inReplyWindow ? 'reply' : 'proactive';
  let block: SendBlock | undefined;
  if (optedOut) block = 'opted_out';
  else if (phoneUndelivered) block = 'phone_undelivered';
  else if (sendKind === 'proactive' && remaining === 0) block = 'cap_reached';
  else if (sendKind === 'reply' && repliesLeft === 0) block = 'reply_limit';
  return {
    optedOut,
    phoneUndelivered,
    sendKind,
    proactiveSentInWindow: proactive.length,
    proactiveRemaining: remaining,
    nextProactiveAllowedAt,
    repliesLeft,
    canSend: block === undefined,
    ...(block === undefined ? {} : { block }),
  };
}

const OPT_OUT_PHRASES = [
  'stop',
  'baja',
  'darme de baja',
  'no me escriban',
  'no me escribas',
  'no me escriba',
  'no quiero mensajes',
  'no quiero que me escriban',
  'dejen de escribirme',
  'deja de escribirme',
  'no me contacten',
  'unsubscribe',
  'do not contact me',
  'don t contact me',
  'don t text me',
  'stop texting me',
  'stop messaging me',
];

/** Whether a patient's message asks the clinic to stop writing (detected by code, not by the model). */
export function isOptOut(text: string): boolean {
  const folded = fold(text);
  return OPT_OUT_PHRASES.some((phrase) => folded.includes(` ${fold(phrase).trim()} `));
}
