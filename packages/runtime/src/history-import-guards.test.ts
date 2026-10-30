import {
  type ClinicId,
  FakeClock,
  patientId as toPatientId,
  type PatientId,
} from '@follow-up-engine/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { type HistoryDocument, importPatientHistory } from './history-import.ts';
import { ensureLabClinicAndClock } from './lab.ts';
import {
  HISTORY_RESULT_PHOTO_READING,
  HISTORY_SAMPLE_SETS,
  readHistorySample,
  readSample,
} from './order-agent/samples.ts';
import { startOrderAgentStory } from './order-agent/story.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';
import { Worker } from './worker.ts';

/*
 * V1-A, the reviewer's three conditions: (1) a photo never leaves for a
 * model provider unless the clinic allows unmasked images; (2) the backfill
 * cap counts calendar days in the clinic's time zone; (3) is in core
 * (`nameOnReport`, lab-reading.test.ts).
 */

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

const PHOTO = '2025-12-15-foto-resultado.jpg';
const RAFAEL = 'Rafael Antonio Méndez';

function day(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function documents(setId: string, only?: readonly string[]): HistoryDocument[] {
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

/** Muse Spark's API, stubbed: counts every request that reaches the provider. */
function stubbedProvider(): {
  readonly requests: string[];
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
} {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (_url, init) => {
      const body = init.body as string;
      requests.push(body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify(HISTORY_RESULT_PHOTO_READING) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 900, completion_tokens: 200 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  };
}

async function regularClinic(
  rt: EngineRuntime,
  settings: Record<string, unknown> = {},
): Promise<ClinicId> {
  const clinic = await rt.registerClinic({
    id: `clinic-regular-${Math.random().toString(36).slice(2, 8)}`,
    name: 'A regular clinic',
    apiKey: `regular-key-${Math.random().toString(36).slice(2, 12)}`,
    settings,
  });
  return clinic.id;
}

describe('photos never leave for a model unless the clinic allows unmasked images', () => {
  it('a regular clinic: the photo is held ("photos can’t be read automatically"), zero provider calls', async () => {
    const provider = stubbedProvider();
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        LLM_PROVIDER: 'meta',
        META_API_KEY: 'test-key',
        DATABASE_URL: '',
      }),
      { llmFetch: provider.fetch },
    );
    const clinicId = await regularClinic(runtime);
    expect((await runtime.storage.clinics.get(clinicId))?.settings).toMatchObject({
      allowUnmaskedImagesToProvider: false,
    });
    const clock = new FakeClock(runtime.clock.now());
    const patientId = toPatientId('pat-photo');
    const report = await importPatientHistory(runtime, {
      clinicId,
      clock,
      patient: { id: patientId, name: RAFAEL },
      documents: documents('rafael', [PHOTO]),
    });
    expect(report.documents[0]).toMatchObject({
      status: 'needs_review',
      reviewReason: 'photo_not_allowed',
      resources: [],
    });
    // Refused before any network call: nothing reached the provider, nothing was logged as a call.
    expect(provider.requests).toHaveLength(0);
    expect((await runtime.storage.llmUsage.summary(clinicId, new Date(0))).calls).toBe(0);
    // Held for the team (visible in "Needs review"), never dropped.
    const held = await runtime.storage.heldLabReports.list(clinicId, { status: 'pending' });
    expect(held).toEqual([
      expect.objectContaining({
        id: report.documents[0]?.heldReportId,
        reason: 'photo_not_allowed',
        filename: PHOTO,
        results: [],
      }),
    ]);
    // Re-importing it does not try again.
    await importPatientHistory(runtime, {
      clinicId,
      clock,
      patient: { id: patientId },
      documents: documents('rafael', [PHOTO]),
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('a lab sandbox clinic still reads the same photo (one provider call, an image)', async () => {
    const provider = stubbedProvider();
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        LLM_PROVIDER: 'meta',
        META_API_KEY: 'test-key',
        DATABASE_URL: '',
      }),
      { llmFetch: provider.fetch },
    );
    const { clinic, clock } = await ensureLabClinicAndClock(
      runtime,
      runtime.labClocks,
      'photos@example.com',
    );
    expect(clinic.settings.allowUnmaskedImagesToProvider).toBe(true);
    const report = await importPatientHistory(runtime, {
      clinicId: clinic.id,
      clock,
      patient: { id: toPatientId('pat-photo'), name: RAFAEL },
      documents: documents('rafael', [PHOTO]),
    });
    expect(report.documents[0]).toMatchObject({ status: 'staged', source: 'photo' });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toContain('image_url');
  });

  it('the order agent on WhatsApp: a regular clinic’s photo is not sent, marked not read, and handed to the team', async () => {
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
    const { patientId } = await startOrderAgentStory(rt, clinicId, rt.clock, {
      story: 'maria',
      mode: 'scripted',
      language: 'es',
    });
    const worker = new Worker(rt);
    await worker.runJobs();
    await rt.orderAgent.receiveMessage(clinicId, patientId, {
      kind: 'image',
      media: { data: readSample('labReport'), contentType: 'image/jpeg' },
    });
    await worker.runJobs();

    const steps = await rt.storage.orderAgent.listSteps(clinicId, patientId);
    expect(steps.some((step) => step.event === 'photo_not_allowed')).toBe(true);
    expect(steps.some((step) => step.event === 'photo_read')).toBe(false);
    const tasks = await rt.storage.orderAgent.listTasks(clinicId, patientId);
    expect(tasks.map((task) => task.summary.ask)).toContain('review_photo');
    const messages = await rt.storage.orderAgent.listMessages(clinicId, patientId);
    const photo = messages.find((message) => message.kind === 'image');
    expect(photo?.reading).toEqual({ isLabReport: false, tests: [], notRead: 'photo_not_allowed' });
    // The patient is told the team will review it, never asked for another photo.
    const reply = messages.filter((message) => message.direction === 'outbound').at(-1);
    expect(reply?.text).toContain('el equipo de la clínica la va a revisar');
    // No reading reached any provider for this clinic.
    expect(
      (
        await rt.storage.llmUsage.summary(clinicId, new Date(0), {
          task: 'lab_photo_reading_scripted',
        })
      ).calls,
    ).toBe(0);
    expect(
      (await rt.storage.llmUsage.summary(clinicId, new Date(0), { task: 'lab_photo_reading' }))
        .calls,
    ).toBe(0);
  });
});

describe('the backfill cap counts calendar days in the clinic’s time zone', () => {
  /** A clinic in Caracas (UTC−4), one case per owner per day. */
  async function caracas(start: string): Promise<{
    readonly rt: EngineRuntime;
    readonly clinicId: ClinicId;
    readonly clock: FakeClock;
  }> {
    runtime = await createRuntime(
      loadRuntimeConfig({
        CLOCK: 'fake',
        LOG_LEVEL: 'silent',
        LLM_PROVIDER: 'fake',
        DATABASE_URL: '',
      }),
    );
    const clinicId = await regularClinic(runtime, {
      timezone: 'America/Caracas',
      dailyCaseCapPerOwner: 1,
    });
    return { rt: runtime, clinicId, clock: new FakeClock(new Date(start)) };
  }

  /** One patient's old note: one held backfill case. */
  async function importOne(
    rt: EngineRuntime,
    clinicId: ClinicId,
    clock: FakeClock,
    id: string,
  ): Promise<{ readonly perDay: readonly number[]; readonly patientId: PatientId }> {
    const patientId = toPatientId(id);
    const report = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: patientId, name: 'Carmen Elena Rivas' },
      documents: documents('carmen'),
    });
    return { perDay: report.backfill.release?.perDay ?? [], patientId };
  }

  it('drift: released at 10:00 yesterday, a run at 09:59 today still has a full cap', async () => {
    // 10:00 in Caracas on Jan 5 is 14:00 UTC.
    const { rt, clinicId, clock } = await caracas('2026-01-05T14:00:00Z');
    expect((await importOne(rt, clinicId, clock, 'pat-a')).perDay).toEqual([1]);
    // 09:59 on Jan 6: 23 h 59 min later, inside a rolling 24 h window, but another day.
    clock.set(new Date('2026-01-06T13:59:00Z'));
    expect((await importOne(rt, clinicId, clock, 'pat-b')).perDay).toEqual([1]);
  });

  it('two imports on the same local day share one cap; the next batch comes out at local midnight', async () => {
    const { rt, clinicId, clock } = await caracas('2026-01-05T14:00:00Z');
    expect((await importOne(rt, clinicId, clock, 'pat-a')).perDay).toEqual([1]);
    // 18:00 the same day in Caracas (22:00 UTC).
    clock.set(new Date('2026-01-05T22:00:00Z'));
    const second = await importOne(rt, clinicId, clock, 'pat-b');
    expect(second.perDay).toEqual([0, 1]);
    const held = await rt.storage.stores.cases.list(clinicId, {
      patientId: second.patientId,
      limit: 10,
    });
    // Local midnight of Jan 6 in Caracas: 04:00 UTC.
    expect(held.items[0]?.releaseAt?.toISOString()).toBe('2026-01-06T04:00:00.000Z');
  });

  it('rolls over at local midnight, not UTC midnight', async () => {
    // 23:50 on Jan 5 in Caracas is 03:50 UTC on Jan 6.
    const { rt, clinicId, clock } = await caracas('2026-01-06T03:50:00Z');
    expect((await importOne(rt, clinicId, clock, 'pat-a')).perDay).toEqual([1]);
    // 00:05 on Jan 6 in Caracas (04:05 UTC, the same UTC day as the first): a new local day.
    clock.set(new Date('2026-01-06T04:05:00Z'));
    expect((await importOne(rt, clinicId, clock, 'pat-b')).perDay).toEqual([1]);
    // And 23:55 the same local day (03:55 UTC on Jan 7): today's cap is spent.
    clock.set(new Date('2026-01-07T03:55:00Z'));
    expect((await importOne(rt, clinicId, clock, 'pat-c')).perDay).toEqual([0, 1]);
  });
});
