import type { Bundle, OperationOutcome } from '@follow-up-engine/fhir';
import { validateFhirR4 } from '@follow-up-engine/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CalibrationReportView,
  CaseDetail,
  CaseView,
  PatientDetail,
  SuppressionView,
} from './http/schemas.ts';
import { createHarness, type Harness, KEY_B, STORAGES } from './test/harness.ts';

/**
 * HIP-136: the patient-contact loop through the API. The demo clinic runs
 * `default_v2` (WhatsApp at day 14 of a case, a front-desk call at day 21,
 * a second WhatsApp at day 28); the host reports outcomes as FHIR
 * `Communication`s and the team records calls in the inbox.
 */

interface CasePage {
  readonly items: readonly CaseView[];
}

const OUTCOME_EXTENSION = 'https://hipocratesalud.com/fhir/StructureDefinition/contact-outcome';
const OUTCOME_SYSTEM = 'https://hipocratesalud.com/fhir/CodeSystem/contact-outcome';

interface Delivery {
  readonly type: string;
  readonly payload: { readonly data: Readonly<Record<string, unknown>> };
  readonly signatureValid: boolean;
}

function put(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    resource,
    request: {
      method: 'PUT',
      url: `${String(resource['resourceType'])}/${String(resource['id'])}`,
    },
  };
}

function patient(id: string, phone = '+58 412 000 0000'): Record<string, unknown> {
  return {
    resourceType: 'Patient',
    id,
    name: [{ text: `Paciente ${id}` }],
    telecom: [{ system: 'phone', value: phone }],
  };
}

function labOrder(patientId: string, id: string, at: Date): Record<string, unknown> {
  return {
    resourceType: 'ServiceRequest',
    id,
    status: 'active',
    intent: 'order',
    category: [
      { coding: [{ system: 'http://snomed.info/sct', code: '108252007', display: 'Laboratory' }] },
    ],
    code: { coding: [{ system: 'http://loinc.org', code: '4548-4', display: 'HbA1c' }] },
    subject: { reference: `Patient/${patientId}` },
    authoredOn: at.toISOString(),
  };
}

function communication(
  id: string,
  requestId: string,
  patientId: string,
  outcome: string,
  status = 'completed',
): Record<string, unknown> {
  return {
    resourceType: 'Communication',
    id,
    extension: [
      {
        url: OUTCOME_EXTENSION,
        valueCodeableConcept: { coding: [{ system: OUTCOME_SYSTEM, code: outcome }] },
      },
    ],
    basedOn: [{ reference: `CommunicationRequest/${requestId}` }],
    status,
    subject: { reference: `Patient/${patientId}` },
    sent: '2026-02-03T12:00:00Z',
  };
}

function bundle(type: 'transaction' | 'batch', ...resources: Record<string, unknown>[]) {
  return { resourceType: 'Bundle', type, entry: resources.map(put) };
}

