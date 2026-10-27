import type { Bundle, Condition } from '@follow-up-engine/fhir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConditionView, PatientDetail } from './http/schemas.ts';
import { createHarness, fixture, FIXTURE_PATIENT, type Harness, STORAGES } from './test/harness.ts';

/** HIP-118: what the host reads as FHIR `Condition` after a clinician's review. */

function statuses(bundle: Bundle): { code: string; verification: string; clinical: string }[] {
  return (bundle.entry ?? []).map((entry) => {
    const condition = entry.resource as Condition;
    return {
      code: condition.code?.coding?.[0]?.code ?? '',
      verification: condition.verificationStatus?.coding?.[0]?.code ?? '',
      clinical: condition.clinicalStatus?.coding?.[0]?.code ?? '',
    };
  });
}

describe.each(STORAGES)('FHIR Condition export (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('exports a clinician-rejected condition as refuted, never confirmed', async () => {
    const consultation = await h.call<{
      bundle: { entry: { resource: { resourceType: string; id: string } }[] };
    }>('/api/demo/consultations', {
      body: {
        patientName: 'Luis Demo',
        specialty: 'internal_medicine',
        noteText: 'Paciente con HTA de reciente diagnóstico. Plan: control en 1 mes.',
      },
    });
    const patient =
      consultation.body.bundle.entry.find((entry) => entry.resource.resourceType === 'Patient')
        ?.resource.id ?? '';
    const detail = await h.call<PatientDetail>(`/api/inbox/patients/${patient}`);
    const probable = detail.body.conditions.find((item) => item.status === 'probable');
    expect(probable).toBeDefined();
    const rejected = await h.call<ConditionView>(
      `/api/inbox/conditions/${encodeURIComponent(probable?.id ?? '')}/reject`,
      { method: 'POST', headers: { 'x-followup-user': 'dr-b' } },
    );
    expect(rejected.body.status).toBe('rejected');

    const exported = await h.call<Bundle>(`/fhir/Condition?patient=${patient}`);
    const row = statuses(exported.body).find((item) => item.code === probable?.code);
    expect(row).toEqual({ code: probable?.code, verification: 'refuted', clinical: 'inactive' });
    expect(exported.text).not.toContain('follow-up-confirmed-by');
    expect(exported.text).toContain('follow-up-refuted-by');
  });

  it('does not export the note-extracted parent code next to the confirmed specific one', async () => {
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    const exported = await h.call<Bundle>(`/fhir/Condition?patient=${FIXTURE_PATIENT}`);
    const rows = statuses(exported.body);
    expect(rows.some((row) => row.code === 'E11.9' && row.verification === 'confirmed')).toBe(true);
    expect(rows.filter((row) => row.verification === 'provisional')).toEqual([]);
    expect(exported.body.total).toBe(rows.length);
  });
});
