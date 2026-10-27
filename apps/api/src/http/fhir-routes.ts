import {
  type CaseId,
  type CaseStatus,
  type ClinicId,
  contactRequestId,
  type ExpectationId,
  type FollowUpCase,
  type IngestReport,
  type PatientId,
  patientId as toPatientId,
  type SuppressionId,
} from '@follow-up-engine/core';
import {
  type Bundle,
  type BundleEntryResponse,
  type CapabilityStatement,
  type Coding,
  caseToTask,
  communicationToFhir,
  contactRequestToFhir,
  expectationToTask,
  exportableConditions,
  FHIR_VERSION,
  type FhirResource,
  type OperationOutcome,
  patientConditionToFhir,
  clinicalFindingToDetectedIssue,
  qualityFindingToDetectedIssue,
  suppressionToFlag,
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
  'Communication',
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

/** The contact outcomes a synchronous ingestion recorded, for the summary. */
function outcomesSummary(acceptance: BundleAcceptance): string {
  const recorded = (acceptance.contactOutcomes ?? []).filter((result) => result.changed).length;
  return (acceptance.contactOutcomes ?? []).length === 0
    ? ''
    : `, ${String(recorded)} contact outcome(s) recorded`;
}

/** What the engine did, for the `X-FollowUp-Summary` header. */
function summaryOf(acceptance: BundleAcceptance, mode: IngestMode): string {
  const stale = staleCount(acceptance);
  const summary =
    mode === 'async'
      ? `Accepted: ${String(acceptance.batches)} consultation batch(es) queued for the engine`
      : `Processed: ${summarize(acceptance.reports ?? [])}${outcomesSummary(acceptance)}`;
  return stale === 0
    ? summary
    : `${summary}; ${String(stale)} stale version(s) not stored (older than the stored one)`;
}

/** Issue of an entry whose resource is older than the stored version (not stored). */
function staleIssue(stored: NonNullable<EntryResult['stored']>): OperationOutcome['issue'][number] {
  return {
    severity: 'warning',
    code: 'conflict',
    diagnostics:
      `stale: ${stored.resourceType}/${stored.id} is older than the stored version ` +
      `${stored.versionId}; not stored and its events not ingested`,
    details: { coding: [{ code: 'stale', display: 'Older than the stored version' }] },
  };
}

function isFailure(issue: OperationOutcome['issue'][number]): boolean {
  return issue.severity === 'error' || issue.severity === 'fatal';
}

function entryResponse(result: EntryResult): BundleEntryResponse {
  const stored = result.stored;
  const issues = [...result.issues, ...(stored?.stale === true ? [staleIssue(stored)] : [])];
  const outcome: OperationOutcome | undefined =
    issues.length === 0 ? undefined : { resourceType: 'OperationOutcome', issue: issues };
  const failures = result.issues.filter(isFailure);
  const failed = failures.length > 0;
  const status = !failed
    ? stored?.changed === true && stored.versionId === '1'
      ? '201 Created'
      : '200 OK'
    : failures.some((issue) => issue.code === 'not-supported')
      ? '405 Method Not Allowed'
      : '400 Bad Request';
  return {
    status,
    ...(stored === undefined || failed
      ? {}
      : {
          location: `${stored.resourceType}/${stored.id}/_history/${stored.versionId}`,
          etag: `W/"${stored.versionId}"`,
        }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

/** Whether every request entry failed (a batch answered entry by entry, nothing stored). */
function everyEntryFailed(acceptance: BundleAcceptance): boolean {
  return (
    acceptance.entries.length > 0 &&
    acceptance.entries.every((entry) => entry.issues.some(isFailure))
  );
}

function staleCount(acceptance: BundleAcceptance): number {
  return acceptance.stored.filter((entry) => entry.stale === true).length;
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

/**
 * Search parameters given more than once. FHIR combines repeats with AND
 * (a comma inside one value is OR): with `Prefer: handling=strict` a repeat
 * is a 400, so a host that meant OR finds out; by default it is applied as
 * AND with a warning (`_count` / `_offset` take the first value).
 */
function repeatedParams(c: Context, known: readonly string[]): OperationOutcome | undefined {
  const repeated = Object.entries(c.req.queries())
    .filter(([name, values]) => known.includes(name) && values.length > 1)
    .map(([name]) => name);
  if (repeated.length === 0) {
    return undefined;
  }
  const message =
    `Repeated search parameter(s): ${repeated.join(', ')}. FHIR combines repeated ` +
    'parameters with AND; separate values with a comma for OR';
  if (strictHandling(c)) {
    throw new HttpError(400, 'repeated_search_parameter', message);
  }
  return {
    resourceType: 'OperationOutcome',
    issue: [
      {
        severity: 'warning',
        code: 'processing',
        diagnostics: `${message}; applied with AND (_count and _offset use the first value)`,
      },
    ],
  };
}

/** Every value of a parameter, each one split on commas (OR inside a value). */
function paramValues(c: Context, name: string): string[][] {
  return (c.req.queries(name) ?? []).map((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  );
}

/**
 * The patients a search names through `patient` (and `subject`): each value
 * is an OR list of ids (`Patient/` prefix optional), repeats are ANDed.
 * `undefined` when no patient parameter was given.
 */
function searchedPatients(c: Context, names: readonly string[]): string[] | undefined {
  const lists = names.flatMap((name) => paramValues(c, name));
  if (lists.length === 0) {
    return undefined;
  }
  const ids = lists.map((list) => list.map((value) => value.replace(/^Patient\//, '')));
  const [first = [], ...rest] = ids;
  return [...new Set(first)].filter((id) => rest.every((list) => list.includes(id)));
}

function requiredPatients(c: Context): string[] {
  const patients = searchedPatients(c, ['patient']);
  if (patients === undefined) {
    throw new HttpError(400, 'invalid_search', 'patient is required');
  }
  return patients;
}

const TASK_SEARCH_PARAMS = ['patient', 'subject', 'status', 'code', '_count', '_offset'];

const TaskPagingSchema = z.object({
  _count: z.coerce.number().int().min(0).max(500).optional().default(100),
  _offset: z.coerce.number().int().min(0).optional().default(0),
});

const PATIENT_SEARCH_PARAMS = ['patient'];

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

/** Each repeated value must match (AND); inside a value, any comma-separated item (OR). */
function taskMatches(
  task: Task,
  statuses: readonly string[][],
  codes: readonly string[][],
): boolean {
  const statusOk = statuses.every((any) =>
    any.some(
      (wanted) =>
        task.status === wanted ||
        (task.businessStatus?.coding ?? []).some((coding) => coding.code === wanted),
    ),
  );
  const codeOk = codes.every((any) =>
    any.some((wanted) => tokenMatches(wanted, task.code?.coding ?? [])),
  );
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
          ...[...WRITABLE_TYPES]
            .filter((type) => type !== 'Condition' && type !== 'Communication')
            .map(writable),
          {
            type: 'Communication',
            documentation:
              'What came of a contact attempt: basedOn the CommunicationRequest, the outcome in ' +
              'the contact-outcome extension or statusReason.',
            interaction: [
              { code: 'create' as const },
              { code: 'update' as const },
              { code: 'read' as const },
              { code: 'search-type' as const },
            ],
            searchParam: [patientParam],
          },
          {
            type: 'CommunicationRequest',
            documentation: 'Contact attempts the engine asked for (one per attempt).',
            interaction: [{ code: 'read' as const }, { code: 'search-type' as const }],
            searchParam: [patientParam],
          },
          {
            type: 'Flag',
            documentation: 'Reminders stopped for one patient (category follow-up-suppression).',
            interaction: [{ code: 'read' as const }, { code: 'search-type' as const }],
            searchParam: [patientParam],
          },
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
    if (staleCount(acceptance) > 0) {
      c.header('x-followup-stale', String(staleCount(acceptance)));
    }
    const bundleType =
      typeof bundle === 'object' && bundle !== null && 'type' in bundle ? bundle.type : undefined;
    // Nothing was queued when every entry of a batch failed: the answer is final.
    const status = mode === 'async' && !everyEntryFailed(acceptance) ? 202 : 200;
    return fhirJson(c, transactionResponse(bundleType, acceptance), status);
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
    if (stored.stale === true) {
      // The body is the newer stored version: this one was not stored.
      c.header('x-followup-stale', 'true');
    }
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
    const repeated = repeatedParams(c, TASK_SEARCH_PARAMS);
    const paging = TaskPagingSchema.safeParse(c.req.query());
    if (!paging.success) {
      throw new HttpError(
        400,
        'invalid_search',
        paging.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      );
    }
    const query = paging.data;
    const patients = searchedPatients(c, ['patient', 'subject']);
    const expectations = (
      await Promise.all(
        (patients ?? []).map((patient) =>
          stores.expectations.listByPatient(c.var.clinicId, toPatientId(patient)),
        ),
      )
    ).flat();
    const cases =
      patients === undefined
        ? await allCases(runtime, c, undefined)
        : (await Promise.all(patients.map((patient) => allCases(runtime, c, patient)))).flat();
    const statuses = paramValues(c, 'status');
    const codes = paramValues(c, 'code');
    const tasks = [...cases.map(caseToTask), ...expectations.map(expectationToTask)].filter(
      (task) => taskMatches(task, statuses, codes),
    );
    const { _offset: offset, _count: count } = query;
    const page = tasks.slice(offset, offset + count);
    const notice: OperationOutcome | undefined =
      patients === undefined
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
    const outcome = mergeOutcomes(ignored, repeated, notice);
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
    const outcome = mergeOutcomes(
      unknownParams(c, PATIENT_SEARCH_PARAMS),
      repeatedParams(c, PATIENT_SEARCH_PARAMS),
    );
    const conditions = (
      await Promise.all(
        requiredPatients(c).map((patient) =>
          stores.conditions.listByPatient(c.var.clinicId, toPatientId(patient)),
        ),
      )
    ).flat();
    return fhirJson(
      c,
      toSearchsetBundle(exportableConditions(conditions).map(patientConditionToFhir), {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
        ...(outcome === undefined ? {} : { outcome }),
      }),
    );
  });

  app.get('/fhir/DetectedIssue', async (c) => {
    const outcome = mergeOutcomes(
      unknownParams(c, PATIENT_SEARCH_PARAMS),
      repeatedParams(c, PATIENT_SEARCH_PARAMS),
    );
    const patients = requiredPatients(c);
    const findings = (
      await Promise.all(
        patients.map((patient) =>
          stores.qualityFindings.listByPatient(c.var.clinicId, toPatientId(patient)),
        ),
      )
    ).flat();
    // Clinical reviewer findings reach the host only once their category is
    // live (validated): a shadow finding is never exported.
    const clinical = (
      await Promise.all(
        patients.map(async (patient) => {
          const page = await runtime.reviewer.listFindings(c.var.clinicId, {
            mode: 'live',
            patientId: toPatientId(patient),
            limit: 100,
          });
          return page.items;
        }),
      )
    ).flat();
    return fhirJson(
      c,
      toSearchsetBundle(
        [
          ...findings.map(qualityFindingToDetectedIssue),
          ...clinical.map(clinicalFindingToDetectedIssue),
        ],
        {
          baseUrl: fhirBase(c),
          selfUrl: c.req.url,
          ...(outcome === undefined ? {} : { outcome }),
        },
      ),
    );
  });

  /** The case status of each attempt's case, for `CommunicationRequest.status`. */
  async function caseStatuses(
    clinicId: ClinicId,
    caseIds: readonly CaseId[],
  ): Promise<Map<CaseId, CaseStatus>> {
    const statuses = new Map<CaseId, CaseStatus>();
    for (const caseId of new Set(caseIds)) {
      const found = await stores.cases.get(clinicId, caseId);
      if (found !== undefined) {
        statuses.set(caseId, found.status);
      }
    }
    return statuses;
  }

  async function contactResources(clinicId: ClinicId, patientId: PatientId) {
    const { requests, communications } = await runtime.engine.contacts.forPatient(
      clinicId,
      patientId,
    );
    const statuses = await caseStatuses(
      clinicId,
      requests.map((request) => request.caseId),
    );
    return {
      requests: requests.map((request) => {
        const caseStatus = statuses.get(request.caseId);
        return contactRequestToFhir(request, {
          communications,
          ...(caseStatus === undefined ? {} : { caseStatus }),
        });
      }),
      communications: communications.map(communicationToFhir),
    };
  }

  function patientSearch(c: Context<AppEnv>) {
    return {
      outcome: mergeOutcomes(
        unknownParams(c, PATIENT_SEARCH_PARAMS),
        repeatedParams(c, PATIENT_SEARCH_PARAMS),
      ),
      patients: requiredPatients(c).map((patient) => toPatientId(patient)),
    };
  }

  app.get('/fhir/CommunicationRequest', async (c) => {
    const { outcome, patients } = patientSearch(c);
    const resources = [];
    for (const patientId of patients) {
      resources.push(...(await contactResources(c.var.clinicId, patientId)).requests);
    }
    return fhirJson(
      c,
      toSearchsetBundle(resources, {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
        ...(outcome === undefined ? {} : { outcome }),
      }),
    );
  });

  app.get('/fhir/CommunicationRequest/:id', async (c) => {
    const id = c.req.param('id');
    const request = await runtime.engine.contacts.getRequest(c.var.clinicId, contactRequestId(id));
    if (request === undefined) {
      throw notFound(`CommunicationRequest/${id} not found`);
    }
    const { communications } = await runtime.engine.contacts.forPatient(
      c.var.clinicId,
      request.patientId,
    );
    const caseStatus = (await stores.cases.get(c.var.clinicId, request.caseId))?.status;
    return fhirJson(
      c,
      contactRequestToFhir(request, {
        communications,
        ...(caseStatus === undefined ? {} : { caseStatus }),
      }),
    );
  });

  app.get('/fhir/Communication', async (c) => {
    const { outcome, patients } = patientSearch(c);
    const resources = [];
    for (const patientId of patients) {
      resources.push(...(await contactResources(c.var.clinicId, patientId)).communications);
    }
    return fhirJson(
      c,
      toSearchsetBundle(resources, {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
        ...(outcome === undefined ? {} : { outcome }),
      }),
    );
  });

  app.get('/fhir/Communication/:id', async (c) => {
    const id = c.req.param('id');
    const communication = await runtime.engine.contacts.getCommunication(c.var.clinicId, id);
    if (communication === undefined) {
      throw notFound(`Communication/${id} not found`);
    }
    return fhirJson(c, communicationToFhir(communication));
  });

  app.get('/fhir/Flag', async (c) => {
    const { outcome, patients } = patientSearch(c);
    const flags = [];
    for (const patientId of patients) {
      flags.push(
        ...(await runtime.engine.suppressions.list(c.var.clinicId, patientId)).map(
          suppressionToFlag,
        ),
      );
    }
    return fhirJson(
      c,
      toSearchsetBundle(flags, {
        baseUrl: fhirBase(c),
        selfUrl: c.req.url,
        ...(outcome === undefined ? {} : { outcome }),
      }),
    );
  });

  app.get('/fhir/Flag/:id', async (c) => {
    const id = c.req.param('id');
    const suppression = await stores.suppressions.get(c.var.clinicId, id as SuppressionId);
    if (suppression === undefined) {
      throw notFound(`Flag/${id} not found`);
    }
    return fhirJson(c, suppressionToFlag(suppression));
  });
}