describe.each(STORAGES)('patient-contact loop through the API (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  async function advance(days: number): Promise<void> {
    expect((await h.call('/api/demo/clock/advance', { body: { days } })).status).toBe(200);
  }

  async function deliveries(type: string): Promise<Delivery[]> {
    const response = await h.call<{ items: Delivery[] }>(
      `/api/demo/webhooks?limit=200&type=${type}`,
    );
    return response.body.items;
  }

  /** A pending lab order whose case opens on day 15 and reaches its first WhatsApp on day 29. */
  async function caseWithWhatsApp(
    patientId: string,
  ): Promise<{ caseId: string; requestId: string }> {
    const sent = await h.call('/fhir?sync=true', {
      fhir: true,
      body: bundle(
        'transaction',
        patient(patientId),
        labOrder(patientId, `sr-${patientId}`, h.runtime.clock.now()),
      ),
    });
    expect(sent.status).toBe(200);
    await advance(29);
    const cases = await h.call<CasePage>(`/api/inbox/cases?view=active&patient=${patientId}`);
    const caseId = cases.body.items[0]?.id ?? '';
    const request = (await deliveries('patient_contact.requested')).find(
      (delivery) => delivery.payload.data['patientId'] === patientId,
    );
    expect(request?.signatureValid).toBe(true);
    const link = request?.payload.data['communicationRequest'];
    if (typeof link !== 'string') {
      throw new Error('patient_contact.requested without its CommunicationRequest');
    }
    expect(link).toMatch(/^CommunicationRequest\//);
    return { caseId, requestId: link.slice('CommunicationRequest/'.length) };
  }

  it('asks for a WhatsApp as a CommunicationRequest, thin webhook, valid R4', async () => {
    const { caseId, requestId } = await caseWithWhatsApp('pat-wa');
    const [webhook] = (await deliveries('patient_contact.requested')).filter(
      (delivery) => delivery.payload.data['patientId'] === 'pat-wa',
    );
    expect(webhook?.payload.data).toEqual({
      caseId,
      patientId: 'pat-wa',
      purpose: 'complete_pending_test',
      dueBy: expect.any(String) as string,
      channel: 'whatsapp',
      attempt: 1,
      task: `Task/${caseId}`,
      communicationRequest: `CommunicationRequest/${requestId}`,
    });
    const read = await h.call<Record<string, unknown>>(`/fhir/CommunicationRequest/${requestId}`);
    expect(read.status).toBe(200);
    expect(validateFhirR4(read.body).issues).toEqual([]);
    expect(read.body).toMatchObject({
      status: 'active',
      basedOn: [{ reference: `Task/${caseId}` }],
    });
    const search = await h.call<Bundle>('/fhir/CommunicationRequest?patient=pat-wa');
    expect(validateFhirR4(search.body).issues).toEqual([]);
    expect(search.body.total).toBe(1);
    // Another clinic does not see it.
    expect((await h.call(`/fhir/CommunicationRequest/${requestId}`, { key: KEY_B })).status).toBe(
      404,
    );
  });

  it('records a Communication from the host; refuses an unknown or foreign basedOn', async () => {
    const { caseId, requestId } = await caseWithWhatsApp('pat-te');
    const unknown = await h.call<OperationOutcome>('/fhir?sync=true', {
      fhir: true,
      body: bundle('transaction', communication('wa-x', 'cr-nope', 'pat-te', 'replied')),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.issue[0]).toMatchObject({
      severity: 'error',
      code: 'not-found',
      expression: ['Bundle.entry[0].resource.basedOn'],
    });
    const foreign = await h.call<OperationOutcome>('/fhir?sync=true', {
      fhir: true,
      key: KEY_B,
      body: bundle('transaction', communication('wa-y', requestId, 'pat-te', 'replied')),
    });
    expect(foreign.status).toBe(400);
    const wrongPatient = await h.call<Bundle>('/fhir?sync=true', {
      fhir: true,
      body: bundle('batch', communication('wa-z', requestId, 'pat-other', 'replied')),
    });
    expect(wrongPatient.body.entry?.[0]?.response?.status).toMatch(/^400/);

    const recorded = await h.call<Bundle>('/fhir?sync=true', {
      fhir: true,
      body: bundle('transaction', communication('wa-1', requestId, 'pat-te', 'treated_elsewhere')),
    });
    expect(recorded.status).toBe(200);
    expect(recorded.headers.get('x-followup-summary')).toMatch(/1 contact outcome\(s\) recorded/);
    const detail = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`);
    expect(detail.body.status).toBe('resolved');
    expect(detail.body.contactAttempts).toMatchObject([
      { id: requestId, channel: 'whatsapp', status: 'answered', outcome: 'treated_elsewhere' },
    ]);
    // Re-sent: nothing new happens.
    const again = await h.call<Bundle>('/fhir?sync=true', {
      fhir: true,
      body: bundle('transaction', communication('wa-1', requestId, 'pat-te', 'treated_elsewhere')),
    });
    expect(again.headers.get('x-followup-summary')).toMatch(/0 contact outcome\(s\) recorded/);
    const read = await h.call<Record<string, unknown>>('/fhir/Communication/wa-1');
    expect(validateFhirR4(read.body).issues).toEqual([]);
    const search = await h.call<Bundle>('/fhir/Communication?patient=pat-te');
    expect(search.body.total).toBe(1);
  });

  it('a wrong number brings the call forward; the team records it; the flag clears with a new phone', async () => {
    const { caseId, requestId } = await caseWithWhatsApp('pat-wn');
    await h.call('/fhir?sync=true', {
      fhir: true,
      body: bundle(
        'transaction',
        communication('wa-wn', requestId, 'pat-wn', 'wrong_number', 'not-done'),
      ),
    });
    let detail = (await h.call<CaseDetail>(`/api/inbox/cases/${caseId}`)).body;
    expect(detail.callTask).toMatchObject({ trigger: 'wrong_number' });
    expect(detail.callTask?.outcomes.map((option) => option.label)).toEqual([
      'Contestó y agendó',
      'Contestó, se atiende en otro lado',
      'No contestó',
      'Número equivocado',
      'No quiere seguimiento',
    ]);
    expect(detail.patientContact.contactFlag).toMatchObject({ label: 'Número equivocado' });
    const patientPage = await h.call<PatientDetail>('/api/inbox/patients/pat-wn');
    expect(patientPage.body.patient.contact.contactDataInvalid).toBe(true);

    const call = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/call-outcome`, {
      body: { outcome: 'no_answer', requestId: detail.callTask?.requestId },
      headers: { 'x-followup-user': 'recepcion-ana' },
    });
    expect(call.status).toBe(200);
    detail = call.body;
    expect(detail.callTask).toBeUndefined();
    expect(detail.contactAttempts.map((attempt) => [attempt.channel, attempt.status])).toEqual([
      ['whatsapp', 'unreached'],
      ['phone_call', 'unreached'],
    ]);
    expect(detail.contactAttempts[1]?.communications[0]).toMatchObject({
      sender: 'user',
      senderName: 'recepcion-ana',
      outcomeLabel: 'No contestó',
    });
    await advance(1);
    const outcome = (await deliveries('contact.outcome_recorded')).find(
      (delivery) => delivery.payload.data['caseId'] === caseId,
    );
    expect(outcome?.payload.data).toMatchObject({ outcome: 'no_answer', channel: 'phone_call' });
    expect(Object.keys(outcome?.payload.data ?? {}).sort()).toEqual(
      [
        'caseId',
        'channel',
        'communication',
        'communicationRequest',
        'outcome',
        'patientId',
        'task',
      ].sort(),
    );

    // The host fixes the phone number: the flag clears.
    await h.call('/fhir?sync=true', {
      fhir: true,
      body: bundle('transaction', patient('pat-wn', '+58 414 111 1111')),
    });
    const fixed = await h.call<PatientDetail>('/api/inbox/patients/pat-wn');
    expect(fixed.body.patient.contact.contactDataInvalid).toBe(false);
  });

  it('dismisses with a reason (feedback once), stops the rule for the patient, reactivates it', async () => {
    const { caseId } = await caseWithWhatsApp('pat-ds');
    const missing = await h.call<{ error: { fields: { path: string }[] } }>(
      `/api/inbox/cases/${caseId}/actions`,
      { body: { action: 'dismiss' } },
    );
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.map((field) => field.path)).toEqual(['reason']);
    const noNote = await h.call(`/api/inbox/cases/${caseId}/actions`, {
      body: { action: 'dismiss', reason: 'other' },
    });
    expect(noNote.status).toBe(422);

    const dismissed = await h.call<CaseDetail>(`/api/inbox/cases/${caseId}/actions`, {
      body: {
        action: 'dismiss',
        reason: 'not_applicable_to_patient',
        note: 'Se hace los controles en su seguro',
        suppress: true,
      },
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.dismissal).toMatchObject({
      reason: 'not_applicable_to_patient',
      reasonLabel: 'No aplica a este paciente',
      suppressions: [{ ruleId: 'lab_order_result_pending', active: true }],
    });
    expect(dismissed.body.feedback).toEqual({
      useful: false,
      reason: 'not_applicable_to_patient',
      comment: 'Se hace los controles en su seguro',
    });
    const task = await h.call<Record<string, unknown>>(`/fhir/Task/${caseId}`);
    expect(task.body).toMatchObject({
      status: 'cancelled',
      statusReason: { coding: [{ code: 'not_applicable_to_patient' }] },
    });

    const page = await h.call<PatientDetail>('/api/inbox/patients/pat-ds');
    const [suppression] = page.body.suppressions;
    expect(suppression).toMatchObject({
      active: true,
      dismissReasonLabel: 'No aplica a este paciente',
    });
    const flags = await h.call<Bundle>('/fhir/Flag?patient=pat-ds');
    expect(flags.body.total).toBe(1);
    expect(validateFhirR4(flags.body).issues).toEqual([]);

    // A new order of the same test for this patient creates nothing; for another patient it does.
    await h.call('/fhir?sync=true', {
      fhir: true,
      body: bundle(
        'transaction',
        labOrder('pat-ds', 'sr-ds-2', h.runtime.clock.now()),
        patient('pat-other'),
        labOrder('pat-other', 'sr-other', h.runtime.clock.now()),
      ),
    });
    const expectations = await h.call<Bundle>(
      '/fhir/Task?patient=pat-ds&code=lab_order_result_pending',
    );
    const other = await h.call<Bundle>(
      '/fhir/Task?patient=pat-other&code=lab_order_result_pending',
    );
    expect(other.body.total).toBe(1);
    expect(
      (expectations.body.entry ?? []).filter(
        (entry) => (entry.resource as { status?: string }).status === 'requested',
      ),
    ).toEqual([]);

    const reactivated = await h.call<SuppressionView>(
      `/api/inbox/suppressions/${suppression?.id ?? ''}/reactivate`,
      { body: {} },
    );
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ active: false });
    expect(
      (await h.call(`/api/inbox/suppressions/${suppression?.id ?? ''}/reactivate`, { body: {} }))
        .status,
    ).toBe(409);
    expect(
      (
        await h.call(`/api/inbox/suppressions/${suppression?.id ?? ''}/reactivate`, {
          body: {},
          key: KEY_B,
        })
      ).status,
    ).toBe(404);

    const calibration = await h.call<CalibrationReportView>('/api/inbox/calibration');
    expect(calibration.body.rules).toContainEqual(
      expect.objectContaining({
        ruleId: 'lab_order_result_pending',
        notUseful: 1,
        dismissals: expect.objectContaining({ not_applicable_to_patient: 1 }) as unknown,
      }),
    );
  });
});
