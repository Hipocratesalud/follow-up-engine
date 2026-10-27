import { createHmac, timingSafeEqual } from 'node:crypto';

/** Headers of every webhook the engine sends. */
export const WEBHOOK_HEADERS = {
  event: 'x-followup-event',
  delivery: 'x-followup-delivery',
  timestamp: 'x-followup-timestamp',
  signature: 'x-followup-signature',
} as const;

const PREFIX = 'sha256=';

/** What a webhook signature covers: when it was sent, which delivery, and the exact bytes. */
export interface SignedParts {
  /** `X-FollowUp-Timestamp`: Unix seconds. */
  readonly timestamp: string;
  /** `X-FollowUp-Delivery`: the event id, stable across redeliveries. */
  readonly deliveryId: string;
  /** The raw request body, before any JSON parsing. */
  readonly rawBody: string;
}

/** Default freshness window of {@link verifyWebhookSignature}: 5 minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * `sha256=<hex HMAC-SHA256 of "<timestamp>.<deliveryId>.<rawBody>">`, the
 * value of `X-FollowUp-Signature`. Covering the timestamp and the delivery id
 * means a captured webhook cannot be replayed with a fresh timestamp or a new
 * delivery id: either change breaks the signature.
 */
export function signWebhook(secret: string, parts: SignedParts): string {
  const signed = `${parts.timestamp}.${parts.deliveryId}.${parts.rawBody}`;
  return `${PREFIX}${createHmac('sha256', secret).update(signed, 'utf8').digest('hex')}`;
}

/**
 * Checks a webhook the way a host must: the signature over timestamp,
 * delivery id and the exact bytes received (constant time), and, with
 * `now`, that the timestamp is within `toleranceSeconds` of it (default 5
 * minutes). Then deduplicate on the delivery id, which the signature covers.
 */
export function verifyWebhookSignature(
  secret: string,
  request: Partial<SignedParts> & { readonly signature: string | null | undefined },
  options: { readonly now?: Date; readonly toleranceSeconds?: number } = {},
): boolean {
  const { signature, timestamp, deliveryId, rawBody } = request;
  if (
    signature?.startsWith(PREFIX) !== true ||
    timestamp === undefined ||
    !/^\d{1,12}$/.test(timestamp) ||
    deliveryId === undefined ||
    deliveryId === '' ||
    rawBody === undefined
  ) {
    return false;
  }
  if (options.now !== undefined) {
    const age = Math.abs(options.now.getTime() / 1000 - Number(timestamp));
    if (age > (options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) {
      return false;
    }
  }
  const expected = Buffer.from(signWebhook(secret, { timestamp, deliveryId, rawBody }), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
