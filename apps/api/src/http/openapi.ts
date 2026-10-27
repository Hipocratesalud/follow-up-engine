import { z } from 'zod';
import './schemas.ts';

/*
 * OpenAPI 3.1 document of the API. Component schemas are generated from the
 * same zod schemas that validate requests and type responses (everything
 * registered with `.meta({ id })` in schemas.ts), so the document cannot
 * drift from the code. FHIR payloads are described by reference to FHIR R4.
 */

interface Param {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly required?: boolean;
}

interface Operation {
  readonly method: 'get' | 'post';
  readonly path: string;
  readonly tag: 'FHIR' | 'Inbox' | 'Demo' | 'Health';
  readonly summary: string;
  readonly description?: string;
  readonly params?: readonly Param[];
  /** Component id of the JSON body, or `fhir` for a FHIR resource. */
  readonly body?: string;
  readonly response: string;
  readonly status?: number;
  readonly errors?: readonly number[];
  readonly public?: boolean;
}

const id = (description: string): Param => ({
  name: 'id',
  in: 'path',
  required: true,
  description,
});
const patientParam: Param = {
  name: 'patient',
  in: 'query',
  required: true,
  description: 'Patient id (or Patient/<id>)',
};

const OPERATIONS: readonly Operation[] = [
  {
    method: 'get',
    path: '/healthz',
    tag: 'Health',
    summary: 'Liveness',
    response: 'any',
    public: true,
  },
  {
    method: 'get',
    path: '/readyz',
    tag: 'Health',
    summary: 'Readiness (storage reachable)',
    response: 'any',
    public: true,
    errors: [503],
  },
  {
    method: 'post',
    path: '/fhir',
    tag: 'FHIR',
    summary: 'Ingest a transaction or batch Bundle (one saved consultation)',
    description:
      'Validates and stores the Bundle, then runs the engine: asynchronously by default (202, the ' +
      'engine runs in the worker; `X-FollowUp-Job` has the job id), synchronously with `?sync=true` ' +
      'or `Prefer: respond-sync` (200). Invalid Bundles get a 400 OperationOutcome.',
    params: [{ name: 'sync', in: 'query', enum: ['true'] }],
    body: 'fhir',
    response: 'fhir',
    status: 202,
    errors: [400, 401, 415],
  },
  {
    method: 'post',
    path: '/fhir/{type}',
    tag: 'FHIR',
    summary: 'Create or update a single resource',
    params: [{ name: 'type', in: 'path', required: true }],
    body: 'fhir',
    response: 'fhir',
    status: 201,
    errors: [400, 401, 404, 415],
  },
  {
    method: 'get',
    path: '/fhir/Task',
    tag: 'FHIR',
    summary: 'Search expectations and cases (Tasks)',
    params: [
      {
        name: 'patient',
        in: 'query',
        description: 'Expectations are returned only with a patient',
      },
      { name: 'status', in: 'query', description: 'Task.status or engine businessStatus code' },
      { name: 'code', in: 'query', description: 'Rule id or follow-up-case' },
      { name: '_count', in: 'query' },
    ],
    response: 'fhir',
    errors: [401],
  },
  {
    method: 'get',
    path: '/fhir/Task/{id}',
    tag: 'FHIR',
    summary: 'Read one Task',
    params: [id('Task id')],
    response: 'fhir',
    errors: [401, 404],
  },
  {
    method: 'get',
    path: '/fhir/Condition',
    tag: 'FHIR',
    summary: 'Conditions the engine believes a patient has',
    params: [patientParam],
    response: 'fhir',
    errors: [401, 422],
  },
  {
    method: 'get',
    path: '/fhir/DetectedIssue',
    tag: 'FHIR',
    summary: 'Documentation-quality findings of a patient',
    params: [patientParam],
    response: 'fhir',
    errors: [401, 422],
  },
  {
    method: 'get',
    path: '/fhir/metadata',
    tag: 'FHIR',
    summary: 'CapabilityStatement',
    response: 'fhir',
  },
  {
    method: 'get',
    path: '/api/inbox/clinic',
    tag: 'Inbox',
    summary: 'The authenticated clinic',
    response: 'Clinic',
  },
  {
    method: 'get',
    path: '/api/inbox/cases',
    tag: 'Inbox',
    summary: 'List cases (active: released and in progress, by priority)',
    params: [
      { name: 'view', in: 'query', enum: ['active', 'closed', 'all'] },
      { name: 'origin', in: 'query', enum: ['live', 'backfill'] },
      { name: 'assignee', in: 'query' },
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'CasePage',
  },
  {
    method: 'get',
    path: '/api/inbox/cases/{id}',
    tag: 'Inbox',
    summary: 'Case detail with timeline',
    params: [id('Case id')],
    response: 'CaseDetail',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/cases/{id}/actions',
    tag: 'Inbox',
    summary: 'Notify, snooze, resolve or dismiss a case',
    params: [id('Case id')],
    body: 'CaseActionRequest',
    response: 'CaseDetail',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/cases/{id}/feedback',
    tag: 'Inbox',
    summary: 'Was the case useful? (reason required when not)',
    params: [id('Case id')],
    body: 'FeedbackRequest',
    response: 'CaseDetail',
    errors: [404, 422],
  },
  {
    method: 'get',
    path: '/api/inbox/patients',
    tag: 'Inbox',
    summary: 'Search patients by id or name',
    params: [
      { name: 'query', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'PatientList',
  },
  {
    method: 'get',
    path: '/api/inbox/patients/{id}',
    tag: 'Inbox',
    summary: 'Patient: conditions, expectations, findings',
    params: [id('Patient id')],
    response: 'PatientDetail',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/conditions/{id}/confirm',
    tag: 'Inbox',
    summary: 'Confirm an inferred condition',
    params: [id('Condition id')],
    response: 'ConditionView',
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/api/inbox/conditions/{id}/reject',
    tag: 'Inbox',
    summary: 'Reject an inferred condition (cancels its protocol expectations)',
    params: [id('Condition id')],
    response: 'ConditionView',
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/inbox/recovery',
    tag: 'Inbox',
    summary: 'Backfill cases not yet released ("pacientes por recuperar")',
    params: [
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'RecoveryPage',
  },
  {
    method: 'get',
    path: '/api/inbox/stats',
    tag: 'Inbox',
    summary: 'Inbox and LLM usage stats',
    response: 'InboxStats',
  },
  {
    method: 'get',
    path: '/api/demo/clock',
    tag: 'Demo',
    summary: 'Fake clock (404 with a real clock)',
    response: 'DemoClock',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/demo/clock/advance',
    tag: 'Demo',
    summary: 'Advance the fake clock day by day, running the sweeps and delivering webhooks',
    body: 'AdvanceClockRequest',
    response: 'DemoClock',
    errors: [404, 422],
  },
  {
    method: 'post',
    path: '/api/demo/consultations',
    tag: 'Demo',
    summary: 'Build a consultation Bundle, ingest it synchronously, return the extraction',
    body: 'DemoConsultationRequest',
    response: 'DemoConsultationResponse',
    status: 201,
    errors: [404, 422, 502],
  },
  {
    method: 'get',
    path: '/api/demo/webhooks',
    tag: 'Demo',
    summary: 'Webhooks the sink received for this clinic',
    params: [{ name: 'limit', in: 'query' }],
    response: 'WebhookList',
    errors: [404],
  },
];

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Bad request',
  401: 'Missing or invalid API key',
  404: 'Not found',
  409: 'Invalid case transition',
  415: 'Unsupported media type',
  422: 'Validation error',
  502: 'Upstream (LLM provider or webhook sink) failed',
  503: 'Not ready',
};

function content(ref: string): Record<string, unknown> {
  if (ref === 'any') {
    return { 'application/json': { schema: { type: 'object' } } };
  }
  if (ref === 'fhir') {
    return {
      'application/fhir+json': {
        schema: {
          type: 'object',
          description: 'A FHIR R4 resource (https://hl7.org/fhir/R4/); see docs/fhir.md',
          required: ['resourceType'],
        },
      },
    };
  }
  return { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } };
}

function operation(op: Operation): Record<string, unknown> {
  const errors = Object.fromEntries(
    (op.errors ?? []).map((status) => [
      String(status),
      {
        description: ERROR_DESCRIPTIONS[status] ?? 'Error',
        content: op.tag === 'FHIR' ? content('fhir') : content('Error'),
      },
    ]),
  );
  return {
    tags: [op.tag],
    summary: op.summary,
    ...(op.description === undefined ? {} : { description: op.description }),
    ...(op.public === true ? { security: [] } : {}),
    ...(op.params === undefined
      ? {}
      : {
          parameters: op.params.map((param) => ({
            name: param.name,
            in: param.in,
            required: param.required ?? param.in === 'path',
            ...(param.description === undefined ? {} : { description: param.description }),
            schema: { type: 'string', ...(param.enum === undefined ? {} : { enum: param.enum }) },
          })),
        }),
    ...(op.body === undefined
      ? {}
      : { requestBody: { required: true, content: content(op.body) } }),
    responses: {
      [String(op.status ?? 200)]: { description: 'OK', content: content(op.response) },
      ...errors,
    },
  };
}

/** The OpenAPI 3.1 document served at `/openapi.json`. */
export function openApiDocument(options: { readonly demo: boolean }): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    uri: (schemaId) => `#/components/schemas/${schemaId}`,
    unrepresentable: 'any',
  });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    if (op.tag === 'Demo' && !options.demo) {
      continue;
    }
    paths[op.path] = { ...paths[op.path], [op.method]: operation(op) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Follow-up Engine API',
      version: '0.1.0',
      description:
        'FHIR R4 in and out, the clinic inbox JSON API and demo controls. Authenticate with ' +
        '`Authorization: Bearer <clinic API key>`. Webhooks the engine sends are documented in ' +
        'docs/integration.md.',
    },
    servers: [{ url: '/' }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'FHIR', description: 'HL7 FHIR R4 (application/fhir+json)' },
      { name: 'Inbox', description: 'JSON API of the clinic inbox (Spanish labels)' },
      { name: 'Demo', description: 'Only when the engine runs on a fake clock' },
      { name: 'Health' },
    ],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [
          name,
          Object.fromEntries(
            Object.entries(schema).filter(([key]) => key !== '$id' && key !== '$schema'),
          ),
        ]),
      ),
    },
  };
}

/** API reference UI (Scalar, from a CDN) over `/openapi.json`. */
export function docsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Follow-up Engine API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1"></script>
  </body>
</html>`;
}
