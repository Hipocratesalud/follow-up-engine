import { randomUUID } from 'node:crypto';
import {
  ACTIVE_CASE_STATUSES,
  effectiveClosedReason,
  type PatientId,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  buildConsultationBundle,
  buildPatientBundle,
  buildRecordBundle,
  type RecordEntryInput,
} from '@follow-up-engine/fhir';
import {
  ensureLabClinicAndClock,
  type EngineRuntime,
  HISTORY_SAMPLE_SETS,
  importPatientHistory,
  InvalidLabDateError,
  labIngestion,
  type LabClockRegistry,
  readHistorySample,
  setLabClinicDate,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { extractDocumentText } from '../lab/extract-document.ts';
import { humanName } from '../inbox/fhir-display.ts';
import { closedReasonLabel } from '../inbox/labels.ts';
import { trackEvaluatorEvent } from './evaluator-tracking.ts';
import { extractionView } from './demo-routes.ts';
import { HttpError, readJson } from './errors.ts';
import { InboxPresenter } from '../inbox/presenter.ts';
import { actorId } from './security.ts';
import { parseErrors } from './validation.ts';
import {
  LAB_PATIENT_SEXES,
  type LabDocumentUpload,
  LabDocumentUploadSchema,
  type LabHistoryImport,
  type LabHistoryImportResponse,
  LabHistoryImportSchema,
  type LabHistorySampleSet,
  LabImpactQuerySchema,
  type LabPatient,
  LabPatientCreateSchema,
  LabRecordAddSchema,
  type LabRecordEntry,
} from './lab-schemas.ts';
import type { App, AppEnv } from './context.ts';

/** A `YYYY-MM-DD` calendar day, read as noon UTC (never a timezone boundary issue). */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** Maps the API's `LabRecordEntry` wire shape onto the FHIR builder's `RecordEntryInput`. */
export function recordEntry(entry: LabRecordEntry): RecordEntryInput {
  switch (entry.kind) {
    case 'order':
      return {
        kind: 'order',
        loinc: entry.loinc,
        display: entry.display,
        ...(entry.category === undefined ? {} : { category: entry.category }),
      };
    case 'result':
      return {
        kind: 'result',
        loinc: entry.loinc,
        display: entry.display,
        ...(entry.value === undefined ? {} : { value: entry.value }),
        ...(entry.unit === undefined ? {} : { unit: entry.unit }),
        ...(entry.interpretation === undefined ? {} : { interpretation: entry.interpretation }),
        ...(entry.basedOnOrderId === undefined ? {} : { basedOnOrderId: entry.basedOnOrderId }),
      };
    case 'prescription':
      return {
        kind: 'prescription',
        text: entry.text,
        ...(entry.durationDays === undefined ? {} : { durationDays: entry.durationDays }),
      };
    case 'visit':
      return { kind: 'visit' };
    case 'diagnosis':
      return {
        kind: 'diagnosis',
        icd10: entry.icd10,
        ...(entry.display === undefined ? {} : { display: entry.display }),
      };
    case 'appointment_booked':
      return {
        kind: 'appointment_booked',
        scheduledFor: dayAsDate(entry.scheduledFor),
        ...(entry.specialty === undefined ? {} : { specialty: entry.specialty }),
      };
    case 'appointment_cancelled':
      return {
        kind: 'appointment_cancelled',
        appointmentId: entry.appointmentId,
        scheduledFor: dayAsDate(entry.scheduledFor),
      };
  }
}

/** `lab_record_added` tracked with a label a human reviewing the activity log can read at a glance. */
function entrySummary(entry: LabRecordEntry): string {
  switch (entry.kind) {
    case 'order':
      return `order:${entry.loinc}`;
    case 'result':
      return `result:${entry.loinc}`;
    case 'prescription':
      return `prescription:${entry.text}`;
    case 'visit':
      return 'visit';
    case 'diagnosis':
      return `diagnosis:${entry.icd10}`;
    case 'appointment_booked':
      return `appointment_booked:${entry.scheduledFor}`;
    case 'appointment_cancelled':
      return `appointment_cancelled:${entry.appointmentId}`;
  }
}

/** The evaluator lab's gate: every lab route needs an evaluator identity. */
export function requireEvaluator(c: Context<AppEnv>): string {
  const email = c.var.evaluatorEmail;
  if (email === undefined) {
    throw new HttpError(
      403,
      'lab_requires_evaluator',
      c.var.t.errors.insufficientScope('demo:ingest'),
    );
  }
  return email;
}

/** Approximate `birthDate` (`YYYY-01-01`) for "age in years" as of the lab clinic's own date. */
function birthDateFromAge(age: number, asOf: Date): string {
  return `${String(asOf.getUTCFullYear() - age).padStart(4, '0')}-01-01`;
}

/** Age in whole years, as of the lab clinic's own date; `undefined` for an unparseable `birthDate`. */
function ageFromBirthDate(birthDate: unknown, asOf: Date): number | undefined {
  if (typeof birthDate !== 'string') {
    return undefined;
  }
  const year = Number(birthDate.slice(0, 4));
  return Number.isNaN(year) ? undefined : asOf.getUTCFullYear() - year;
}

/**
 * Reads the evaluator lab's document upload body: JSON (`text` or
 * `dataBase64`), or a `multipart/form-data` request (a `file` field, or
 * `text`; `newPatient` as a JSON string field). Both end up validated by
 * the same {@link LabDocumentUploadSchema}.
 */
async function readLabDocumentUpload(c: Context<AppEnv>): Promise<LabDocumentUpload> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, 'invalid_json', c.var.t.errors.invalidJson);
    }
    return LabDocumentUploadSchema.parse(body, parseErrors(c.var.t));
  }
  const form = await c.req.parseBody();
  const raw: Record<string, unknown> = {};
  for (const key of ['patientId', 'text', 'documentDate', 'documentType', 'specialty'] as const) {
    const value = form[key];
    if (typeof value === 'string' && value !== '') {
      raw[key] = value;
    }
  }
  const newPatientRaw = form['newPatient'];
  if (typeof newPatientRaw === 'string' && newPatientRaw !== '') {
    try {
      raw['newPatient'] = JSON.parse(newPatientRaw);
    } catch {
      throw new HttpError(400, 'invalid_json', c.var.t.errors.invalidJson);
    }
  }
  const file = form['file'];
  if (file instanceof File) {
    const data = new Uint8Array(await file.arrayBuffer());
    raw['filename'] = file.name;
    raw['contentType'] = file.type === '' ? 'application/octet-stream' : file.type;
    raw['dataBase64'] = Buffer.from(data).toString('base64');
  }
  return LabDocumentUploadSchema.parse(raw, parseErrors(c.var.t));
}

