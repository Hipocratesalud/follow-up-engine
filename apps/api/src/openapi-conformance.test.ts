import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CaseView } from './http/schemas.ts';
import { createHarness, FIXTURE_PATIENT, fixture, type Harness } from './test/harness.ts';

/**
 * HIP-128: every status the API really answers is in /openapi.json. Each
 * request below is made for real; the test fails when its status is not
 * documented for the operation.
 */

interface OpenApiDoc {
  readonly paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  readonly components: { readonly schemas: Record<string, unknown> };
}

function operationOf(doc: OpenApiDoc, method: string, path: string) {
  const pathname = path.split('?')[0] ?? path;
  const verb = method.toLowerCase();
  const exact = doc.paths[pathname]?.[verb];
  if (exact !== undefined) {
    return exact;
  }
  const template = Object.keys(doc.paths).find(
    (candidate) =>
      doc.paths[candidate]?.[verb] !== undefined &&
      new RegExp(`^${candidate.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(pathname),
  );
  return template === undefined ? undefined : doc.paths[template]?.[verb];
}

describe('OpenAPI document', () => {
  let h: Harness;
  let doc: OpenApiDoc;
  let caseId = '';

  beforeAll(async () => {
    h = await createHarness({ app: { maxBodyBytes: 64 * 1024 } });
    doc = (await h.call<OpenApiDoc>('/openapi.json', { key: '' })).body;
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    await h.call('/api/demo/clock/advance', { body: { days: 20 } });
    caseId = (await h.call<{ items: CaseView[] }>('/api/inbox/cases')).body.items[0]?.id ?? '';
  });
  afterAll(async () => {
    await h.close();
  });

  const big = JSON.stringify({ resourceType: 'Bundle', type: 'batch', x: 'x'.repeat(70_000) });
  const requests: readonly (readonly [
    string,
    string,
    { body?: unknown; fhir?: boolean; key?: string; raw?: boolean },
  ])[] = [
    ['GET', '/fhir/metadata', { key: '' }],
    ['POST', '/fhir', { body: fixture('consultation-diabetology'), fhir: true }],
    ['POST', '/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true }],
    ['POST', '/fhir', { body: fixture('invalid-consultation'), fhir: true }],
    ['POST', '/fhir', { body: '{', fhir: true }],
    ['POST', '/fhir', { body: big, fhir: true }],
    ['POST', '/fhir', { body: 'x', raw: true }],
    ['POST', '/fhir', { body: fixture('consultation-diabetology'), fhir: true, key: '' }],
    ['POST', '/fhir/Patient', { body: { resourceType: 'Patient', id: 'oa-1' }, fhir: true }],
    ['POST', '/fhir/Patient', { body: { resourceType: 'Patient', id: 'oa-1' }, fhir: true }],
    ['PUT', '/fhir/Patient/oa-2', { body: { resourceType: 'Patient', id: 'oa-2' }, fhir: true }],
    ['GET', '/fhir/Task?_count=abc', {}],
    ['GET', '/fhir/Task', { key: '' }],
    ['GET', '/fhir/Condition', {}],
    ['GET', '/api/inbox/cases?cursor=garbage', {}],
    ['GET', '/api/inbox/cases?view=nope', {}],
    ['GET', '/api/inbox/cases', { key: '' }],
    ['GET', '/api/inbox/patients?limit=-1', {}],
    ['POST', '/api/inbox/cases/{case}/actions', { body: '{' }],
    ['POST', '/api/inbox/cases/{case}/feedback', { body: '{' }],
    ['POST', '/api/inbox/cases/{case}/feedback', { body: { useful: false } }],
    ['GET', '/jobs/unknown', {}],
    ['GET', '/api/inbox/findings', {}],
    ['GET', '/api/inbox/findings?category=nope', {}],
    ['GET', '/api/inbox/findings?cursor=garbage', {}],
    ['GET', '/api/inbox/findings/metrics', {}],
    ['GET', '/api/inbox/metrics', {}],
    ['GET', '/api/inbox/metrics?from=garbage', {}],
    ['GET', '/api/inbox/findings/missing', {}],
    ['GET', '/api/inbox/findings/missing/fhir', {}],
    ['POST', '/api/inbox/findings/missing/review', { body: { verdict: 'relevant' } }],
    ['POST', '/api/inbox/findings/missing/review', { body: '{' }],
    ['GET', '/api/inbox/finding-flags', {}],
    [
      'PUT',
      '/api/inbox/finding-flags',
      { body: { category: 'lab_trend', enabled: true, mode: 'shadow' } },
    ],
    [
      'PUT',
      '/api/inbox/finding-flags',
      { body: { category: 'lab_trend', enabled: true, mode: 'live' } },
    ],
    ['POST', '/api/demo/review/nobody', {}],
    ['POST', `/api/demo/review/${FIXTURE_PATIENT}`, {}],
  ];

  it.each(requests)('documents %s %s', async (method, rawPath, init) => {
    const path = rawPath.replace('{case}', caseId);
    const response = await h.call(path, {
      method,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.fhir === true ? { fhir: true } : {}),
      ...(init.key === undefined ? {} : { key: init.key }),
      ...(init.raw === true ? { headers: { 'content-type': 'text/plain' } } : {}),
    });
    const operation = operationOf(doc, method, path);
    expect(operation, `${method} ${path} is not in the document`).toBeDefined();
    expect(
      Object.keys(operation?.responses ?? {}),
      `${method} ${path} answered ${String(response.status)}`,
    ).toContain(String(response.status));
  });

  it('documents the protocol behind a reason, with its validation status', () => {
    const reason = JSON.stringify(doc.components.schemas['CaseReasonView']);
    expect(reason).toContain('"protocol":{');
    expect(reason).toContain('#/components/schemas/ProtocolRef');
    const protocol = JSON.stringify(doc.components.schemas['ProtocolRef']);
    expect(protocol).toContain('"enum":["draft","validated"]');
    expect(protocol).toMatch(/"required":\["id","version"\]/);
  });

  it('says that a reason is required when a case was not useful', () => {
    const schema = JSON.stringify(doc.components.schemas['FeedbackRequest']);
    expect(schema).toMatch(/"required":\["useful","reason"\]|"required":\["reason","useful"\]/);
  });
});
