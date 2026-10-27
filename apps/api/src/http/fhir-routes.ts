import {
  type CaseId,
  type ExpectationId,
  type FollowUpCase,
  type IngestReport,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  type Bundle,
  type BundleEntry,
  caseToTask,
  expectationToTask,
  FHIR_VERSION,
  type FhirResource,
  type OperationOutcome,
  patientConditionToFhir,
  qualityFindingToDetectedIssue,
  type Task,
  toSearchsetBundle,
} from '@follow-up-engine/fhir';
import type { BundleAcceptance, EngineRuntime, IngestMode } from '@follow-up-engine/worker';
import type { Context } from 'hono';
import { z } from 'zod';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound } from './errors.ts';

export const FHIR_JSON = 'application/fhir+json';

/** Resource types `POST /fhir/:type` accepts (the ones the engine consumes). */
const WRITABLE_TYPES = new Set([
  'Patient',
  'Encounter',
  'Appointment',
  'ServiceRequest',
  'MedicationRequest',
  'DiagnosticReport',
  'Observation',
  'Condition',
  'DocumentReference',
  'Composition',
  'Consent',
  'Practitioner',
]);

const ISSUE_CODES: Readonly<Record<number, string>> = {
  400: 'invalid',
  401: 'login',
  404: 'not-found',
  409: 'conflict',
  415: 'not-supported',
  422: 'processing',
};

function fhirJson(c: Context, body: FhirResource, status: 200 | 201 | 202 | 400 = 200): Response {
  return c.body(JSON.stringify(body), status, { 'content-type': `${FHIR_JSON}; charset=utf-8` });
}

/** Errors on `/fhir` are `OperationOutcome`s, as FHIR clients expect. */
export function fhirErrorResponse(c: Context, error: HttpError): Response {
  const outcome: OperationOutcome = {
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'error',
        code: (ISSUE_CODES[error.status] ?? 'exception') as 'invalid',
        diagnostics: error.message,
        details: { coding: [{ code: error.code }] },
      },
    ],
  };
  return c.body(JSON.stringify(outcome), error.status, {
    'content-type': `${FHIR_JSON}; charset=utf-8`,
  });
}

