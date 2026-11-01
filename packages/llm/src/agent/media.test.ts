import { clinicId, UnmaskedImageRefusedError } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import type { FetchLike } from '../providers/chat-completions.ts';
import { createFakeProvider } from '../providers/fake.ts';
import { createMetaProvider } from '../providers/meta.ts';
import { sha256Hex } from '../providers/transcription.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import {
  createPatientMediaReader,
  createScriptedLabDocumentResponder,
  FAKE_VISION_MODEL,
  LAB_DOCUMENT_SCRIPTED_TASK,
  LAB_DOCUMENT_TASK,
  LAB_PHOTO_TASK,
  LAB_SCAN_SCRIPTED_TASK,
  LAB_SCAN_TASK,
  createScriptedLabScanResponder,
  type ModelLabPhotoReading,
  UnreadableDocumentError,
} from './media.ts';

const CLINIC = clinicId('clinic-media');

const READING: ModelLabPhotoReading = {
  isLabReport: true,
  reportDate: '2024-05-06',
  patientName: 'Rafael Antonio Méndez',
  tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
};

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Bytes these tests treat as a scanned PDF (the runtime finds no usable text layer). */
const SCAN = utf8('%PDF-1.4 scanned page, image only');

/** The document "extractor" of these tests: the bytes are already the text; {@link SCAN} is a scan. */
async function documentContent(
  document: Uint8Array,
): Promise<{ text: string } | { scanned: true } | undefined> {
  const text = new TextDecoder().decode(document);
  if (text === new TextDecoder().decode(SCAN)) return Promise.resolve({ scanned: true });
  return Promise.resolve(text === '' ? undefined : { text });
}