/**
 * Reads an "Import history" body: JSON (`documents` with base64 files), or
 * `multipart/form-data` with one `files` part per document and a
 * `documents` JSON field giving each file's `{ documentDate, documentType,
 * specialty? }` in order. Both end up validated by {@link LabHistoryImportSchema}.
 */
async function readLabHistoryImport(c: Context<AppEnv>): Promise<LabHistoryImport> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return readJson(c, LabHistoryImportSchema);
  }
  const form = await c.req.parseBody({ all: true });
  const text = (key: string): string | undefined => {
    const value = form[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const json = (key: string): unknown => {
    const value = text(key);
    if (value === undefined) return undefined;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new HttpError(400, 'invalid_json', c.var.t.errors.invalidJson);
    }
  };
  const raw = form['files'];
  const files = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
    (file): file is File => file instanceof File,
  );
  const meta = json('documents');
  if (!Array.isArray(meta) || meta.length !== files.length) {
    throw new HttpError(422, 'lab_history_documents', c.var.t.errors.labHistoryDocuments);
  }
  const documents = await Promise.all(
    files.map(async (file, index) => ({
      ...(meta[index] as Record<string, unknown>),
      filename: file.name,
      contentType: file.type === '' ? 'application/octet-stream' : file.type,
      dataBase64: Buffer.from(await file.arrayBuffer()).toString('base64'),
    })),
  );
  return LabHistoryImportSchema.parse(
    {
      ...(text('patientId') === undefined ? {} : { patientId: text('patientId') }),
      ...(json('newPatient') === undefined ? {} : { newPatient: json('newPatient') }),
      documents,
    },
    parseErrors(c.var.t),
  );
}

/**
 * The evaluator lab's structured records (docs/deploy.md#hosted-demo): "Add
 * to the record" for a lab/imaging order, a result, a prescription, a
 * visit, a diagnosis or an appointment, each dated by the evaluator and
 * ingested with no note and no LLM call (`buildRecordBundle`). Registered
 * only on a fake clock, alongside the rest of `/api/demo/*`.
 */
