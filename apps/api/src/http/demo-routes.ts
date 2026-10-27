import { randomUUID } from 'node:crypto';
import type { FakeClock, NoteExtraction } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { type EngineRuntime, Worker } from '@follow-up-engine/runtime';
import { InboxPresenter } from '../inbox/presenter.ts';
import { icd10Label } from '../inbox/terminology.ts';
import type { App } from './context.ts';
import { HttpError, readJson, readQuery } from './errors.ts';
import { requireScope } from './security.ts';
import {
  AdvanceClockRequestSchema,
  type DemoConsultationResponse,
  DemoConsultationRequestSchema,
  WebhookQuerySchema,
  type WebhookDelivery,
} from './schemas.ts';

const DEFAULT_PATIENT_NAME = 'Paciente de demostración';

function extractionView(
  extraction: NoteExtraction,
  latencyMs: number,
): DemoConsultationResponse['extraction'] {
  return {
    model: extraction.model,
    hasPlan: extraction.hasPlan,
    conditions: extraction.conditions.map((condition) => ({
      code: {
        system: condition.code.system,
        code: condition.code.code,
        // The model writes standard (English) displays: the clinic reads Spanish names.
        display: icd10Label(condition.code.code, condition.code.display),
      },
      confidence: condition.confidence,
      evidenceQuote: condition.evidenceQuote,
    })),
    medications: extraction.medications.map((medication) => ({
      text: medication.text,
      ...(medication.durationDays === undefined ? {} : { durationDays: medication.durationDays }),
      evidenceQuote: medication.evidenceQuote,
    })),
    planItems: extraction.planItems.map((item) => ({
      kind: item.kind,
      description: item.description,
      dueAt: item.dueAt.toISOString(),
      evidenceQuote: item.evidenceQuote,
      confidence: item.confidence,
    })),
    costUsd: extraction.costUsd,
    latencyMs,
  };
}

async function remoteDeliveries(
  sinkUrl: string,
  clinicId: string,
  limit: number,
  type: string | undefined,
): Promise<WebhookDelivery[]> {
  const url = new URL('/deliveries', sinkUrl);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('clinicId', clinicId);
  if (type !== undefined) {
    url.searchParams.set('type', type);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new HttpError(502, 'webhook_sink_unavailable', 'El receptor de webhooks no respondió.');
  }
  const body = (await response.json()) as { items?: WebhookDelivery[] };
  return body.items ?? [];
}

/**
 * Demo controls, registered only when the engine runs on a fake clock
 * (`CLOCK=fake`); with a real clock these routes do not exist (404).
 */
export function registerDemoRoutes(
  app: App,
  runtime: EngineRuntime,
  clock: FakeClock,
  worker: Worker = new Worker(runtime),
): void {
  // Reading the demo clock and webhooks: `inbox:read`; moving the shared
  // clock or saving a demo consultation: `demo` (never any clinic's key).
  app.use('/api/demo/*', requireScope({ demoRoutes: true }));
  app.get('/api/demo/clock', (c) => c.json({ now: clock.now().toISOString(), fake: true }));

  app.post('/api/demo/clock/advance', async (c) => {
    const { days } = await readJson(c, AdvanceClockRequestSchema);
    // Day by day, as the hourly sweeps would: cases open on the day their
    // expectation expires and escalate on schedule, not all at the end.
    // Webhooks go out at the end of each day, so the host sees them on the
    // simulated timeline. The clock is the whole process's, so every clinic
    // is swept (only keys with the `demo` scope get here).
    let webhooks = 0;
    for (let day = 0; day < days; day += 1) {
      clock.advance({ days: 1 });
      await worker.runJobs();
      await worker.runSweeps();
      webhooks += (await worker.deliverOutbox()).delivered;
    }
    c.var.log.info({ days, webhooks }, 'demo clock advanced');
    return c.json({ now: clock.now().toISOString() });
  });

  app.post('/api/demo/consultations', async (c) => {
    const body = await readJson(c, DemoConsultationRequestSchema);
    const isNewPatient = body.patientId === undefined;
    const patientId = body.patientId ?? `pat-demo-${randomUUID().slice(0, 8)}`;
    const bundle = buildConsultationBundle({
      consultationId: `demo-${randomUUID()}`,
      patient: {
        id: patientId,
        ...(isNewPatient ? { name: body.patientName ?? DEFAULT_PATIENT_NAME } : {}),
      },
      specialty: body.specialty,
      occurredAt: clock.now(),
      noteText: body.noteText,
      orders: (body.orders ?? []).map((order) => ({ ...order, category: 'laboratory' as const })),
    });
    const acceptance = await runtime.ingestion.accept(c.var.clinicId, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(
        422,
        'invalid_consultation',
        'No pudimos armar la consulta con esos datos.',
      );
    }
    const reports = acceptance.reports ?? [];
    const note = reports.flatMap((report) => report.notes)[0];
    if (note?.status === 'failed' || note?.extraction === undefined) {
      c.var.log.warn(
        { provider: runtime.extractor.provider, error: note?.error },
        'demo extraction failed',
      );
      throw new HttpError(
        502,
        'llm_unavailable',
        `El modelo (${runtime.extractor.provider}/${runtime.extractor.model}) no pudo leer la nota: ` +
          `${note?.error ?? 'sin respuesta'}. La consulta quedó guardada y la lectura del plan ` +
          'se reintentará automáticamente.',
      );
    }
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId);
    const response: DemoConsultationResponse = {
      bundle,
      extraction: extractionView(note.extraction, note.latencyMs ?? 0),
      expectationsCreated: reports
        .flatMap((report) => report.expectationsCreated)
        .map((expectation) => ({
          id: expectation.id,
          ruleId: expectation.ruleId,
          layer: expectation.layer,
          label: presenter.reasonLabel(expectation.ruleId, expectation),
          dueAt: expectation.dueAt.toISOString(),
        })),
    };
    return c.json(response, 201);
  });

  app.get('/api/demo/webhooks', async (c) => {
    const { limit, type } = readQuery(c, WebhookQuerySchema);
    const { sink } = runtime;
    const sinkUrl = runtime.config.webhooks.sinkUrl;
    const items: WebhookDelivery[] =
      sink !== undefined
        ? sink
            .list({ limit, clinicId: c.var.clinicId, ...(type === undefined ? {} : { type }) })
            .map((delivery) => ({
              at: delivery.at,
              type: delivery.type,
              payload: delivery.payload,
              signatureValid: delivery.signatureValid,
              delivered: delivery.delivered,
            }))
        : sinkUrl === undefined
          ? []
          : await remoteDeliveries(sinkUrl, c.var.clinicId, limit, type);
    return c.json({ items });
  });
}
