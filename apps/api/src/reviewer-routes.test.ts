import { loadReviewerCohort, validateFhirR4 } from '@follow-up-engine/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FindingDetail,
  FindingFlagView,
  FindingView,
  ReviewMetrics,
  ReviewRunView,
} from './http/reviewer-schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/**
 * HIP-112: the clinical reviewer's API. Shadow findings for the clinical
 * staff's batch review (never exported, never a webhook), verdicts, the
 * category flags (live needs a sign-off), the FHIR R4 DetectedIssue export,
 * and the demo's "review now".
 */

interface FindingPageBody {
  readonly items: FindingView[];
  readonly nextCursor?: string;
  readonly counts: { readonly total: number; readonly byCategory: Record<string, number> };
}

interface Bundle {
  readonly entry: readonly { readonly resource: { readonly resourceType: string } }[];
}

const cohort = loadReviewerCohort();

/** Delivers the outbox through the in-process signed sink, then reads what it got. */
async function deliveredFindingWebhooks(h: Harness) {
  const { sink } = h.runtime;
  if (sink === undefined) throw new Error('the demo runtime has an in-process webhook sink');
  await h.runtime.storage.drainOutbox(h.runtime.publisher, h.runtime.clock.now(), 500);
  return sink.list().filter((delivery) => delivery.type === 'clinical_finding.created');
}

async function sendPatient(h: Harness, id: string): Promise<void> {
  const patient = cohort.patients.find((item) => item.patientId === id);
  for (const entry of patient?.entries ?? []) {
    const response = await h.call(`/fhir?sync=true`, { body: entry.bundle, fhir: true });
    expect(response.status, id).toBe(200);
  }
}

