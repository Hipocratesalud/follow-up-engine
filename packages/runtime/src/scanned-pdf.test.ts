import {
  type ClinicId,
  FakeClock,
  patientId as toPatientId,
  type PatientId,
} from '@follow-up-engine/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { extractDocumentText, isScannedPdfText } from './documents.ts';
import { type HistoryDocument, importPatientHistory } from './history-import.ts';
import { ensureLabClinicAndClock } from './lab.ts';
import {
  HISTORY_SAMPLE_SETS,
  HISTORY_SCANNED_PDF,
  HISTORY_SCANNED_PDF_READING,
  readHistorySample,
  readSample,
} from './order-agent/samples.ts';
import { startOrderAgentStory } from './order-agent/story.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';
import { Worker } from './worker.ts';

/*
 * A scanned PDF (no text layer: each page an image) is read by Muse Spark
 * like a photo: the PDF goes as a `file` part through the `llm_gateway`,
 * under the same image guard (`allowUnmaskedImagesToProvider`), into the
 * same reading. A PDF with a text layer is unchanged: its text is extracted
 * locally, masked, and read as text.
 */

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const RAFAEL = 'Rafael Antonio Méndez';
const JORGE = 'Jorge Luis Salazar';
const TEXT_PDF = '2024-05-06-informe-laboratorio.pdf';

function day(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function sampleDocuments(setId: string, only?: readonly string[]): HistoryDocument[] {
  const set = HISTORY_SAMPLE_SETS.find((item) => item.id === setId);
  if (set === undefined) throw new Error(`No sample set ${setId}`);
  return set.files
    .filter((file) => only === undefined || only.includes(file.file))
    .map((file) => ({
      filename: file.file,
      contentType: file.contentType,
      data: readHistorySample(file.file),
      documentDate: day(file.documentDate),
      documentType: file.documentType,
      specialty: file.specialty,
    }));
}

/** Muse Spark's HTTP API, stubbed: records every request body that reaches the provider. */
function stubbedMuseSpark(reply: unknown): {
  readonly requests: string[];
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
} {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (_url, init) => {
      requests.push(init.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2687, completion_tokens: 603 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  };
}

async function liveRuntime(fetch: (input: string, init: RequestInit) => Promise<Response>) {
  runtime = await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      LLM_PROVIDER: 'meta',
      META_API_KEY: 'test-key',
      DATABASE_URL: '',
    }),
    { llmFetch: fetch },
  );
  return runtime;
}

async function regularClinic(rt: EngineRuntime): Promise<ClinicId> {
  const clinic = await rt.registerClinic({
    id: `clinic-regular-${Math.random().toString(36).slice(2, 8)}`,
    name: 'A regular clinic',
    apiKey: `regular-key-${Math.random().toString(36).slice(2, 12)}`,
    settings: {},
  });
  return clinic.id;
}

describe('which PDFs are scans (no usable text layer)', () => {
  it('the committed scanned samples have no text layer; the text PDFs keep theirs', async () => {
    for (const [file, data] of [
      [HISTORY_SCANNED_PDF, readHistorySample(HISTORY_SCANNED_PDF)],
      ['lab-report-scanned.pdf', readSample('labReportScannedPdf')],
    ] as const) {
      expect(
        await extractDocumentText({ filename: file, contentType: 'application/pdf', data }),
      ).toEqual({ error: 'scanned_pdf' });
    }
    for (const [file, data] of [
      [TEXT_PDF, readHistorySample(TEXT_PDF)],
      ['lab-report.pdf', readSample('labReportPdf')],
    ] as const) {
      const extracted = await extractDocumentText({
        filename: file,
        contentType: 'application/pdf',
        data,
      });
      expect('text' in extracted && extracted.text).toContain('Hemoglobina glicosilada');
    }
  });

  it('the threshold: fewer than 40 letters or digits per page on average is a scan', () => {
    // A scanner's stamp and a page number on one page: still a scan.
    expect(isScannedPdfText('Página 1 de 1 · Escaneado 10/03/2025', 1)).toBe(true);
    // A short but real text report is text.
    expect(
      isScannedPdfText('Paciente: Ana Pérez. HbA1c 7.9 % (4.0 - 5.6). Glucosa 141 mg/dL.', 1),
    ).toBe(false);
    // The same short text over three pages is a scan with a footer.
    expect(
      isScannedPdfText('Paciente: Ana Pérez. HbA1c 7.9 % (4.0 - 5.6). Glucosa 141 mg/dL.', 3),
    ).toBe(true);
  });
});

