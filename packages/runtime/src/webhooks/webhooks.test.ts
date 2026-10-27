import type { CaseId, ClinicId, DomainEvent, PatientId } from '@follow-up-engine/core';
import { describe, expect, it, vi } from 'vitest';
import { toWebhookBody } from './payload.ts';
import { buildSignedWebhook, createWebhookPublisher, WebhookDeliveryError } from './publisher.ts';
import { signWebhook, verifyWebhookSignature, WEBHOOK_HEADERS } from './signature.ts';
import { createLoopbackPublisher, createWebhookSinkApp, WebhookSink } from './sink.ts';

const clinic = 'clinic-a' as ClinicId;
const opened: DomainEvent = {
  id: 'evt-1',
  type: 'case.opened',
  clinicId: clinic,
  occurredAt: new Date('2026-01-21T12:00:00Z'),
  payload: {
    caseId: 'case-1' as CaseId,
    patientId: 'pat-1' as PatientId,
    reasons: [{ code: 'protocol_diabetes_hba1c', label: 'Sin HbA1c reciente (cada 3 meses)' }],
    priority: 70,
    origin: 'live',
  },
};

describe('webhook signature', () => {
  const parts = { timestamp: '1768996805', deliveryId: 'evt-1', rawBody: '{"a":1}' };

  it('signs timestamp, delivery id and raw body with HMAC-SHA256, verified in constant time', () => {
    const signature = signWebhook('secret', parts);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('secret', { ...parts, signature })).toBe(true);
    expect(verifyWebhookSignature('other', { ...parts, signature })).toBe(false);
    expect(verifyWebhookSignature('secret', { ...parts, rawBody: '{"a":2}', signature })).toBe(
      false,
    );
    expect(verifyWebhookSignature('secret', { ...parts, signature: undefined })).toBe(false);
    expect(verifyWebhookSignature('secret', { ...parts, signature: 'sha256=short' })).toBe(false);
  });

  it('refuses a replay with a fresh timestamp or a new delivery id', () => {
    const signature = signWebhook('secret', parts);
    expect(verifyWebhookSignature('secret', { ...parts, timestamp: '1800000000', signature })).toBe(
      false,
    );
    expect(verifyWebhookSignature('secret', { ...parts, deliveryId: 'evt-2', signature })).toBe(
      false,
    );
  });

  it('refuses a stale delivery when given the current time', () => {
    const signature = signWebhook('secret', parts);
    const sent = new Date(Number(parts.timestamp) * 1000);
    expect(verifyWebhookSignature('secret', { ...parts, signature }, { now: sent })).toBe(true);
    const later = new Date(sent.getTime() + 301_000);
    expect(verifyWebhookSignature('secret', { ...parts, signature }, { now: later })).toBe(false);
  });
});