describe.each(STORAGES)('clinical reviewer API (%s)', (storage) => {
  let h: Harness;
  let trend: FindingView;

  beforeAll(async () => {
    h = await createHarness({ storage });
    for (const id of ['rev-0001', 'rev-0003', 'rev-0004']) await sendPatient(h, id);
    for (const id of ['rev-0001', 'rev-0003']) {
      const review = await h.call<{ run: ReviewRunView; findings: FindingView[] }>(
        `/api/demo/review/${id}`,
        { method: 'POST' },
      );
      expect(review.status).toBe(200);
      expect(review.body.run).toMatchObject({ status: 'completed', stopReason: 'submitted' });
    }
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  it('lists shadow findings with citations, the trend they cite and counts', async () => {
    const page = await h.call<FindingPageBody>('/api/inbox/findings');
    expect(page.status).toBe(200);
    expect(page.body.items.every((item) => item.mode === 'shadow')).toBe(true);
    expect(page.body.counts.byCategory).toMatchObject({
      lab_trend: 1,
      drug_condition_conflict: 1,
      unaddressed_symptom: 1,
    });
    const found = page.body.items.find((item) => item.category === 'lab_trend');
    if (found === undefined) throw new Error('no lab trend');
    trend = found;
    expect(trend.patient).toMatchObject({
      id: 'rev-0001',
      name: 'Rodolfo Arismendi Paz',
      sex: 'male',
    });
    expect(trend.citations.map((citation) => citation.quote)).toEqual([
      'Creatinine: 1.05 mg/dL',
      'Creatinine: 1.1 mg/dL',
      'Creatinine: 1.4 mg/dL',
      'Creatinine: 1.75 mg/dL',
    ]);
    expect(trend.trend?.points.map((point) => point.value)).toEqual([1.05, 1.1, 1.4, 1.75]);
    expect(trend.trend?.points.every((point) => point.cited)).toBe(true);
    const symptom = page.body.items.find((item) => item.category === 'unaddressed_symptom');
    expect(symptom?.citations[0]).toMatchObject({ kind: 'note' });
    expect(symptom?.citations[0]?.text).toContain(symptom?.citations[0]?.quote ?? '');

    const filtered = await h.call<FindingPageBody>(
      '/api/inbox/findings?category=lab_trend,unaddressed_symptom&severity=high,medium&limit=1',
    );
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.nextCursor).toBeDefined();
    expect((await h.call('/api/inbox/findings?category=nope')).status).toBe(422);
    expect((await h.call('/api/inbox/findings?cursor=garbage')).status).toBe(400);
  });

  it('a finding comes with the agent run that produced it (tool trace, cost)', async () => {
    const detail = await h.call<FindingDetail>(`/api/inbox/findings/${trend.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run?.trace.map((step) => step.tool)).toContain('get_lab_trend');
    expect(detail.body.run?.trace.at(-1)?.tool).toBe('submit_findings');
    expect(detail.body.run?.modelId).toBe('fake:fake-reviewer');
    expect((await h.call('/api/inbox/findings/missing')).status).toBe(404);
    // Another clinic's key never sees it.
    expect((await h.call(`/api/inbox/findings/${trend.id}`, { key: KEY_B })).status).toBe(404);
  });

  it('exports a finding as a FHIR R4 DetectedIssue for the staff, valid against the R4 schema', async () => {
    const response = await h.call<Record<string, unknown>>(`/api/inbox/findings/${trend.id}/fhir`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/fhir+json');
    const validation = validateFhirR4(response.body);
    expect(validation.issues).toEqual([]);
    expect(response.body).toMatchObject({
      resourceType: 'DetectedIssue',
      status: 'preliminary',
      severity: 'high',
      patient: { reference: 'Patient/rev-0001' },
      implicated: expect.arrayContaining([
        expect.objectContaining({ type: 'Observation' }),
      ]) as unknown,
    });
    const evidence = (response.body['evidence'] as { detail: { display: string }[] }[])[0]?.detail;
    expect(evidence?.map((detail) => detail.display)).toContain('Creatinine: 1.75 mg/dL');
  });

  it('shadow findings never reach the host: no DetectedIssue in /fhir, no webhook', async () => {
    const issues = await h.call<{
      entry?: { resource: { code?: { coding?: { system: string }[] } } }[];
    }>('/fhir/DetectedIssue?patient=rev-0001', { fhir: true });
    expect(issues.status).toBe(200);
    const clinical = (issues.body.entry ?? []).filter((entry) =>
      entry.resource.code?.coding?.some((coding) =>
        coding.system.endsWith('clinical-finding-category'),
      ),
    );
    expect(clinical).toEqual([]);
    expect(await deliveredFindingWebhooks(h)).toEqual([]);
  });

  it('records verdicts; "not relevant" needs a reason', async () => {
    const missing = await h.call<{ error: { code: string; fields: { path: string }[] } }>(
      `/api/inbox/findings/${trend.id}/review`,
      { body: { verdict: 'not_relevant' } },
    );
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.map((field) => field.path)).toEqual(['reason']);
    const reviewed = await h.call<FindingView>(`/api/inbox/findings/${trend.id}/review`, {
      body: { verdict: 'relevant' },
      headers: { 'X-FollowUp-User': 'dra-castellanos' },
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      status: 'relevant',
      review: { verdict: 'relevant', reviewedBy: 'dra-castellanos' },
    });
    const metrics = await h.call<ReviewMetrics>('/api/inbox/findings/metrics');
    expect(metrics.body).toMatchObject({
      patientsReviewed: 2,
      reviewed: 1,
      relevant: 1,
      precision: 1,
    });
    const reviewedList = await h.call<FindingPageBody>('/api/inbox/findings?status=reviewed');
    expect(reviewedList.body.items.map((item) => item.id)).toEqual([trend.id]);
  });

  it('flags: every category listed, live only with a sign-off, the reserved one never on', async () => {
    const flags = await h.call<{ items: FindingFlagView[] }>('/api/inbox/finding-flags');
    expect(flags.body.items).toHaveLength(11);
    expect(flags.body.items.find((flag) => flag.category === 'lab_trend')).toMatchObject({
      enabled: true,
      mode: 'shadow',
      implemented: true,
      review: { reviewed: 1, relevant: 1, precision: 1 },
    });
    expect(flags.body.items.find((flag) => flag.category === 'similar_patients')).toMatchObject({
      implemented: false,
      enabled: false,
    });
    const unsigned = await h.call('/api/inbox/finding-flags', {
      method: 'PUT',
      body: { category: 'drug_interaction', enabled: true, mode: 'live' },
    });
    expect(unsigned.status).toBe(422);
    const reserved = await h.call('/api/inbox/finding-flags', {
      method: 'PUT',
      body: { category: 'similar_patients', enabled: true, mode: 'shadow' },
    });
    expect(reserved.status).toBe(422);
    const live = await h.call<FindingFlagView>('/api/inbox/finding-flags', {
      method: 'PUT',
      body: {
        category: 'drug_interaction',
        enabled: true,
        mode: 'live',
        validatedBy: 'Dra. Castellanos',
      },
    });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ mode: 'live', validatedBy: 'Dra. Castellanos' });
  });

  it('a live finding reaches the host: DetectedIssue in /fhir and a clinical_finding.created webhook', async () => {
    const review = await h.call<{ findings: FindingView[] }>('/api/demo/review/rev-0004', {
      method: 'POST',
    });
    expect(review.body.findings.map((finding) => [finding.category, finding.mode])).toEqual([
      ['drug_interaction', 'live'],
    ]);
    const issues = await h.call<{ entry?: { resource: Bundle['entry'][number]['resource'] }[] }>(
      '/fhir/DetectedIssue?patient=rev-0004',
      { fhir: true },
    );
    const clinical = (issues.body.entry ?? []).filter(
      (entry) => entry.resource.resourceType === 'DetectedIssue',
    );
    expect(clinical.length).toBeGreaterThanOrEqual(1);
    for (const entry of clinical) expect(validateFhirR4(entry.resource).issues).toEqual([]);
    const webhooks = await deliveredFindingWebhooks(h);
    expect(webhooks).toHaveLength(1);
    // Ids and severity only: never the finding's text, a diagnosis or a test name.
    expect(Object.keys((webhooks[0]?.payload as { data: object }).data).sort()).toEqual([
      'detectedIssue',
      'findingId',
      'patientId',
      'severity',
    ]);
  });

  it('the demo review answers 404 for an unknown patient and needs the demo scope', async () => {
    expect((await h.call('/api/demo/review/nobody', { method: 'POST' })).status).toBe(404);
    expect((await h.call('/api/demo/review/rev-0001', { method: 'POST', key: KEY_B })).status).toBe(
      403,
    );
  });
});