function fhirBase(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.origin}/fhir`;
}

async function readFhirBody(c: Context): Promise<unknown> {
  const type = c.req.header('content-type') ?? '';
  if (!/application\/(fhir\+)?json/i.test(type)) {
    throw new HttpError(415, 'unsupported_media_type', `Send ${FHIR_JSON}`);
  }
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'The body is not valid JSON');
  }
}

/** Default asynchronous; `?sync=true` or `Prefer: respond-sync` runs the engine before answering. */
function ingestMode(c: Context): IngestMode {
  const prefer = c.req.header('prefer') ?? '';
  return c.req.query('sync') === 'true' || /respond-sync/i.test(prefer) ? 'sync' : 'async';
}

function summarize(reports: readonly IngestReport[]): string {
  const notes = reports.flatMap((report) => report.notes);
  const failed = notes.filter((note) => note.status === 'failed').length;
  const created = reports.reduce((total, report) => total + report.expectationsCreated.length, 0);
  const closed = reports.reduce((total, report) => total + report.expectationsClosed.length, 0);
  return [
    `${String(created)} expectation(s) created`,
    `${String(closed)} closed`,
    `${String(notes.length - failed)} note(s) read`,
    ...(failed > 0 ? [`${String(failed)} note(s) queued for a retry of the plan extraction`] : []),
  ].join(', ');
}

/** The `transaction-response`: one entry per stored resource, then the issues and engine summary. */
function transactionResponse(
  bundleType: unknown,
  acceptance: BundleAcceptance,
  mode: IngestMode,
): Bundle {
  const entries: BundleEntry[] = acceptance.stored.map((stored) => ({
    response: {
      status: stored.changed && stored.versionId === '1' ? '201 Created' : '200 OK',
      location: `${stored.resourceType}/${stored.id}/_history/${stored.versionId}`,
    },
  }));
  const issues = [...(acceptance.outcome?.issue ?? [])];
  issues.push({
    severity: 'information',
    code: 'informational',
    diagnostics:
      mode === 'async'
        ? `Accepted: ${String(acceptance.batches)} consultation batch(es) queued for the engine`
        : `Processed: ${summarize(acceptance.reports ?? [])}`,
  });
  const outcome: OperationOutcome = { resourceType: 'OperationOutcome', issue: issues };
  entries.push({
    response: { status: mode === 'async' ? '202 Accepted' : '200 OK' },
    resource: outcome,
  });
  return {
    resourceType: 'Bundle',
    type: bundleType === 'batch' ? 'batch-response' : 'transaction-response',
    entry: entries,
  };
}

const TaskSearchSchema = z.object({
  patient: z
    .string()
    .optional()
    .transform((value) => value?.replace(/^Patient\//, '')),
  status: z.string().optional(),
  code: z.string().optional(),
  _count: z.coerce.number().int().min(1).max(500).optional().default(100),
});

const PatientSearchSchema = z.object({
  patient: z
    .string({ error: 'patient is required' })
    .min(1)
    .transform((value) => value.replace(/^Patient\//, '')),
});

function taskMatches(task: Task, status: string | undefined, code: string | undefined): boolean {
  const statusOk =
    status === undefined ||
    status
      .split(',')
      .some(
        (wanted) =>
          task.status === wanted ||
          (task.businessStatus?.coding ?? []).some((coding) => coding.code === wanted),
      );
  const codeOk =
    code === undefined ||
    code.split(',').some((wanted) => {
      const bare = wanted.includes('|') ? wanted.slice(wanted.indexOf('|') + 1) : wanted;
      return (task.code?.coding ?? []).some((coding) => coding.code === bare);
    });
  return statusOk && codeOk;
}

async function allCases(
  runtime: EngineRuntime,
  c: Context<AppEnv>,
  patientId: string | undefined,
  limit: number,
): Promise<FollowUpCase[]> {
  const cases: FollowUpCase[] = [];
  let cursor: string | undefined;
  do {
    const page = await runtime.storage.stores.cases.list(c.var.clinicId, {
      ...(patientId === undefined ? {} : { patientId: toPatientId(patientId) }),
      orderBy: 'created_at',
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    cases.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined && cases.length < limit);
  return cases;
}

/**
 * FHIR R4 endpoints: ingestion (`POST /fhir`, `POST /fhir/:type`) and the
 * engine's own resources (`Task`, `Condition`, `DetectedIssue`) for the host.
 */
export function registerFhirRoutes(app: App, runtime: EngineRuntime): void {
  const { stores, readModel } = runtime.storage;

  app.get('/fhir/metadata', (c) =>
    fhirJson(c, {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: '2026-10-27',
      kind: 'instance',
      fhirVersion: FHIR_VERSION as '4.0.1',
      format: [FHIR_JSON],
      software: { name: 'Follow-up Engine' },
      rest: [
        {
          mode: 'server',
          interaction: [{ code: 'transaction' }, { code: 'batch' }],
          resource: [
            ...[...WRITABLE_TYPES].map((type) => ({
              type: type as 'Patient',
              interaction: [{ code: 'create' as const }, { code: 'update' as const }],
            })),
            {
              type: 'Task',
              interaction: [{ code: 'read' as const }, { code: 'search-type' as const }],
              searchParam: [
                { name: 'patient', type: 'reference' as const },
                { name: 'status', type: 'token' as const },
                { name: 'code', type: 'token' as const },
              ],
            },
            {
              type: 'Condition',
              interaction: [{ code: 'search-type' as const }],
              searchParam: [{ name: 'patient', type: 'reference' as const }],
            },
            {
              type: 'DetectedIssue',
              interaction: [{ code: 'search-type' as const }],
              searchParam: [{ name: 'patient', type: 'reference' as const }],
            },
          ],
        },
      ],
    }),
  );

  app.post('/fhir', async (c) => {
    const bundle = await readFhirBody(c);
    const mode = ingestMode(c);
    const acceptance = await runtime.ingestion.accept(c.var.clinicId, bundle, mode);
    if (!acceptance.ok) {
      c.var.log.info({ outcome: 'rejected' }, 'bundle rejected');
      return fhirJson(
        c,
        acceptance.outcome ?? {
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'invalid', diagnostics: 'Bundle rejected' }],
        },
        400,
      );
    }
    c.var.log.info(
      { mode, batches: acceptance.batches, stored: acceptance.stored.length },
      'bundle accepted',
    );
    if (acceptance.jobId !== undefined) {
      c.header('x-followup-job', acceptance.jobId);
    }
    const bundleType =
      typeof bundle === 'object' && bundle !== null && 'type' in bundle ? bundle.type : undefined;
    return fhirJson(
      c,
      transactionResponse(bundleType, acceptance, mode),
      mode === 'async' ? 202 : 200,
    );
  });

  app.post('/fhir/:type', async (c) => {
    const type = c.req.param('type');
    if (!WRITABLE_TYPES.has(type)) {
      throw new HttpError(404, 'not_supported', `The engine does not accept ${type} resources`);
    }
    const resource = await readFhirBody(c);
    if (typeof resource !== 'object' || resource === null || !('resourceType' in resource)) {
      throw new HttpError(400, 'invalid_resource', 'The body is not a FHIR resource');
    }
    if (resource.resourceType !== type) {
      throw new HttpError(
        400,
        'invalid_resource',
        `Expected a ${type}, got ${String(resource.resourceType)}`,
      );
    }
    const id = 'id' in resource && typeof resource.id === 'string' ? resource.id : undefined;
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        id === undefined
          ? {
              fullUrl: `urn:uuid:${crypto.randomUUID()}`,
              resource: resource as FhirResource,
              request: { method: 'POST', url: type },
            }
          : {
              resource: resource as FhirResource,
              request: { method: 'PUT', url: `${type}/${id}` },
            },
      ],
    };
    const mode = ingestMode(c);
    const acceptance = await runtime.ingestion.accept(c.var.clinicId, bundle, mode);
    if (!acceptance.ok) {
      return fhirJson(
        c,
        acceptance.outcome ?? { resourceType: 'OperationOutcome', issue: [] },
        400,
      );
    }
    const stored = acceptance.stored.find((entry) => entry.resourceType === type);
    if (stored === undefined) {
      return fhirJson(c, transactionResponse('transaction', acceptance, mode), 202);
    }
    const saved = await stores.clinicalRecords.getResource(c.var.clinicId, {
      resourceType: type,
      id: stored.id,
    });
    c.header('location', `${fhirBase(c)}/${type}/${stored.id}/_history/${stored.versionId}`);
    if (acceptance.jobId !== undefined) {
      c.header('x-followup-job', acceptance.jobId);
    }
    return fhirJson(
      c,
      (saved?.resource ?? { resourceType: type, id: stored.id }) as unknown as FhirResource,
      stored.changed && stored.versionId === '1' ? 201 : 200,
    );
  });

  app.get('/fhir/Task', async (c) => {
    const query = TaskSearchSchema.parse(c.req.query());
    const expectations =
      query.patient === undefined
        ? []
        : await readModel.expectationsByPatient(c.var.clinicId, toPatientId(query.patient));
    const cases = await allCases(runtime, c, query.patient, query._count);
    const tasks = [...cases.map(caseToTask), ...expectations.map(expectationToTask)].filter(
      (task) => taskMatches(task, query.status, query.code),
    );
    return fhirJson(
      c,
      toSearchsetBundle(tasks.slice(0, query._count), {
        baseUrl: fhirBase(c),
        total: tasks.length,
        selfUrl: c.req.url,
        timestamp: runtime.clock.now(),
      }),
    );
  });

  app.get('/fhir/Task/:id', async (c) => {
    const id = c.req.param('id');
    const followUpCase = await stores.cases.get(c.var.clinicId, id as CaseId);
    if (followUpCase !== undefined) {
      return fhirJson(c, caseToTask(followUpCase));
    }
    const expectation = await stores.expectations.get(c.var.clinicId, id as ExpectationId);
    if (expectation === undefined) {
      throw notFound(`Task/${id} not found`);
    }
    return fhirJson(c, expectationToTask(expectation));
  });

  app.get('/fhir/Condition', async (c) => {
    const { patient } = PatientSearchSchema.parse(c.req.query());
    const conditions = await stores.conditions.listByPatient(c.var.clinicId, toPatientId(patient));
    return fhirJson(
      c,
      toSearchsetBundle(conditions.map(patientConditionToFhir), {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
      }),
    );
  });

  app.get('/fhir/DetectedIssue', async (c) => {
    const { patient } = PatientSearchSchema.parse(c.req.query());
    const findings = await stores.qualityFindings.listByPatient(
      c.var.clinicId,
      toPatientId(patient),
    );
    return fhirJson(
      c,
      toSearchsetBundle(findings.map(qualityFindingToDetectedIssue), {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
      }),
    );
  });
}
