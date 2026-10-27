import {
  type ClinicId,
  type Clock,
  type DomainEvent,
  type EventPublisher,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { toWebhookBody } from './payload.ts';
import { signWebhook, WEBHOOK_HEADERS } from './signature.ts';

/** A signed webhook request, ready to send. */
export interface SignedWebhook {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

/** Serializes and signs a domain event exactly as it goes on the wire. */
export function buildSignedWebhook(event: DomainEvent, secret: string, now: Date): SignedWebhook {
  const rawBody = JSON.stringify(toWebhookBody(event));
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'follow-up-engine-webhooks/1',
      [WEBHOOK_HEADERS.event]: event.type,
      [WEBHOOK_HEADERS.delivery]: event.id,
      [WEBHOOK_HEADERS.timestamp]: timestamp,
      [WEBHOOK_HEADERS.signature]: signWebhook(secret, {
        timestamp,
        deliveryId: event.id,
        rawBody,
      }),
    },
  };
}

/** The host refused or did not answer a webhook; the outbox retries it with backoff. */
export class WebhookDeliveryError extends Error {
  override readonly name = 'WebhookDeliveryError';
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}

export interface WebhookPublisherOptions {
  readonly url: string;
  readonly secret: string;
  /** Wall clock for `X-FollowUp-Timestamp` (the real send time, even under a fake engine clock). */
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/**
 * {@link EventPublisher} that POSTs each outbox event to the host as a signed
 * webhook. Any non-2xx answer or network failure throws, so the outbox
 * relay schedules a retry with exponential backoff (at least once delivery;
 * the host deduplicates on `X-FollowUp-Delivery`).
 */
export function createWebhookPublisher(options: WebhookPublisherOptions): EventPublisher {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async publish(clinicId: ClinicId, event: DomainEvent): Promise<void> {
      if (event.clinicId !== clinicId) {
        throw new TenantMismatchError();
      }
      const webhook = buildSignedWebhook(event, options.secret, options.clock?.now() ?? new Date());
      let response: Response;
      try {
        response = await send(options.url, {
          method: 'POST',
          headers: webhook.headers,
          body: webhook.rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new WebhookDeliveryError(
          `Webhook ${event.type} not delivered: network error`,
          undefined,
          {
            cause: error,
          },
        );
      }
      await response.body?.cancel();
      if (!response.ok) {
        throw new WebhookDeliveryError(
          `Webhook ${event.type} refused with HTTP ${String(response.status)}`,
          response.status,
        );
      }
    },
  };
}
