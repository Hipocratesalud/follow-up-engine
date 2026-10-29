import { randomUUID } from 'node:crypto';
import type { FakeClock, NoteExtraction } from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { DEMO_CLINIC, type EngineRuntime, Worker } from '@follow-up-engine/runtime';
import type { ApiMessages } from '../i18n/index.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import { icd10Label, loincLabel } from '../inbox/terminology.ts';
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

/** Terminology URI the extractor codes a named test against (`packages/llm`'s `LOINC_SYSTEM`). */
const LOINC_SYSTEM = 'http://loinc.org';

/** The named test or procedure a plan item codes, in the clinic's language, when known. */
function planItemTestName(
  t: ApiMessages,
  code: { readonly system: string; readonly code: string } | undefined,
): string | undefined {
  return code?.system === LOINC_SYSTEM ? loincLabel(t, code.code) : undefined;
}

export function extractionView(
  t: ApiMessages,
  extraction: NoteExtraction,
  latencyMs: number,
): DemoConsultationResponse['extraction'] {
  return {
    model: extraction.model,
    hasPlan: extraction.hasPlan,
    ...(extraction.noteLanguage === undefined ? {} : { noteLanguage: extraction.noteLanguage }),
    conditions: extraction.conditions.map((condition) => ({
      code: {
        system: condition.code.system,
        code: condition.code.code,
        // The clinic reads the code's name in its language; the quote stays verbatim.
        display: icd10Label(t, condition.code.code, condition.code.display),
      },
      confidence: condition.confidence,
      evidenceQuote: condition.evidenceQuote,
    })),
    medications: extraction.medications.map((medication) => ({
      text: medication.text,
      ...(medication.durationDays === undefined ? {} : { durationDays: medication.durationDays }),
      evidenceQuote: medication.evidenceQuote,
    })),
    planItems: extraction.planItems.map((item) => {
      // The named test, in the clinic's language, when the extractor
      // mapped one: "Laboratorio: HbA1c" and "Laboratorio: Perfil
      // lipídico" instead of two identical "Laboratorio" items, the same
      // table the expectations list reads (`loincLabel`). Absent when the
      // item is generic (a plain follow-up visit) or the code is unknown.
      const testName = planItemTestName(t, item.code);
      return {
        kind: item.kind,
        description: item.description,
        dueAt: item.dueAt.toISOString(),
        evidenceQuote: item.evidenceQuote,
        confidence: item.confidence,
        ...(testName === undefined ? {} : { testName }),
      };
    }),
    costUsd: extraction.costUsd,
    latencyMs,
  };
}

async function remoteDeliveries(
  t: ApiMessages,
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
    throw new HttpError(502, 'webhook_sink_unavailable', t.errors.webhookSinkUnavailable);
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
  // Reading the demo clock: `inbox:read`; the webhook feed and moving the
  // shared clock: `demo:clock`; saving a demo consultation: `demo:ingest`,
  // and only into the demo clinic.
  app.use('/api/demo/*', requireScope({ demoRoutes: true }));
  app.get('/api/demo/clock', (c) => c.json({ now: clock.now().toISOString(), fake: true }));

  app.post('/api/demo/clock/advance', async (c) => {
    const { days } = await readJson(c, AdvanceClockRequestSchema);
    // Day by day, as the hourly sweeps would: cases open on the day their
    // expectation expires and escalate on schedule, not all at the end.
    // Webhooks go out at the end of each day, so the host sees them on the
    // simulated timeline. The clock is the whole process's, so every clinic
    // is swept (only keys with the `demo:clock` scope get here). Atomic: a
    // concurrent advance waits for this one.
    const { now, webhooks } = await worker.advanceFakeClock(days);
    c.var.log.info({ days, webhooks }, 'demo clock advanced');
    return c.json({ now: now.toISOString() });
  });

  app.post('/api/demo/consultations', async (c) => {
    // Clinical data for synthetic patients only: never another clinic's record.
    if (c.var.clinicId !== DEMO_CLINIC.id) {
      throw new HttpError(403, 'insufficient_scope', c.var.t.errors.demoClinicOnly);
    }
    const body = await readJson(c, DemoConsultationRequestSchema);
    const isNewPatient = body.patientId === undefined;
    const patientId = body.patientId ?? `pat-demo-${randomUUID().slice(0, 8)}`;
    const bundle = buildConsultationBundle({
      consultationId: `demo-${randomUUID()}`,
      patient: {
        id: patientId,
        ...(isNewPatient ? { name: body.patientName ?? c.var.t.people.demoPatient } : {}),
      },
      specialty: body.specialty,
      occurredAt: clock.now(),
      noteText: body.noteText,
      orders: (body.orders ?? []).map((order) => ({ ...order, category: 'laboratory' as const })),
    });
    const acceptance = await runtime.ingestion.accept(c.var.clinicId, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(422, 'invalid_consultation', c.var.t.errors.invalidConsultation);
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
        c.var.t.errors.noteNotRead(
          `${runtime.extractor.provider}/${runtime.extractor.model}`,
          note?.error,
        ),
      );
    }
    const presenter = await InboxPresenter.create(runtime, c.var.clinicId, c.var.t);
    const response: DemoConsultationResponse = {
      bundle,
      extraction: extractionView(c.var.t, note.extraction, note.latencyMs ?? 0),
      expectationsCreated: reports
        .flatMap((report) => report.expectationsCreated)
        .map((expectation) => {
          const protocol = presenter.protocolRef(expectation);
          return {
            id: expectation.id,
            ruleId: expectation.ruleId,
            layer: expectation.layer,
            label: presenter.reasonLabel(expectation.ruleId, expectation),
            ...(protocol === undefined ? {} : { protocol }),
            dueAt: expectation.dueAt.toISOString(),
          };
        }),
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
          : await remoteDeliveries(c.var.t, sinkUrl, c.var.clinicId, limit, type);
    return c.json({ items });
  });
}