export function registerLabRecordRoutes(
  app: App,
  runtime: EngineRuntime,
  labClocks: LabClockRegistry,
): void {
  /** The lab clinic's own current date (its "today"): the records form's date pickers default here. */
  app.get('/api/demo/lab/clock', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    return c.json({ now: clock.now().toISOString() });
  });

  app.post('/api/demo/lab/records', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const body = await readJson(c, LabRecordAddSchema);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(body.patientId);
    const occurredAt = dayAsDate(body.recordDate);
    if (occurredAt.getTime() > clock.now().getTime()) {
      throw new HttpError(422, 'lab_future_date', c.var.t.errors.labFutureDate);
    }
    const bundle = buildRecordBundle({
      recordId: `lab-${randomUUID()}`,
      patient: { id: patientId },
      occurredAt,
      entry: recordEntry(body.entry),
    });
    const acceptance = await labIngestion(runtime, clock).accept(clinic.id, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(422, 'invalid_record', c.var.t.errors.invalidConsultation);
    }
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const expectationsCreated = (acceptance.reports ?? []).flatMap((report) =>
      report.expectationsCreated.map((expectation) => ({
        id: expectation.id,
        ruleId: expectation.ruleId,
        ruleVersion: expectation.ruleVersion,
        layer: expectation.layer,
        label: presenter.reasonLabel(expectation.ruleId, expectation),
        dueAt: expectation.dueAt.toISOString(),
        status: expectation.status,
      })),
    );
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_record_added',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: {
        kind: body.entry.kind,
        summary: entrySummary(body.entry),
        recordDate: body.recordDate,
      },
    });
    c.var.log.info({ actor: actorId(c), kind: body.entry.kind }, 'lab record added');
    return c.json({ patientId, clinicId: clinic.id, expectationsCreated }, 201);
  });

  app.get('/api/demo/lab/patients/:id/expectations', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const patientId = toPatientId(c.req.param('id'));
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const expectations = await runtime.storage.stores.expectations.listByPatient(
      clinic.id,
      patientId,
    );
    return c.json({
      items: expectations.map((expectation) => ({
        id: expectation.id,
        ruleId: expectation.ruleId,
        ruleVersion: expectation.ruleVersion,
        layer: expectation.layer,
        label: presenter.reasonLabel(expectation.ruleId, expectation),
        status: expectation.status,
        // `backfill`: created by replaying imported history ("Import history").
        origin: expectation.origin,
        dueAt: expectation.dueAt.toISOString(),
        ...(effectiveClosedReason(expectation) === undefined
          ? {}
          : { closedReason: effectiveClosedReason(expectation) }),
        ...(closedReasonLabel(c.var.t, effectiveClosedReason(expectation)) === undefined
          ? {}
          : {
              closedReasonLabel: closedReasonLabel(c.var.t, effectiveClosedReason(expectation)),
            }),
      })),
    });
  });

  /** "New patient" (docs/deploy.md#hosted-demo): a fictitious patient, no clinical history yet. */
  app.post('/api/demo/lab/patients', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const body = await readJson(c, LabPatientCreateSchema);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const id = toPatientId(`pat-lab-${randomUUID().slice(0, 8)}`);
    const bundle = buildPatientBundle({
      id,
      name: body.name,
      ...(body.sex === undefined ? {} : { gender: body.sex }),
      ...(body.age === undefined ? {} : { birthDate: birthDateFromAge(body.age, clock.now()) }),
    });
    const acceptance = await labIngestion(runtime, clock).accept(clinic.id, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(422, 'invalid_record', c.var.t.errors.invalidConsultation);
    }
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_patient_created',
      entityType: 'patient',
      entityId: id,
      patientId: id,
      payload: {
        name: body.name,
        ...(body.sex === undefined ? {} : { sex: body.sex }),
        ...(body.age === undefined ? {} : { age: body.age }),
        ...(body.specialty === undefined ? {} : { specialty: body.specialty }),
      },
    });
    const patient: LabPatient = {
      id,
      name: body.name,
      ...(body.sex === undefined ? {} : { sex: body.sex }),
      ...(body.age === undefined ? {} : { age: body.age }),
    };
    return c.json(patient, 201);
  });

  /** My lab patients (docs/deploy.md#hosted-demo): every Patient registered in my own lab clinic. */
  app.get('/api/demo/lab/patients', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const records = await runtime.storage.readModel.searchPatients(clinic.id, { limit: 200 });
    const items: LabPatient[] = records.map((record) => {
      const resource = record.resource as {
        readonly gender?: unknown;
        readonly birthDate?: unknown;
      };
      const sex = LAB_PATIENT_SEXES.find((value) => value === resource.gender);
      const age = ageFromBirthDate(resource.birthDate, clock.now());
      return {
        id: record.id,
        name: humanName(record.resource) ?? record.id,
        ...(sex === undefined ? {} : { sex }),
        ...(age === undefined ? {} : { age }),
      };
    });
    return c.json({ items });
  });

  /**
   * "Add to the record" → Document (docs/deploy.md#hosted-demo): a PDF,
   * DOCX, TXT or pasted text, ingested through the normal FHIR path and the
   * note extractor (`llm_gateway`) — unlike the structured records above,
   * which carry no note and no LLM call.
   */
  app.post('/api/demo/lab/documents', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const upload = await readLabDocumentUpload(c);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const occurredAt = dayAsDate(upload.documentDate);
    if (occurredAt.getTime() > clock.now().getTime()) {
      throw new HttpError(422, 'lab_future_date', c.var.t.errors.labFutureDate);
    }
    const isNewPatient = upload.newPatient !== undefined;
    const patientId = toPatientId(upload.patientId ?? `pat-lab-${randomUUID().slice(0, 8)}`);

    let text: string;
    if (upload.dataBase64 !== undefined) {
      const data = new Uint8Array(Buffer.from(upload.dataBase64, 'base64'));
      const extracted = await extractDocumentText({
        filename: upload.filename ?? 'document',
        contentType: upload.contentType ?? 'application/octet-stream',
        data,
      });
      if ('error' in extracted) {
        throw new HttpError(
          422,
          `lab_document_${extracted.error}`,
          c.var.t.errors.labDocumentErrors[extracted.error],
        );
      }
      text = extracted.text;
    } else {
      // The schema requires `text` when `dataBase64` is absent.
      text = upload.text ?? '';
    }

    const newPatient = upload.newPatient;
    const bundle = buildConsultationBundle({
      consultationId: `lab-doc-${randomUUID()}`,
      patient: {
        id: patientId,
        ...(newPatient === undefined
          ? {}
          : {
              name: newPatient.name,
              ...(newPatient.sex === undefined ? {} : { gender: newPatient.sex }),
              ...(newPatient.age === undefined
                ? {}
                : { birthDate: birthDateFromAge(newPatient.age, clock.now()) }),
            }),
      },
      specialty: upload.specialty ?? 'general_medicine',
      occurredAt,
      noteText: text,
      documentType: upload.documentType,
    });
    const acceptance = await labIngestion(runtime, clock).accept(clinic.id, bundle, 'sync');
    if (!acceptance.ok) {
      throw new HttpError(422, 'invalid_record', c.var.t.errors.invalidConsultation);
    }
    const reports = acceptance.reports ?? [];
    const note = reports.flatMap((report) => report.notes)[0];
    if (note?.status === 'failed' || note?.extraction === undefined) {
      c.var.log.warn(
        { provider: runtime.extractor.provider, error: note?.error },
        'lab document extraction failed',
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
    if (isNewPatient) {
      await trackEvaluatorEvent(runtime, {
        clinicId: clinic.id,
        evaluatorEmail,
        action: 'lab_patient_created',
        entityType: 'patient',
        entityId: patientId,
        patientId,
        payload: newPatient ?? {},
      });
    }
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const expectationsCreated = reports.flatMap((report) =>
      report.expectationsCreated.map((expectation) => ({
        id: expectation.id,
        ruleId: expectation.ruleId,
        ruleVersion: expectation.ruleVersion,
        layer: expectation.layer,
        label: presenter.reasonLabel(expectation.ruleId, expectation),
        dueAt: expectation.dueAt.toISOString(),
        status: expectation.status,
      })),
    );
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_document_uploaded',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: { documentType: upload.documentType, documentDate: upload.documentDate },
    });
    return c.json(
      {
        patientId,
        clinicId: clinic.id,
        // The document's own date and type, echoed back: the timeline
        // entry the lab page adds is labeled and dated from these, never
        // from a plan item's due date (which is not when the document was
        // written).
        documentDate: upload.documentDate,
        documentType: upload.documentType,
        // The text that was read (pasted, or extracted from the file): the
        // readback highlights every quote in it, for a file upload too.
        text,
        extraction: extractionView(c.var.t, note.extraction, note.latencyMs ?? 0),
        expectationsCreated,
      },
      201,
    );
  });

  /**
   * "Import history" (V1-A): several historical documents of one patient at
   * once (PDF, DOCX, TXT, photos of results), each with its own date. Notes
   * are staged for the note extractor; lab reports (and photos) are read by
   * the order agent's lab-result reading (Muse Spark) into FHIR
   * Observations; then the initial backfill replays the patient
   * chronologically: expectations and cases are `origin: backfill`, held
   * and released by the daily cap per owner. Idempotent: the same documents
   * again stage and read nothing.
   */
  app.post('/api/demo/lab/history', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const body = await readLabHistoryImport(c);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    for (const document of body.documents) {
      if (dayAsDate(document.documentDate).getTime() > clock.now().getTime()) {
        throw new HttpError(422, 'lab_future_date', c.var.t.errors.labFutureDate);
      }
    }
    const patientId = toPatientId(body.patientId ?? `pat-lab-${randomUUID().slice(0, 8)}`);
    const newPatient = body.newPatient;
    const usageBefore = await runtime.storage.llmUsage.summary(clinic.id, new Date(0));
    const report = await importPatientHistory(runtime, {
      clinicId: clinic.id,
      clock,
      patient: {
        id: patientId,
        ...(newPatient === undefined
          ? {}
          : {
              name: newPatient.name,
              ...(newPatient.sex === undefined ? {} : { gender: newPatient.sex }),
              ...(newPatient.age === undefined
                ? {}
                : { birthDate: birthDateFromAge(newPatient.age, clock.now()) }),
            }),
      },
      documents: body.documents.map((document) => ({
        filename: document.filename,
        contentType: document.contentType,
        data: new Uint8Array(Buffer.from(document.dataBase64, 'base64')),
        documentDate: dayAsDate(document.documentDate),
        documentType: document.documentType,
        ...(document.specialty === undefined
          ? newPatient?.specialty === undefined
            ? {}
            : { specialty: newPatient.specialty }
          : { specialty: document.specialty }),
      })),
    });
    const usageAfter = await runtime.storage.llmUsage.summary(clinic.id, new Date(0));
    const cases = await patientBackfillCases(runtime, clinic.id, patientId, clock.now());
    if (newPatient !== undefined) {
      await trackEvaluatorEvent(runtime, {
        clinicId: clinic.id,
        evaluatorEmail,
        action: 'lab_patient_created',
        entityType: 'patient',
        entityId: patientId,
        patientId,
        payload: newPatient,
      });
    }
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_history_imported',
      entityType: 'patient',
      entityId: patientId,
      patientId,
      payload: {
        documents: body.documents.length,
        eventsStaged: report.eventsStaged,
        casesOpened: report.backfill.casesOpened,
      },
    });
    c.var.log.info(
      { actor: actorId(c), documents: body.documents.length, run: report.backfill.runId },
      'lab history imported',
    );
    const response: LabHistoryImportResponse = {
      patientId,
      clinicId: clinic.id,
      documents: report.documents.map((document) => ({
        index: document.index,
        filename: document.filename,
        documentDate: document.documentDate.toISOString().slice(0, 10),
        documentType: document.documentType,
        readAs: document.readAs,
        source: document.source,
        status: document.status,
        ...(document.error === undefined ? {} : { error: document.error }),
        ...(document.reviewReason === undefined ? {} : { reviewReason: document.reviewReason }),
        ...(document.nameOnReport === undefined ? {} : { nameOnReport: document.nameOnReport }),
        ...(document.dates === undefined
          ? {}
          : {
              dates: {
                ...(document.dates.printed === undefined
                  ? {}
                  : { printed: document.dates.printed.toISOString().slice(0, 10) }),
                entered: document.dates.entered.toISOString().slice(0, 10),
                used: document.dates.used,
                mismatch: document.dates.mismatch,
              },
            }),
        ...(document.results === undefined ? {} : { results: [...document.results] }),
        ...(document.unrecognizedTests === undefined
          ? {}
          : { unrecognizedTests: [...document.unrecognizedTests] }),
        resources: [...document.resources],
        ...(document.reading === undefined ? {} : { reading: document.reading }),
      })),
      eventsStaged: report.eventsStaged,
      backfill: {
        runId: report.backfill.runId,
        status: report.backfill.status,
        expectationsCreated: report.backfill.expectationsCreated,
        expectationsFulfilled: report.backfill.expectationsFulfilled,
        casesOpened: report.backfill.casesOpened,
        notesRead: report.backfill.notesRead,
        notesLlmCostUsd: report.backfill.notesLlmCostUsd,
        ...(report.backfill.release === undefined
          ? {}
          : {
              release: {
                scheduled: report.backfill.release.scheduled,
                notNotified: report.backfill.release.notNotified,
                perDay: [...report.backfill.release.perDay],
              },
            }),
      },
      cases,
      llm: {
        calls: usageAfter.calls - usageBefore.calls,
        costUsd: Number((usageAfter.costUsd - usageBefore.costUsd).toFixed(6)),
      },
    };
    return c.json(response, 201);
  });

  /** The committed synthetic sample histories (scripts/generate-history-samples.py), to try "Import history". */
  app.get('/api/demo/lab/history/samples', (c) => {
    requireEvaluator(c);
    const samples: LabHistorySampleSet = {
      sets: HISTORY_SAMPLE_SETS.map((set) => ({
        id: set.id,
        patient: { name: set.patient.name, sex: set.patient.gender, age: set.patient.age },
        documents: set.files.map((sample) => ({
          filename: sample.file,
          contentType: sample.contentType,
          dataBase64: Buffer.from(readHistorySample(sample.file)).toString('base64'),
          documentDate: sample.documentDate,
          documentType: sample.documentType,
          specialty: sample.specialty,
        })),
      })),
    };
    return c.json(samples);
  });

  /**
   * The lab clinic's "To recover" (the inbox's recovery list, for the lab):
   * backfill cases still held, as of the lab's own date. They come out by the
   * daily cap per owner as the lab's date moves.
   */
  app.get('/api/demo/lab/recovery', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const page = await runtime.storage.stores.cases.list(clinic.id, {
      statuses: ACTIVE_CASE_STATUSES,
      origin: 'backfill',
      unreleasedAsOf: clock.now(),
      orderBy: 'priority',
      limit: 100,
    });
    return c.json({ items: await presenter.caseViews(page.items), total: page.items.length });
  });

  /** "See the impact on a date" (docs/deploy.md#hosted-demo): moves the lab clinic's own clock forward. */
  app.post('/api/demo/lab/date', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const body = await readJson(c, LabImpactQuerySchema);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    let advance;
    try {
      advance = await setLabClinicDate(runtime, clock, clinic.id, dayAsDate(body.date));
    } catch (error) {
      if (error instanceof InvalidLabDateError) {
        throw new HttpError(422, 'lab_past_date', c.var.t.errors.labPastDate);
      }
      throw error;
    }
    await trackEvaluatorEvent(runtime, {
      clinicId: clinic.id,
      evaluatorEmail,
      action: 'lab_date_viewed',
      payload: { from: advance.from.toISOString(), to: advance.to.toISOString() },
    });
    return c.json({
      from: advance.from.toISOString(),
      to: advance.to.toISOString(),
      expectationsExpired: advance.expectationsExpired,
      casesOpened: advance.casesOpened,
      casesEscalated: advance.casesEscalated,
    });
  });

  /** The lab clinic's own cases (docs/deploy.md#hosted-demo), for "see the impact on a date". */
  app.get('/api/demo/lab/cases', async (c) => {
    const evaluatorEmail = requireEvaluator(c);
    const { clinic, clock } = await ensureLabClinicAndClock(runtime, labClocks, evaluatorEmail);
    const presenter = await InboxPresenter.create(runtime, clinic.id, c.var.t);
    const page = await runtime.storage.stores.cases.list(clinic.id, {
      statuses: ACTIVE_CASE_STATUSES,
      releasedAsOf: clock.now(),
      orderBy: 'priority',
      limit: 100,
    });
    return c.json({ items: await presenter.caseViews(page.items) });
  });
}

/** The patient's backfill cases after an import: released today by the cap, or held. */
async function patientBackfillCases(
  runtime: EngineRuntime,
  clinicId: Parameters<EngineRuntime['storage']['stores']['cases']['list']>[0],
  patientId: PatientId,
  now: Date,
): Promise<LabHistoryImportResponse['cases']> {
  const page = await runtime.storage.stores.cases.list(clinicId, {
    patientId,
    origin: 'backfill',
    statuses: ACTIVE_CASE_STATUSES,
    limit: 100,
  });
  return page.items.map((item) => ({
    id: item.id,
    status: item.status,
    ...(item.releaseAt === undefined || item.releaseAt.getUTCFullYear() >= 9999
      ? {}
      : { releaseAt: item.releaseAt.toISOString() }),
    released: item.releaseAt !== undefined && item.releaseAt.getTime() <= now.getTime(),
  }));
}
