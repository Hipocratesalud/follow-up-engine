import { clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import type { FetchLike } from '../providers/chat-completions.ts';
import { createFakeProvider } from '../providers/fake.ts';
import { createMetaProvider } from '../providers/meta.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import {
  createPatientMediaReader,
  createScriptedLabDocumentResponder,
  FAKE_VISION_MODEL,
  LAB_DOCUMENT_SCRIPTED_TASK,
  LAB_DOCUMENT_TASK,
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

/** The document "extractor" of these tests: the bytes are already the text. */
async function documentText(document: Uint8Array): Promise<string | undefined> {
  const text = new TextDecoder().decode(document);
  return Promise.resolve(text === '' ? undefined : text);
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
    const read = await createPatientMediaReader({ gateway, documentText }).readLabDocument(CLINIC, {
      mode: 'live',
      document: utf8('Hemoglobina glicosilada (HbA1c) 8.4 % 4.0 - 5.6 %'),
      contentType: 'application/pdf',
    });
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
    const reader = createPatientMediaReader({ gateway, documentText });
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
      createPatientMediaReader({ gateway, documentText }).readLabDocument(CLINIC, {
        mode: 'live',
        document: new Uint8Array(),
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(UnreadableDocumentError);
    expect(calls).toBe(0);
  });
});