describe('a text PDF still uses local text with masking (unchanged)', () => {
  it('a lab clinic: the text is extracted locally, masked, fenced as data; no file part leaves', async () => {
    const provider = stubbedMuseSpark({
      isLabReport: true,
      reportDate: '2024-05-06',
      patientName: '[REDACTADO]',
      tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
    });
    const rt = await liveRuntime(provider.fetch);
    const { clinic, clock } = await ensureLabClinicAndClock(rt, rt.labClocks, 'text@example.com');
    const report = await importPatientHistory(rt, {
      clinicId: clinic.id,
      clock,
      patient: { id: toPatientId('pat-text'), name: RAFAEL },
      documents: sampleDocuments('rafael', [TEXT_PDF]),
    });
    expect(report.documents[0]).toMatchObject({
      status: 'staged',
      source: 'text',
      nameOnReport: 'matches',
    });
    expect(provider.requests).toHaveLength(1);
    const body = provider.requests[0] ?? '';
    expect(body).toContain('<report>');
    expect(body).toContain('[REDACTADO]');
    expect(body).not.toContain('Rafael');
    expect(body).not.toContain('Méndez');
    expect(body).not.toContain('"type":"file"');
    expect(body).not.toContain('application/pdf');
    expect(
      (await rt.storage.llmUsage.summary(clinic.id, new Date(0), { task: 'lab_document_reading' }))
        .calls,
    ).toBe(1);
  });
});

