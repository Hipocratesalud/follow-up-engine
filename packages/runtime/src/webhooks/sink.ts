import {
  type ClinicId,
  type DomainEvent,
  type EventPublisher,
  TenantMismatchError,
} from '@follow-up-engine/core';
import { Hono } from 'hono';
import { buildSignedWebhook, type SignedWebhook } from './publisher.ts';
import { verifyWebhookSignature, WEBHOOK_HEADERS } from './signature.ts';

/** One webhook the sink received. */
export interface SinkDelivery {
  /** When the sink received it (wall clock). */
  readonly at: string;
  readonly deliveryId: string | undefined;
  readonly type: string;
  readonly clinicId: string | undefined;
  readonly payload: unknown;
  readonly signatureValid: boolean;
  /** False when the sink rejected it (bad signature or body). */
  readonly delivered: boolean;
  /** Same `X-FollowUp-Delivery` seen before (an at-least-once redelivery). */
  readonly duplicate: boolean;
}

export interface WebhookSinkOptions {
  readonly secret: string;
  /** Deliveries kept, newest first. Default 200. */
  readonly capacity?: number;
  readonly now?: () => Date;
}

function header(
  headers: Readonly<Record<string, string>> | Headers,
  name: string,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function parse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function clinicOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'clinicId' in payload) {
    return typeof payload.clinicId === 'string' ? payload.clinicId : undefined;
  }
  return undefined;
}

/**
 * A stand-in for the host's webhook endpoint (development and demo): checks
 * each signature exactly as a host must, and keeps the last deliveries so the
 * demo can show what the host received.
 */
export class WebhookSink {
  readonly #secret: string;
  readonly #capacity: number;
  readonly #now: () => Date;
  readonly #deliveries: SinkDelivery[] = [];
  readonly #seen = new Set<string>();

  constructor(options: WebhookSinkOptions) {
    this.#secret = options.secret;
    this.#capacity = options.capacity ?? 200;
    this.#now = options.now ?? (() => new Date());
  }

  /** Receives one webhook; `accepted` is what the HTTP status should say. */
  receive(request: {
    readonly headers: Readonly<Record<string, string>> | Headers;
    readonly rawBody: string;
  }): { readonly accepted: boolean; readonly delivery: SinkDelivery } {
    const signatureValid = verifyWebhookSignature(
      this.#secret,
      request.rawBody,
      header(request.headers, WEBHOOK_HEADERS.signature),
    );
    const payload = parse(request.rawBody);
    const deliveryId = header(request.headers, WEBHOOK_HEADERS.delivery);
    const accepted = signatureValid && payload !== undefined;
    const duplicate = accepted && deliveryId !== undefined && this.#seen.has(deliveryId);
    if (accepted && deliveryId !== undefined) {
      this.#seen.add(deliveryId);
    }
    const delivery: SinkDelivery = {
      at: this.#now().toISOString(),
      deliveryId,
      type: header(request.headers, WEBHOOK_HEADERS.event) ?? 'unknown',
      clinicId: clinicOf(payload),
      payload: payload ?? request.rawBody,
      signatureValid,
      delivered: accepted,
      duplicate,
    };
    this.#deliveries.unshift(delivery);
    this.#deliveries.length = Math.min(this.#deliveries.length, this.#capacity);
    return { accepted, delivery };
  }

  /** Hands a signed webhook straight to the sink (in-process demo, no network). */
  receiveSigned(webhook: SignedWebhook): { readonly accepted: boolean } {
    return this.receive({ headers: webhook.headers, rawBody: webhook.rawBody });
  }

  /** Newest first; only one clinic and one event type when given. */
  list(
    options: { readonly limit?: number; readonly clinicId?: string; readonly type?: string } = {},
  ): SinkDelivery[] {
    return this.#deliveries
      .filter((item) => options.clinicId === undefined || item.clinicId === options.clinicId)
      .filter((item) => options.type === undefined || item.type === options.type)
      .slice(0, options.limit ?? 50);
  }

  clear(): void {
    this.#deliveries.length = 0;
    this.#seen.clear();
  }
}

/** Path the sink listens on, like a host would. */
export const WEBHOOK_SINK_PATH = '/webhooks/follow-up-engine';

/**
 * HTTP face of a {@link WebhookSink}: `POST /webhooks/follow-up-engine`
 * (204, or 401 on a bad signature) and `GET /deliveries?limit=&clinicId=&type=`.
 */
export function createWebhookSinkApp(sink: WebhookSink): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.post(WEBHOOK_SINK_PATH, async (c) => {
    const { accepted } = sink.receive({ headers: c.req.raw.headers, rawBody: await c.req.text() });
    return accepted ? c.body(null, 204) : c.json({ error: 'invalid signature' }, 401);
  });
  app.get('/deliveries', (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const clinicId = c.req.query('clinicId');
    const type = c.req.query('type');
    return c.json({
      items: sink.list({
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50,
        ...(clinicId === undefined ? {} : { clinicId }),
        ...(type === undefined || type === '' ? {} : { type }),
      }),
    });
  });
  return app;
}

/**
 * {@link EventPublisher}-compatible loopback: signs each event exactly as the
 * HTTP publisher would and hands it to an in-process sink. Used by the
 * single-process demo, so signatures are still produced and verified.
 */
export function createLoopbackPublisher(
  sink: WebhookSink,
  secret: string,
  now: () => Date = () => new Date(),
): EventPublisher {
  return {
    publish(clinicId: ClinicId, event: DomainEvent): Promise<void> {
      if (event.clinicId !== clinicId) {
        return Promise.reject(new TenantMismatchError());
      }
      const { accepted } = sink.receiveSigned(buildSignedWebhook(event, secret, now()));
      return accepted
        ? Promise.resolve()
        : Promise.reject(new Error(`Webhook sink refused ${event.type}`));
    },
  };
}