describe('webhook payloads', () => {
  it('never carry reason codes or labels (they can name a condition)', () => {
    const body = toWebhookBody(opened);
    expect(body).toEqual({
      id: 'evt-1',
      type: 'case.opened',
      clinicId: 'clinic-a',
      occurredAt: '2026-01-21T12:00:00.000Z',
      data: {
        caseId: 'case-1',
        patientId: 'pat-1',
        priority: 70,
        origin: 'live',
        reasonCount: 1,
        task: 'Task/case-1',
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/diabetes|HbA1c/i);
  });

  it('carries every backfill counter, and the reason when a run pauses', () => {
    const counts = {
      patientsScanned: 120,
      eventsProcessed: 5074,
      documentsProcessed: 671,
      expectationsCreated: 2207,
      expectationsFulfilled: 1793,
      casesOpened: 92,
      llmCostUsd: 1.34,
    };
    const occurredAt = new Date('2026-01-05T12:00:00Z');
    expect(
      toWebhookBody({
        id: 'evt-2',
        type: 'backfill.completed',
        clinicId: clinic,
        occurredAt,
        payload: {
          runId: 'run-1',
          shadow: false,
          casesScheduled: 92,
          casesNotNotified: 0,
          ...counts,
        },
      }).data,
    ).toEqual({
      runId: 'run-1',
      shadow: false,
      casesScheduled: 92,
      casesNotNotified: 0,
      ...counts,
    });
    expect(
      toWebhookBody({
        id: 'evt-3',
        type: 'backfill.paused',
        clinicId: clinic,
        occurredAt,
        payload: { runId: 'run-1', reason: 'llm_budget_exceeded', ...counts },
      }).data,
    ).toEqual({ runId: 'run-1', reason: 'llm_budget_exceeded', ...counts });
  });

  it('sends the delivery id, event type, timestamp and signature headers', () => {
    const webhook = buildSignedWebhook(opened, 'secret', new Date('2026-01-21T12:00:05Z'));
    expect(webhook.headers[WEBHOOK_HEADERS.delivery]).toBe('evt-1');
    expect(webhook.headers[WEBHOOK_HEADERS.event]).toBe('case.opened');
    expect(webhook.headers[WEBHOOK_HEADERS.timestamp]).toBe('1768996805');
    expect(
      verifyWebhookSignature('secret', {
        rawBody: webhook.rawBody,
        timestamp: '1768996805',
        deliveryId: 'evt-1',
        signature: webhook.headers[WEBHOOK_HEADERS.signature],
      }),
    ).toBe(true);
  });
});

describe('HTTP webhook publisher', () => {
  it('POSTs the signed body and throws on a non-2xx answer so the outbox retries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }));
    const publisher = createWebhookPublisher({
      url: 'https://host.example/webhooks',
      secret: 'secret',
      fetch: fetchMock,
    });
    await publisher.publish(clinic, opened);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://host.example/webhooks');
    const headers = init?.headers as Record<string, string>;
    expect(
      verifyWebhookSignature('secret', {
        rawBody: init?.body as string,
        ...(headers[WEBHOOK_HEADERS.timestamp] === undefined
          ? {}
          : { timestamp: headers[WEBHOOK_HEADERS.timestamp] }),
        deliveryId: 'evt-1',
        signature: headers[WEBHOOK_HEADERS.signature],
      }),
    ).toBe(true);
    await expect(publisher.publish(clinic, opened)).rejects.toBeInstanceOf(WebhookDeliveryError);
  });

  it('turns network errors into delivery errors', async () => {
    const publisher = createWebhookPublisher({
      url: 'https://host.example/webhooks',
      secret: 'secret',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(publisher.publish(clinic, opened)).rejects.toThrow(/network error/);
  });

  it('refuses an event of another clinic', async () => {
    const publisher = createWebhookPublisher({ url: 'https://h.example', secret: 's', fetch });
    await expect(publisher.publish('clinic-b' as ClinicId, opened)).rejects.toThrow();
  });
});

describe('webhook sink', () => {
  it('accepts signed deliveries, flags redeliveries and rejects bad signatures', async () => {
    const sink = new WebhookSink({ secret: 'secret' });
    const app = createWebhookSinkApp(sink);
    const webhook = buildSignedWebhook(opened, 'secret', new Date());
    const post = (headers: Record<string, string>): Promise<Response> =>
      Promise.resolve(
        app.request('/webhooks/follow-up-engine', {
          method: 'POST',
          headers,
          body: webhook.rawBody,
        }),
      );
    expect((await post({ ...webhook.headers })).status).toBe(204);
    expect((await post({ ...webhook.headers })).status).toBe(204);
    expect(
      (
        await post({
          ...webhook.headers,
          [WEBHOOK_HEADERS.signature]: signWebhook('x', {
            timestamp: '1',
            deliveryId: 'evt-1',
            rawBody: 'y',
          }),
        })
      ).status,
    ).toBe(401);
    // A captured delivery replayed later with fresh headers is refused.
    expect(
      (
        await post({
          ...webhook.headers,
          [WEBHOOK_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000) + 3_600),
          [WEBHOOK_HEADERS.delivery]: 'evt-REPLAYED',
        })
      ).status,
    ).toBe(401);
    const listed = (await (await app.request('/deliveries?clinicId=clinic-a')).json()) as {
      items: { signatureValid: boolean; duplicate: boolean; type: string }[];
    };
    expect(listed.items.map((item) => [item.signatureValid, item.duplicate])).toEqual([
      [false, false],
      [false, false],
      [true, true],
      [true, false],
    ]);
  });

  it('refuses stale deliveries when given a tolerance', () => {
    const sink = new WebhookSink({ secret: 'secret', toleranceSeconds: 300 });
    const stale = buildSignedWebhook(opened, 'secret', new Date(Date.now() - 600_000));
    expect(sink.receiveSigned(stale).accepted).toBe(false);
    const fresh = buildSignedWebhook(opened, 'secret', new Date());
    expect(sink.receiveSigned(fresh).accepted).toBe(true);
  });

  it('receives in-process deliveries through the loopback publisher', async () => {
    const sink = new WebhookSink({ secret: 'secret' });
    await createLoopbackPublisher(sink, 'secret').publish(clinic, opened);
    expect(sink.list()).toMatchObject([{ type: 'case.opened', signatureValid: true }]);
    await expect(createLoopbackPublisher(sink, 'wrong').publish(clinic, opened)).rejects.toThrow();
  });
});