describe('a scanned PDF on a lab clinic is read by Muse Spark, like a photo', () => {
  it('history import: the PDF goes as a `file` part, the reading is coded and staged, the name and printed date checked', async () => {
    const provider = stubbedMuseSpark(HISTORY_SCANNED_PDF_READING);
    const rt = await liveRuntime(provider.fetch);
    const { clinic, clock } = await ensureLabClinicAndClock(rt, rt.labClocks, 'scan@example.com');
    expect(clinic.settings.allowUnmaskedImagesToProvider).toBe(true);
    const patientId = toPatientId('pat-jorge');
    const report = await importPatientHistory(rt, {
      clinicId: clinic.id,
      clock,
      patient: { id: patientId, name: JORGE },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(report.documents[0]).toMatchObject({
      readAs: 'lab_report',
      source: 'scan',
      status: 'staged',
      nameOnReport: 'matches',
      dates: { used: 'printed', mismatch: false },
      reading: { model: 'meta:muse-spark-1.3' },
    });
    expect(report.documents[0]?.results?.map((result) => [result.test, result.value])).toEqual(
      expect.arrayContaining([['HbA1c', 7.9]]),
    );
    expect(report.documents[0]?.resources.length).toBeGreaterThan(0);
    // One provider call: the PDF itself, as the format verified on the Meta Model API.
    expect(provider.requests).toHaveLength(1);
    const body = JSON.parse(provider.requests[0] ?? '{}') as {
      model: string;
      messages: { content: unknown }[];
    };
    expect(body.model).toBe('muse-spark-1.3');
    const parts = body.messages.at(-1)?.content as {
      type: string;
      file?: { filename: string; file_data: string };
    }[];
    const file = parts.find((part) => part.type === 'file')?.file;
    expect(file?.file_data).toBe(
      `data:application/pdf;base64,${Buffer.from(readHistorySample(HISTORY_SCANNED_PDF)).toString('base64')}`,
    );
    expect(provider.requests[0]).not.toContain('<report>');
    // Accounted by the gateway under its own task, with its cost.
    const usage = await rt.storage.llmUsage.summary(clinic.id, new Date(0), {
      task: 'lab_scan_reading',
    });
    expect(usage.calls).toBe(1);
    expect(report.documents[0]?.reading?.costUsd).toBeGreaterThan(0);
  });

  it('the name check still applies: another person’s scan is held as name_mismatch, nothing recorded', async () => {
    const provider = stubbedMuseSpark({
      ...HISTORY_SCANNED_PDF_READING,
      patientName: 'Laura Beatriz Ortega',
    });
    const rt = await liveRuntime(provider.fetch);
    const { clinic, clock } = await ensureLabClinicAndClock(rt, rt.labClocks, 'name@example.com');
    const report = await importPatientHistory(rt, {
      clinicId: clinic.id,
      clock,
      patient: { id: toPatientId('pat-jorge'), name: JORGE },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(report.documents[0]).toMatchObject({
      source: 'scan',
      status: 'needs_review',
      reviewReason: 'name_mismatch',
      nameOnReport: 'mismatch',
      resources: [],
    });
    const held = await rt.storage.heldLabReports.list(clinic.id, { status: 'pending' });
    expect(held).toEqual([expect.objectContaining({ reason: 'name_mismatch', source: 'scan' })]);
  });

  it('re-importing the same scan is idempotent: already imported, never read again', async () => {
    const provider = stubbedMuseSpark(HISTORY_SCANNED_PDF_READING);
    const rt = await liveRuntime(provider.fetch);
    const { clinic, clock } = await ensureLabClinicAndClock(rt, rt.labClocks, 'again@example.com');
    const patientId = toPatientId('pat-jorge');
    const first = await importPatientHistory(rt, {
      clinicId: clinic.id,
      clock,
      patient: { id: patientId, name: JORGE },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(first.documents[0]?.status).toBe('staged');
    const second = await importPatientHistory(rt, {
      clinicId: clinic.id,
      clock,
      patient: { id: patientId },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(second.documents[0]).toMatchObject({ status: 'already_imported', source: 'scan' });
    expect(second.documents[0]?.resources).toEqual(first.documents[0]?.resources);
    expect(second.eventsStaged).toBe(0);
    expect(provider.requests).toHaveLength(1);
  });
});

describe('a scanned PDF on a regular clinic is held, never sent', () => {
  it('history import: needs review (scan_not_allowed), zero provider calls, also on re-import', async () => {
    const provider = stubbedMuseSpark(HISTORY_SCANNED_PDF_READING);
    const rt = await liveRuntime(provider.fetch);
    const clinicId = await regularClinic(rt);
    expect((await rt.storage.clinics.get(clinicId))?.settings.allowUnmaskedImagesToProvider).toBe(
      false,
    );
    const clock = new FakeClock(rt.clock.now());
    const patientId = toPatientId('pat-jorge');
    const report = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: patientId, name: JORGE },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(report.documents[0]).toMatchObject({
      source: 'scan',
      status: 'needs_review',
      reviewReason: 'scan_not_allowed',
      resources: [],
    });
    expect(provider.requests).toHaveLength(0);
    expect((await rt.storage.llmUsage.summary(clinicId, new Date(0))).calls).toBe(0);
    const held = await rt.storage.heldLabReports.list(clinicId, { status: 'pending' });
    expect(held).toEqual([
      expect.objectContaining({
        id: report.documents[0]?.heldReportId,
        reason: 'scan_not_allowed',
        source: 'scan',
        filename: HISTORY_SCANNED_PDF,
        results: [],
      }),
    ]);
    const again = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: patientId },
      documents: sampleDocuments('scanned_pdf'),
    });
    expect(again.documents[0]).toMatchObject({
      status: 'needs_review',
      reviewReason: 'scan_not_allowed',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('a text PDF on the same regular clinic is still read (masked text is not an image)', async () => {
    const provider = stubbedMuseSpark({
      isLabReport: true,
      reportDate: '2024-05-06',
      patientName: '[REDACTADO]',
      tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
    });
    const rt = await liveRuntime(provider.fetch);
    const clinicId = await regularClinic(rt);
    const report = await importPatientHistory(rt, {
      clinicId,
      clock: new FakeClock(rt.clock.now()),
      patient: { id: toPatientId('pat-rafael'), name: RAFAEL },
      documents: sampleDocuments('rafael', [TEXT_PDF]),
    });
    expect(report.documents[0]).toMatchObject({ status: 'staged', source: 'text' });
    expect(provider.requests).toHaveLength(1);
  });

  it('the order agent on WhatsApp: the scan is not sent, marked not read, and handed to the team', async () => {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        LLM_PROVIDER: 'fake',
        DATABASE_URL: '',
      }),
    );
    const rt = runtime;
    const clinicId = await regularClinic(rt);
    const { patientId }: { patientId: PatientId } = await startOrderAgentStory(
      rt,
      clinicId,
      rt.clock,
      { story: 'maria', mode: 'scripted', language: 'es' },
    );
    const worker = new Worker(rt);
    await worker.runJobs();
    await rt.orderAgent.receiveMessage(clinicId, patientId, {
      kind: 'document',
      media: { data: readSample('labReportScannedPdf'), contentType: 'application/pdf' },
    });
    await worker.runJobs();

    const steps = await rt.storage.orderAgent.listSteps(clinicId, patientId);
    expect(steps.some((step) => step.event === 'scan_not_allowed')).toBe(true);
    expect(steps.some((step) => step.event === 'scan_read')).toBe(false);
    expect(steps.some((step) => step.event === 'expectation_fulfilled')).toBe(false);
    const tasks = await rt.storage.orderAgent.listTasks(clinicId, patientId);
    expect(tasks.map((task) => task.summary.ask)).toContain('review_scan');
    const messages = await rt.storage.orderAgent.listMessages(clinicId, patientId);
    const scan = messages.find((message) => message.kind === 'document');
    expect(scan?.reading).toEqual({ isLabReport: false, tests: [], notRead: 'scan_not_allowed' });
    // The patient is told the team will review the report, never asked for another file.
    const reply = messages.filter((message) => message.direction === 'outbound').at(-1);
    expect(reply?.text).toContain('el equipo de la clínica lo va a revisar');
    for (const task of ['lab_scan_reading', 'lab_scan_reading_scripted']) {
      expect((await rt.storage.llmUsage.summary(clinicId, new Date(0), { task })).calls).toBe(0);
    }
  });
});
