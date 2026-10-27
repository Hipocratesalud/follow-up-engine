import { createHmac, timingSafeEqual } from 'node:crypto';

/** Headers of every webhook the engine sends. */
export const WEBHOOK_HEADERS = {
  event: 'x-followup-event',
  delivery: 'x-followup-delivery',
  timestamp: 'x-followup-timestamp',
  signature: 'x-followup-signature',
} as const;

const PREFIX = 'sha256=';

/** `sha256=<hex HMAC-SHA256 of the raw body>`, the value of `X-FollowUp-Signature`. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `${PREFIX}${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * Checks a signature against the raw body, in constant time. Verify the
 * exact bytes received, before parsing the JSON.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null | undefined,
): boolean {
  if (signature?.startsWith(PREFIX) !== true) {
    return false;
  }
  const expected = Buffer.from(signWebhookBody(secret, rawBody), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