describe('the lab-result reading of a document (PDF text)', () => {
  it('reads the report text with Muse Spark into the same reading as a photo, on the gateway', async () => {
    const bodies: unknown[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 600, completion_tokens: 300 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const usageLog = new InMemoryLlmUsageLog();
    const gateway = createLlmGateway({
      providers: { meta: createMetaProvider({ apiKey: 'test', fetch }) },
      tasks: { [LAB_DOCUMENT_TASK]: { route: [{ provider: 'meta', model: 'muse-spark-1.3' }] } },
      usageLog,
    });
    const read = await createPatientMediaReader({ gateway, documentContent }).readLabDocument(
      CLINIC,
      {
        mode: 'live',
        document: utf8('Hemoglobina glicosilada (HbA1c) 8.4 % 4.0 - 5.6 %'),
        contentType: 'application/pdf',
      },
    );
    expect(read.reading).toEqual({
      isLabReport: true,
      reportDate: '2024-05-06',
      patientName: 'Rafael Antonio Méndez',
      tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
    });
    expect(read.model).toBe('meta:muse-spark-1.3');
    // Text, not an image: the report travels fenced as data in the user message.
    const sent = bodies[0] as { messages: { role: string; content: unknown }[] };
    expect(JSON.stringify(sent.messages)).toContain('<report>');
    expect(JSON.stringify(sent.messages)).not.toContain('image_url');
    // Accounted per clinic like every gateway call.
    const calls = usageLog.records.filter((record) => record.task === LAB_DOCUMENT_TASK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.clinicId).toBe(CLINIC);
    expect(calls[0]?.costUsd).toBe(read.costUsd);
    expect(read.costUsd).toBeGreaterThan(0);
  });

  it('the scripted reader knows a sample report by the code it prints, and nothing else', async () => {
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: createScriptedLabDocumentResponder({ 'HIST-LAB-20240506': READING }),
        }),
      },
      tasks: {
        [LAB_DOCUMENT_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
      },
      usageLog: new InMemoryLlmUsageLog(),
    });
    const reader = createPatientMediaReader({ gateway, documentContent });
    const known = await reader.readLabDocument(CLINIC, {
      mode: 'scripted',
      document: utf8('Código de muestra: HIST-LAB-20240506\nHbA1c 8.4 %'),
      contentType: 'application/pdf',
    });
    expect(known.reading.isLabReport).toBe(true);
    expect(known.reading.tests[0]?.value).toBe(8.4);
    const other = await reader.readLabDocument(CLINIC, {
      mode: 'scripted',
      document: utf8('A referral letter, not a lab report.'),
      contentType: 'application/pdf',
    });
    expect(other.reading).toEqual({ isLabReport: false, tests: [] });
  });

  it('refuses a document with no text before calling any model', async () => {
    let calls = 0;
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: () => {
            calls += 1;
            return READING;
          },
        }),
      },
      tasks: { [LAB_DOCUMENT_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] } },
      usageLog: new InMemoryLlmUsageLog(),
    });
    await expect(
      createPatientMediaReader({ gateway, documentContent }).readLabDocument(CLINIC, {
        mode: 'live',
        document: new Uint8Array(),
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnreadableDocumentError);
    expect(calls).toBe(0);
  });

  it('masks the patient’s name in the report text, restores the masked mention for the name check, and leaves another person’s name as read', async () => {
    const bodies: string[] = [];
    let printed: string | null = '[REDACTADO]';
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(init.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ ...READING, patientName: printed }) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 600, completion_tokens: 300 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const gateway = createLlmGateway({
      providers: { meta: createMetaProvider({ apiKey: 'test', fetch }) },
      tasks: { [LAB_DOCUMENT_TASK]: { route: [{ provider: 'meta', model: 'muse-spark-1.3' }] } },
      usageLog: new InMemoryLlmUsageLog(),
    });
    const reader = createPatientMediaReader({ gateway, documentContent });
    const input = {
      mode: 'live' as const,
      document: utf8('Paciente: Rafael Antonio Méndez\nHbA1c 8.4 % (4.0 - 5.6)'),
      contentType: 'application/pdf',
      redactTerms: ['Rafael Antonio Méndez'],
    };
    const masked = await reader.readLabDocument(CLINIC, input);
    expect(bodies[0]).not.toContain('Rafael');
    expect(bodies[0]).not.toContain('Méndez');
    expect(bodies[0]).toContain('[REDACTADO]');
    expect(masked.reading.patientName).toBe('Rafael Antonio Méndez');

    // A model that omits the masked name: the mention is restored all the same.
    printed = null;
    expect((await reader.readLabDocument(CLINIC, input)).reading.patientName).toBe(
      'Rafael Antonio Méndez',
    );
    // A name that was never masked is another person's: kept as read (the check then refuses it).
    printed = 'Laura Beatriz Ortega';
    expect((await reader.readLabDocument(CLINIC, input)).reading.patientName).toBe(
      'Laura Beatriz Ortega',
    );
  });

  it('the gateway refuses every image for a clinic that does not allow unmasked images, before any provider call', async () => {
    let calls = 0;
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: () => {
            calls += 1;
            return READING;
          },
        }),
      },
      tasks: {
        [LAB_PHOTO_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
        [LAB_DOCUMENT_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
      },
      usageLog: new InMemoryLlmUsageLog(),
      allowsUnmaskedImages: (clinicId) => clinicId !== CLINIC,
    });
    const reader = createPatientMediaReader({ gateway, documentContent });
    const photo = {
      mode: 'live' as const,
      image: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
    };
    await expect(reader.readLabPhoto(CLINIC, photo)).rejects.toBeInstanceOf(
      UnmaskedImageRefusedError,
    );
    expect(calls).toBe(0);
    // Text (a PDF report, masked) is not an image: it still goes through.
    await reader.readLabDocument(CLINIC, {
      mode: 'live',
      document: utf8('HbA1c 8.4 %'),
      contentType: 'application/pdf',
    });
    expect(calls).toBe(1);
    // A clinic that allows it reads the photo.
    await reader.readLabPhoto(clinicId('clinic-sandbox'), photo);
    expect(calls).toBe(2);
  });

  it('a scanned PDF still goes through for a clinic that allows unmasked images, and is refused before any call otherwise', async () => {
    let calls = 0;
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: () => {
            calls += 1;
            return READING;
          },
        }),
      },
      tasks: { [LAB_SCAN_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] } },
      usageLog: new InMemoryLlmUsageLog(),
      allowsUnmaskedImages: (clinicId) => clinicId !== CLINIC,
    });
    const reader = createPatientMediaReader({ gateway, documentContent });
    const scan = { mode: 'live' as const, document: SCAN, contentType: 'application/pdf' };
    // Pixels cannot be masked: the same guard as a photo.
    await expect(reader.readLabDocument(CLINIC, scan)).rejects.toBeInstanceOf(
      UnmaskedImageRefusedError,
    );
    expect(calls).toBe(0);
    const read = await reader.readLabDocument(clinicId('clinic-sandbox'), scan);
    expect(read.scanned).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('the lab-result reading of a scanned PDF (no text layer)', () => {
  it('sends the PDF itself as a `file` part to Muse Spark, unmasked, with the photo’s schema, on the gateway', async () => {
    const bodies: string[] = [];
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(init.body as string);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(READING) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2687, completion_tokens: 603 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const usageLog = new InMemoryLlmUsageLog();
    const gateway = createLlmGateway({
      providers: { meta: createMetaProvider({ apiKey: 'test', fetch }) },
      tasks: { [LAB_SCAN_TASK]: { route: [{ provider: 'meta', model: 'muse-spark-1.3' }] } },
      usageLog,
    });
    const read = await createPatientMediaReader({ gateway, documentContent }).readLabDocument(
      CLINIC,
      {
        mode: 'live',
        document: SCAN,
        contentType: 'application/pdf',
        redactTerms: ['Rafael Antonio Méndez'],
      },
    );
    expect(read.scanned).toBe(true);
    expect(read.reading).toEqual({
      isLabReport: true,
      reportDate: '2024-05-06',
      patientName: 'Rafael Antonio Méndez',
      tests: [{ name: 'HbA1c', value: 8.4, unit: '%', referenceLow: 4, referenceHigh: 5.6 }],
    });
    expect(read.model).toBe('meta:muse-spark-1.3');
    const sent = JSON.parse(bodies[0] ?? '{}') as {
      messages: { role: string; content: unknown }[];
      response_format?: { json_schema?: { name?: string } };
    };
    const user = sent.messages.at(-1)?.content as { type: string; file?: unknown }[];
    // The format verified on the Meta Model API: an OpenAI-style `file` part with a PDF data URL.
    expect(user.find((part) => part.type === 'file')?.file).toEqual({
      filename: 'report.pdf',
      file_data: `data:application/pdf;base64,${Buffer.from(SCAN).toString('base64')}`,
    });
    expect(bodies[0]).not.toContain('<report>');
    expect(bodies[0]).not.toContain('image_url');
    // Accounted per clinic, under its own task.
    const calls = usageLog.records.filter((record) => record.task === LAB_SCAN_TASK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.clinicId).toBe(CLINIC);
    expect(read.costUsd).toBeGreaterThan(0);
  });

  it('the scripted scan reader knows a sample scan by its sha256, and nothing else', async () => {
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: createScriptedLabScanResponder({ [sha256Hex(SCAN)]: READING }),
        }),
      },
      tasks: {
        [LAB_SCAN_SCRIPTED_TASK]: { route: [{ provider: 'fake', model: FAKE_VISION_MODEL }] },
      },
      usageLog: new InMemoryLlmUsageLog(),
    });
    const reader = createPatientMediaReader({
      gateway,
      documentContent: async () => Promise.resolve({ scanned: true as const }),
    });
    const known = await reader.readLabDocument(CLINIC, {
      mode: 'scripted',
      document: SCAN,
      contentType: 'application/pdf',
    });
    expect(known.reading.tests[0]?.value).toBe(8.4);
    const other = await reader.readLabDocument(CLINIC, {
      mode: 'scripted',
      document: utf8('%PDF another scan'),
      contentType: 'application/pdf',
    });
    expect(other.reading).toEqual({ isLabReport: false, tests: [] });
  });
});
