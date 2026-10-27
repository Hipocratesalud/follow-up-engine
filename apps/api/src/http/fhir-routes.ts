import {
  type CaseId,
  type ExpectationId,
  type FollowUpCase,
  type IngestReport,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import {
  type Bundle,
  type BundleEntryResponse,
  type CapabilityStatement,
  type Coding,
  caseToTask,
  expectationToTask,
  exportableConditions,
  FHIR_VERSION,
  type FhirResource,
  type OperationOutcome,
  patientConditionToFhir,
  qualityFindingToDetectedIssue,
  type Task,
  toSearchsetBundle,
} from '@follow-up-engine/fhir';
import type {
  BundleAcceptance,
  EngineRuntime,
  EntryResult,
  IngestMode,
} from '@follow-up-engine/runtime';
import type { Context } from 'hono';
import { z } from 'zod';
import type { App, AppEnv } from './context.ts';
import { HttpError, notFound } from './errors.ts';

export const FHIR_JSON = 'application/fhir+json';

/** `CapabilityStatement.date`: when the declared capabilities last changed. */
const FHIR_CAPABILITY_DATE = '2026-10-27';

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
  403: 'forbidden',
  409: 'conflict',
  413: 'too-costly',
  415: 'not-supported',
  422: 'processing',
  429: 'throttled',
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

/** `Prefer: handling=strict` (FHIR search): unknown parameters are an error instead of a warning. */
function strictHandling(c: Context): boolean {
  return /handling\s*=\s*strict/i.test(c.req.header('prefer') ?? '');
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

/** What the engine did, for the `X-FollowUp-Summary` header. */
function summaryOf(acceptance: BundleAcceptance, mode: IngestMode): string {
  return mode === 'async'
    ? `Accepted: ${String(acceptance.batches)} consultation batch(es) queued for the engine`
    : `Processed: ${summarize(acceptance.reports ?? [])}`;
}

function entryResponse(result: EntryResult): BundleEntryResponse {
  const outcome: OperationOutcome | undefined =
    result.issues.length === 0
      ? undefined
      : { resourceType: 'OperationOutcome', issue: [...result.issues] };
  const failed = result.issues.some(
    (issue) => issue.severity === 'error' || issue.severity === 'fatal',
  );
  const stored = result.stored;
  return {
    status: failed
      ? '400 Bad Request'
      : stored?.changed === true && stored.versionId === '1'
        ? '201 Created'
        : '200 OK',
    ...(stored === undefined || failed
      ? {}
      : {
          location: `${stored.resourceType}/${stored.id}/_history/${stored.versionId}`,
          etag: `W/"${stored.versionId}"`,
        }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/**
 * The `transaction-response` / `batch-response`: exactly one entry per
 * request entry, in request order (FHIR R4 http.html#transaction-response).
 * A stored resource gets `201 Created` / `200 OK` and its versioned
 * `location`; a failed batch entry `400` with its `OperationOutcome`; an
 * ignored one (a type the engine does not consume) `200 OK` with an
 * informational outcome. What the engine did goes in `X-FollowUp-Summary`.
 */
function transactionResponse(bundleType: unknown, acceptance: BundleAcceptance): Bundle {
  return {
    resourceType: 'Bundle',
    type: bundleType === 'batch' ? 'batch-response' : 'transaction-response',
    ...(acceptance.entries.length === 0
      ? {}
      : { entry: acceptance.entries.map((result) => ({ response: entryResponse(result) })) }),
  };
}

/** Where the host polls an asynchronous ingestion (FHIR async pattern: `Content-Location`). */
function jobLocation(c: Context, jobId: string): string {
  return `${new URL(c.req.url).origin}/jobs/${jobId}`;
}

/** Search parameters every FHIR search accepts and the engine ignores harmlessly. */
const COMMON_SEARCH_PARAMS = ['_format', '_pretty'];

/**
 * Unknown search parameters: with `Prefer: handling=strict` a 400; by
 * default (lenient) a warning in the searchset's `outcome` entry, so the
 * host knows its filter was not applied.
 */
function unknownParams(c: Context, known: readonly string[]): OperationOutcome | undefined {
  const unknown = Object.keys(c.req.queries()).filter(
    (name) => !known.includes(name) && !COMMON_SEARCH_PARAMS.includes(name),
  );
  if (unknown.length === 0) {
    return undefined;
  }
  const message = `Unsupported search parameter(s): ${unknown.join(', ')}. Supported: ${known.join(', ')}`;
  if (strictHandling(c)) {
    throw new HttpError(400, 'unsupported_search_parameter', message);
  }
  return {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'warning', code: 'not-supported', diagnostics: `${message}; ignored` }],
  };
}

function mergeOutcomes(
  ...outcomes: readonly (OperationOutcome | undefined)[]
): OperationOutcome | undefined {
  const issue = outcomes.flatMap((outcome) => outcome?.issue ?? []);
  return issue.length === 0 ? undefined : { resourceType: 'OperationOutcome', issue };
}

const patientReference = z
  .string()
  .min(1)
  .transform((value) => value.replace(/^Patient\//, ''));

const TASK_SEARCH_PARAMS = ['patient', 'subject', 'status', 'code', '_count', '_offset'];

const TaskSearchSchema = z.object({
  patient: patientReference.optional(),
  subject: patientReference.optional(),
  status: z.string().optional(),
  code: z.string().optional(),
  _count: z.coerce.number().int().min(0).max(500).optional().default(100),
  _offset: z.coerce.number().int().min(0).optional().default(0),
});

const PATIENT_SEARCH_PARAMS = ['patient'];

const PatientSearchSchema = z.object({
  patient: z
    .string({ error: 'patient is required' })
    .min(1)
    .transform((value) => value.replace(/^Patient\//, '')),
});

/** FHIR token search: `code`, `system|code`, or `|code` (a coding without system). */
function tokenMatches(token: string, codings: readonly Coding[]): boolean {
  const bar = token.indexOf('|');
  if (bar === -1) {
    return codings.some((coding) => coding.code === token);
  }
  const system = token.slice(0, bar);
  const code = token.slice(bar + 1);
  return codings.some(
    (coding) =>
      (code === '' || coding.code === code) &&
      (system === '' ? coding.system === undefined : coding.system === system),
  );
}

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
    code.split(',').some((wanted) => tokenMatches(wanted, task.code?.coding ?? []));
  return statusOk && codeOk;
}

/** The current search URL with `_offset` (and `_count`) set: paging links. */
function pageUrl(c: Context, offset: number, count: number): string {
  const url = new URL(c.req.url);
  url.searchParams.set('_offset', String(offset));
  url.searchParams.set('_count', String(count));
  return url.toString();
}

async function allCases(
  runtime: EngineRuntime,
  c: Context<AppEnv>,
  patientId: string | undefined,
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
  } while (cursor !== undefined);
  return cases;
}

/** Resource types and interactions, as `/fhir/metadata` declares them and the routes serve them. */
function capabilityStatement(c: Context): CapabilityStatement {
  const writable = (type: string) =>
    ({
      type,
      interaction: [{ code: 'create' as const }, { code: 'update' as const }],
    }) as const;
  const patientParam = {
    name: 'patient',
    type: 'reference' as const,
    documentation: 'Patient id or Patient/<id> (required)',
  };
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: FHIR_CAPABILITY_DATE,
    kind: 'instance',
    fhirVersion: FHIR_VERSION,
    format: [FHIR_JSON],
    software: { name: 'Follow-up Engine' },
    implementation: {
      description: 'Follow-up Engine: clinical follow-up over FHIR R4',
      url: fhirBase(c),
    },
    rest: [
      {
        mode: 'server',
        documentation:
          'Authenticate with Authorization: Bearer <clinic API key> (scope fhir:write); ' +
          'this CapabilityStatement is public.',
        interaction: [{ code: 'transaction' }, { code: 'batch' }],
        resource: [
          ...[...WRITABLE_TYPES].filter((type) => type !== 'Condition').map(writable),
          {
            type: 'Condition',
            interaction: [
              { code: 'create' as const },
              { code: 'update' as const },
              { code: 'search-type' as const },
            ],
            searchParam: [patientParam],
          },
          {
            type: 'Task',
            interaction: [{ code: 'read' as const }, { code: 'search-type' as const }],
            searchParam: [
              { name: 'patient', type: 'reference' as const },
              { name: 'subject', type: 'reference' as const },
              { name: 'status', type: 'token' as const },
              { name: 'code', type: 'token' as const },
              { name: '_count', type: 'number' as const },
              { name: '_offset', type: 'number' as const },
            ],
          },
          {
            type: 'DetectedIssue',
            interaction: [{ code: 'search-type' as const }],
            searchParam: [patientParam],
          },
        ],
      },
    ],
  } as CapabilityStatement;
}

/**
 * FHIR R4 endpoints: ingestion (`POST /fhir`, `POST /fhir/:type`,
 * `PUT /fhir/:type/:id`) and the engine's own resources (`Task`,
 * `Condition`, `DetectedIssue`) for the host. `/fhir/metadata` is public.
 */
export function registerFhirRoutes(app: App, runtime: EngineRuntime): void {
  const { stores } = runtime.storage;

  app.get('/fhir/metadata', (c) => fhirJson(c, capabilityStatement(c)));

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
      c.header('content-location', jobLocation(c, acceptance.jobId));
    }
    c.header('x-followup-summary', summaryOf(acceptance, mode));
    const bundleType =
      typeof bundle === 'object' && bundle !== null && 'type' in bundle ? bundle.type : undefined;
    return fhirJson(c, transactionResponse(bundleType, acceptance), mode === 'async' ? 202 : 200);
  });

  /** Create (`POST /fhir/:type`) or update (`PUT /fhir/:type/:id`) one resource. */
  async function writeResource(c: Context<AppEnv>, type: string, pathId?: string) {
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
    const bodyId = 'id' in resource && typeof resource.id === 'string' ? resource.id : undefined;
    if (pathId !== undefined && bodyId !== pathId) {
      throw new HttpError(
        400,
        'invalid_resource',
        `The resource id (${bodyId ?? 'missing'}) must match the URL (${pathId})`,
      );
    }
    const id = pathId ?? bodyId;
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
    if (acceptance.jobId !== undefined) {
      c.header('x-followup-job', acceptance.jobId);
      c.header('content-location', jobLocation(c, acceptance.jobId));
    }
    c.header('x-followup-summary', summaryOf(acceptance, mode));
    const stored = acceptance.stored.find((entry) => entry.resourceType === type);
    if (stored === undefined) {
      return fhirJson(c, transactionResponse('transaction', acceptance), 202);
    }
    const saved = await stores.clinicalRecords.getResource(c.var.clinicId, {
      resourceType: type,
      id: stored.id,
    });
    c.header('location', `${fhirBase(c)}/${type}/${stored.id}/_history/${stored.versionId}`);
    c.header('etag', `W/"${stored.versionId}"`);
    return fhirJson(
      c,
      (saved?.resource ?? { resourceType: type, id: stored.id }) as unknown as FhirResource,
      stored.changed && stored.versionId === '1' ? 201 : 200,
    );
  }

  app.post('/fhir/:type', (c) => writeResource(c, c.req.param('type')));
  app.put('/fhir/:type/:id', (c) => writeResource(c, c.req.param('type'), c.req.param('id')));

  app.get('/fhir/Task', async (c) => {
    const ignored = unknownParams(c, TASK_SEARCH_PARAMS);
    const query = TaskSearchSchema.parse(c.req.query());
    if (
      query.patient !== undefined &&
      query.subject !== undefined &&
      query.patient !== query.subject
    ) {
      throw new HttpError(400, 'invalid_search', 'patient and subject name different patients');
    }
    const patient = query.patient ?? query.subject;
    const expectations =
      patient === undefined
        ? []
        : await stores.expectations.listByPatient(c.var.clinicId, toPatientId(patient));
    const cases = await allCases(runtime, c, patient);
    const tasks = [...cases.map(caseToTask), ...expectations.map(expectationToTask)].filter(
      (task) => taskMatches(task, query.status, query.code),
    );
    const { _offset: offset, _count: count } = query;
    const page = tasks.slice(offset, offset + count);
    const notice: OperationOutcome | undefined =
      patient === undefined
        ? {
            resourceType: 'OperationOutcome',
            issue: [
              {
                severity: 'information',
                code: 'informational',
                diagnostics:
                  'Without patient only cases are returned; expectation Tasks need patient',
              },
            ],
          }
        : undefined;
    const outcome = mergeOutcomes(ignored, notice);
    return fhirJson(
      c,
      toSearchsetBundle(page, {
        baseUrl: fhirBase(c),
        total: tasks.length,
        selfUrl: c.req.url,
        ...(count > 0 && offset + count < tasks.length
          ? { nextUrl: pageUrl(c, offset + count, count) }
          : {}),
        ...(count > 0 && offset > 0
          ? { previousUrl: pageUrl(c, Math.max(0, offset - count), count) }
          : {}),
        timestamp: runtime.clock.now(),
        ...(outcome === undefined ? {} : { outcome }),
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
    const ignored = unknownParams(c, PATIENT_SEARCH_PARAMS);
    const { patient } = PatientSearchSchema.parse(c.req.query());
    const conditions = await stores.conditions.listByPatient(c.var.clinicId, toPatientId(patient));
    return fhirJson(
      c,
      toSearchsetBundle(exportableConditions(conditions).map(patientConditionToFhir), {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
        ...(ignored === undefined ? {} : { outcome: ignored }),
      }),
    );
  });

  app.get('/fhir/DetectedIssue', async (c) => {
    const ignored = unknownParams(c, PATIENT_SEARCH_PARAMS);
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
        ...(ignored === undefined ? {} : { outcome: ignored }),
      }),
    );
  });
}
