import {
  type ClinicId,
  type Expectation,
  type FakeClock,
  type FollowUpCase,
  patientId as toPatientId,
  type PatientId,
} from '@follow-up-engine/core';
import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from './config.ts';
import { type HistoryDocument, importPatientHistory } from './history-import.ts';
import { ensureLabClinicAndClock, setLabClinicDate } from './lab.ts';
import { HISTORY_SAMPLE_SETS, readHistorySample } from './order-agent/samples.ts';
import { createRuntime, type EngineRuntime } from './runtime.ts';

/*
 * V1-A "PDF/Word in historical mode": a patient's history imported in one go
 * (PDF note, PDF lab report, DOCX referral, a photo of a result), read by
 * the note extractor and the lab-result reading, and replayed by the
 * initial backfill scoped to the patient. Fake provider: the scripted
 * readers know the committed sample set (scripts/generate-history-samples.py).
 */

let runtime: EngineRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function lab(email = 'history@example.com'): Promise<{
  readonly runtime: EngineRuntime;
  readonly clinicId: ClinicId;
  readonly clock: FakeClock;
}> {
  runtime ??= await createRuntime(
    loadRuntimeConfig({
      CLOCK: 'fake',
      LOG_LEVEL: 'silent',
      LLM_PROVIDER: 'fake',
      DATABASE_URL: '',
    }),
  );
  const { clinic, clock } = await ensureLabClinicAndClock(runtime, runtime.labClocks, email);
  return { runtime, clinicId: clinic.id, clock };
}

