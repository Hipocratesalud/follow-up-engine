import type { CaseId, ClinicId, DomainEvent, PatientId } from '@follow-up-engine/core';
import { describe, expect, it, vi } from 'vitest';
import { toWebhookBody } from './payload.ts';
import { buildSignedWebhook, createWebhookPublisher, WebhookDeliveryError } from './publisher.ts';
import { signWebhookBody, verifyWebhookSignature, WEBHOOK_HEADERS } from './signature.ts';
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
  it('signs the raw body with HMAC-SHA256 and verifies it in constant time', () => {
    const signature = signWebhookBody('secret', '{"a":1}');
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature('secret', '{"a":1}', signature)).toBe(true);
    expect(verifyWebhookSignature('other', '{"a":1}', signature)).toBe(false);
    expect(verifyWebhookSignature('secret', '{"a":2}', signature)).toBe(false);
    expect(verifyWebhookSignature('secret', '{"a":1}', undefined)).toBe(false);
    expect(verifyWebhookSignature('secret', '{"a":1}', 'sha256=short')).toBe(false);
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

  it('sends the delivery id, event type, timestamp and signature headers', () => {
    const webhook = buildSignedWebhook(opened, 'secret', new Date('2026-01-21T12:00:05Z'));
    expect(webhook.headers[WEBHOOK_HEADERS.delivery]).toBe('evt-1');
    expect(webhook.headers[WEBHOOK_HEADERS.event]).toBe('case.opened');
    expect(webhook.headers[WEBHOOK_HEADERS.timestamp]).toBe('1768996805');
    expect(
      verifyWebhookSignature('secret', webhook.rawBody, webhook.headers[WEBHOOK_HEADERS.signature]),
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
      verifyWebhookSignature('secret', init?.body as string, headers[WEBHOOK_HEADERS.signature]),
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
      (await post({ ...webhook.headers, [WEBHOOK_HEADERS.signature]: signWebhookBody('x', 'y') }))
        .status,
    ).toBe(401);
    const listed = (await (await app.request('/deliveries?clinicId=clinic-a')).json()) as {
      items: { signatureValid: boolean; duplicate: boolean; type: string }[];
    };
    expect(listed.items.map((item) => [item.signatureValid, item.duplicate])).toEqual([
      [false, false],
      [true, true],
      [true, false],
    ]);
  });

  it('receives in-process deliveries through the loopback publisher', async () => {
    const sink = new WebhookSink({ secret: 'secret' });
    await createLoopbackPublisher(sink, 'secret').publish(clinic, opened);
    expect(sink.list()).toMatchObject([{ type: 'case.opened', signatureValid: true }]);
    await expect(createLoopbackPublisher(sink, 'wrong').publish(clinic, opened)).rejects.toThrow();
  });
});