function day(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

/** A sample set's documents, optionally re-dated by file name. */
function sampleDocuments(
  setId: string,
  dates: Readonly<Record<string, string>> = {},
  only?: readonly string[],
): HistoryDocument[] {
  const set = HISTORY_SAMPLE_SETS.find((item) => item.id === setId);
  if (set === undefined) throw new Error(`No sample set ${setId}`);
  return set.files
    .filter((file) => only === undefined || only.includes(file.file))
    .map((file) => ({
      filename: file.file,
      contentType: file.contentType,
      data: readHistorySample(file.file),
      documentDate: day(dates[file.file] ?? file.documentDate),
      documentType: file.documentType,
      specialty: file.specialty,
    }));
}

async function expectationsOf(
  rt: EngineRuntime,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<readonly Expectation[]> {
  return rt.storage.stores.expectations.listByPatient(clinicId, patientId);
}

async function casesOf(
  rt: EngineRuntime,
  clinicId: ClinicId,
  patientId?: PatientId,
): Promise<readonly FollowUpCase[]> {
  return (
    await rt.storage.stores.cases.list(clinicId, {
      ...(patientId === undefined ? {} : { patientId }),
      limit: 1000,
    })
  ).items;
}

/** The doctor's HbA1c order read from the 2024 note ("Solicito HbA1c y control en 3 meses"). */
function hba1cOrder(expectations: readonly Expectation[]): Expectation | undefined {
  return expectations.find(
    (expectation) => expectation.layer === 'doctor_plan' && expectation.matchKey === 'loinc:4548-4',
  );
}

describe('importing a patient’s history (V1-A, historical mode)', () => {
  it('replays it as the backfill: everything is origin=backfill, held and released by the cap, never opened live', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const patientId = toPatientId('pat-rafael');
    const report = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: patientId, name: 'Rafael Antonio Méndez', gender: 'male' },
      documents: sampleDocuments('rafael'),
    });

    expect(report.documents.map((document) => [document.readAs, document.status])).toEqual([
      ['note', 'staged'],
      ['lab_report', 'staged'],
      ['note', 'staged'],
      ['lab_report', 'staged'],
    ]);
    // The photo's tests, coded like the agent codes them; the range is computed by code.
    expect(report.documents[3]?.results).toEqual([
      { test: 'creatinine', loinc: '2160-0', value: 0.9, unit: 'mg/dL', interpretation: 'N' },
      { test: 'lipid panel', loinc: '57698-3', value: 128, unit: 'mg/dL', interpretation: 'H' },
    ]);
    expect(report.backfill.status).toBe('completed');
    expect(report.backfill.notesRead).toBe(2);

    const expectations = await expectationsOf(rt, clinicId, patientId);
    expect(expectations.length).toBeGreaterThan(0);
    expect(new Set(expectations.map((expectation) => expectation.origin))).toEqual(
      new Set(['backfill']),
    );
    const cases = await casesOf(rt, clinicId, patientId);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((followUpCase) => followUpCase.origin === 'backfill')).toBe(true);
    // Released through the backfill's plan (the cap), never opened as a live case.
    expect(report.backfill.release).toEqual({
      scheduled: cases.length,
      notNotified: 0,
      perDay: [1],
    });
    expect(cases.every((followUpCase) => followUpCase.releaseAt !== undefined)).toBe(true);
  });

  it('closes the order with the imported result through the engine (FHIR Observation, fulfilled_by_result)', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const patientId = toPatientId('pat-rafael');
    await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: patientId, name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    });
    const order = hba1cOrder(await expectationsOf(rt, clinicId, patientId));
    expect(order?.status).toBe('fulfilled');
    expect(order?.closedReason).toBe('fulfilled_by_result');
    expect(order?.closedBy?.resourceType).toBe('Observation');
    expect(order?.closedBy?.id).toMatch(/^hist-obs-[0-9a-f]{16}-hba1c$/);
    // Closed as of the report's date, inside the history: the replay, not today's clock.
    expect(order?.closedAt?.toISOString().slice(0, 10)).toBe('2024-05-06');
  });

  it('chronological order matters: a result dated after the order closes it, one dated before does not', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const files = ['2024-02-12-nota-control.pdf', '2024-05-06-informe-laboratorio.pdf'];
    const after = toPatientId('pat-result-after');
    const before = toPatientId('pat-result-before');
    await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: after, name: 'Paciente Después' },
      documents: sampleDocuments('rafael', {}, files),
    });
    await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: before, name: 'Paciente Antes' },
      // The same report, dated a month before the note that orders the HbA1c.
      documents: sampleDocuments(
        'rafael',
        { '2024-05-06-informe-laboratorio.pdf': '2024-01-10' },
        files,
      ),
    });
    const closed = hba1cOrder(await expectationsOf(rt, clinicId, after));
    expect(closed?.status).toBe('fulfilled');
    expect(closed?.closedReason).toBe('fulfilled_by_result');

    const open = hba1cOrder(await expectationsOf(rt, clinicId, before));
    expect(open).toBeDefined();
    expect(open?.status).not.toBe('fulfilled');
    expect(open?.closedBy).toBeUndefined();
    // The earlier result is in the record all the same: it just cannot answer a later order.
    const results = await rt.storage.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.clinicalRecords.listEventsForPatient(clinicId, before, { types: ['result.received'] }),
    );
    expect(results.some((event) => event.source.id.endsWith('-hba1c'))).toBe(true);
  });

  it('respects the daily cap per owner: one patient released today, the next waits in To recover until tomorrow', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const rafael = toPatientId('pat-rafael');
    const carmen = toPatientId('pat-carmen');
    const settings = (await rt.storage.clinics.get(clinicId))?.settings;
    expect(settings?.dailyCaseCapPerOwner).toBe(1);
    const first = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: rafael, name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    });
    const second = await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: carmen, name: 'Carmen Elena Rivas' },
      documents: sampleDocuments('carmen'),
    });
    expect(first.backfill.release?.perDay).toEqual([1]);
    // Today's cap is spent by the first import: the second goes to tomorrow.
    expect(second.backfill.release?.perDay).toEqual([0, 1]);

    const now = clock.now();
    const held = await rt.storage.stores.cases.list(clinicId, {
      origin: 'backfill',
      unreleasedAsOf: now,
      limit: 100,
    });
    expect(held.items.map((followUpCase) => followUpCase.patientId)).toEqual([carmen]);
    expect(held.items[0]?.nextActionAt).toBeUndefined();
    const releasedToday = await rt.storage.stores.cases.list(clinicId, {
      origin: 'backfill',
      releasedAsOf: now,
      limit: 100,
    });
    expect(releasedToday.items.map((followUpCase) => followUpCase.patientId)).toEqual([rafael]);

    // The next day, the watcher releases tomorrow's batch.
    await setLabClinicDate(rt, clock, clinicId, new Date(now.getTime() + 86_400_000));
    const after = await rt.storage.stores.cases.list(clinicId, {
      origin: 'backfill',
      unreleasedAsOf: clock.now(),
      limit: 100,
    });
    expect(after.items).toHaveLength(0);
    const carmenCase = (await casesOf(rt, clinicId, carmen))[0];
    expect(carmenCase?.nextActionAt).toBeDefined();
  });

  it('is idempotent: the same documents again stage nothing, read nothing and create nothing', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const patientId = toPatientId('pat-rafael');
    const input = {
      clinicId,
      clock,
      patient: { id: patientId, name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    };
    await importPatientHistory(rt, input);
    const expectationsBefore = await expectationsOf(rt, clinicId, patientId);
    const casesBefore = await casesOf(rt, clinicId, patientId);
    const usageBefore = await rt.storage.llmUsage.summary(clinicId, new Date(0));

    const again = await importPatientHistory(rt, input);
    expect(again.eventsStaged).toBe(0);
    expect(again.documents.map((document) => document.status)).toEqual([
      'already_imported',
      'already_imported',
      'already_imported',
      'already_imported',
    ]);
    expect(again.backfill.expectationsCreated).toBe(0);
    expect(again.backfill.casesOpened).toBe(0);
    expect(again.backfill.release?.scheduled).toBe(0);
    const expectationsAfter = await expectationsOf(rt, clinicId, patientId);
    expect(expectationsAfter.map((expectation) => [expectation.id, expectation.status])).toEqual(
      expectationsBefore.map((expectation) => [expectation.id, expectation.status]),
    );
    expect((await casesOf(rt, clinicId, patientId)).map((item) => item.id)).toEqual(
      casesBefore.map((item) => item.id),
    );
    // No model call either: the photo and the report are not read again.
    expect((await rt.storage.llmUsage.summary(clinicId, new Date(0))).calls).toBe(
      usageBefore.calls,
    );
  });

  it('replays only the imported patient: another patient’s staged history is left alone', async () => {
    const { runtime: rt, clinicId, clock } = await lab();
    const other = toPatientId('pat-other');
    await rt.ingestion.stageHistory(
      clinicId,
      buildConsultationBundle({
        consultationId: 'other-visit',
        patient: { id: other, name: 'Otro Paciente' },
        specialty: 'internal_medicine',
        occurredAt: day('2024-03-01'),
        noteText: 'Control de hipertensión. Solicito creatinina y control en 3 meses.',
      }),
      day('2024-03-01'),
    );
    await importPatientHistory(rt, {
      clinicId,
      clock,
      patient: { id: toPatientId('pat-rafael'), name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    });
    expect(await expectationsOf(rt, clinicId, other)).toHaveLength(0);
  });

  it('keeps every clinic’s history apart: an import in one lab is invisible to another', async () => {
    const a = await lab('a@example.com');
    const b = await lab('b@example.com');
    expect(a.clinicId).not.toBe(b.clinicId);
    const patientId = toPatientId('pat-rafael');
    await importPatientHistory(a.runtime, {
      clinicId: a.clinicId,
      clock: a.clock,
      patient: { id: patientId, name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    });
    const rt = a.runtime;
    expect((await expectationsOf(rt, a.clinicId, patientId)).length).toBeGreaterThan(0);
    expect(await expectationsOf(rt, b.clinicId, patientId)).toHaveLength(0);
    expect(await casesOf(rt, b.clinicId)).toHaveLength(0);
    const eventsInB = await rt.storage.unitOfWork.withTransaction(b.clinicId, (stores) =>
      stores.clinicalRecords.listEventsForPatient(b.clinicId, patientId),
    );
    expect(eventsInB).toHaveLength(0);

    // The same documents in the other lab: read and replayed there, not "already imported".
    const inB = await importPatientHistory(rt, {
      clinicId: b.clinicId,
      clock: b.clock,
      patient: { id: patientId, name: 'Rafael Antonio Méndez' },
      documents: sampleDocuments('rafael'),
    });
    expect(inB.documents.every((document) => document.status === 'staged')).toBe(true);
    expect(inB.backfill.expectationsCreated).toBe(
      (await expectationsOf(rt, a.clinicId, patientId)).length,
    );
  });
});
