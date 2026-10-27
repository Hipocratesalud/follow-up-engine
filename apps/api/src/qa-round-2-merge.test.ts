import { buildConsultationBundle } from '@follow-up-engine/fhir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PatientDetail } from './http/schemas.ts';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/*
 * QA round 2, after merging its five branches: behaviors that only exist
 * when two of them meet.
 */

const DAY_MS = 86_400_000;

/** The inbox Demo page's "Diabetes con plan" note (apps/inbox/src/features/demo/example-notes.ts). */
const DIABETES_PLAN_NOTE =
  'Paciente femenina de 61 años con DM2 diagnosticada hace 6 años e HTA. Refiere poliuria y cansancio. Glicemia en ayunas 186 mg/dL, HbA1c 8,9 %. PA 138/86. Se ajusta metformina a 1000 mg c/12h y se inicia sitagliptina 100 mg/día por 90 días. Plan: control en 3 meses con HbA1c; perfil lipídico y microalbuminuria antes de la próxima consulta.';

function resultBundle(patientId: string, loinc: string, value: number, at: Date): unknown {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: {
          resourceType: 'Observation',
          id: `${patientId}-hba1c-hplc`,
          status: 'final',
          category: [
            {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
                  code: 'laboratory',
                },
              ],
            },
          ],
          code: {
            coding: [{ system: 'http://loinc.org', code: loinc, display: 'HbA1c (HPLC)' }],
          },
          subject: { reference: `Patient/${patientId}` },
          effectiveDateTime: at.toISOString(),
          issued: at.toISOString(),
          valueQuantity: { value, unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
        },
        request: { method: 'PUT', url: `Observation/${patientId}-hba1c-hplc` },
      },
    ],
  };
}

describe.each(STORAGES)('QA round 2 merge (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('an HbA1c result under 17856-6 fulfills the HbA1c (4548-4) the demo note asked for', async () => {
    // HIP-121: the demo extractor reads one LOINC-coded lab item per named test;
    // HIP-123: a result answers it under any code of the same measurement.
    const saved = await h.call<{
      bundle: { entry: { resource: { resourceType: string; id: string } }[] };
      extraction: { planItems: { kind: string; description: string }[] };
    }>('/api/demo/consultations', {
      body: {
        patientName: 'Carmen Rosa Liendo',
        specialty: 'diabetology',
        noteText: DIABETES_PLAN_NOTE,
      },
    });
    expect(saved.status).toBe(201);
    expect(
      saved.body.extraction.planItems.filter(
        (item) => item.kind === 'lab' && item.description === 'HbA1c',
      ),
    ).toHaveLength(1);
    const patientId =
      saved.body.bundle.entry.find((entry) => entry.resource.resourceType === 'Patient')?.resource
        .id ?? '';
    const hba1c = async () =>
      (await h.call<PatientDetail>(`/api/inbox/patients/${patientId}`)).body.expectations.filter(
        (expectation) => expectation.layer === 'doctor_plan' && /HbA1c/i.test(expectation.label),
      );
    const before = await hba1c();
    expect(before.map((expectation) => expectation.status)).toEqual(['open']);

    const { now } = (
      await h.call<{ now: string }>('/api/demo/clock/advance', { body: { days: 80 } })
    ).body;
    const posted = await h.call(`/fhir?sync=true`, {
      body: resultBundle(patientId, '17856-6', 7.4, new Date(Date.parse(now) - DAY_MS)),
      fhir: true,
    });
    expect(posted.status).toBe(200);

    const after = await hba1c();
    expect(after.map((expectation) => [expectation.id, expectation.status])).toEqual([
      [before[0]?.id, 'fulfilled'],
    ]);
  });

  it('a note too long to be read whole leaves a note_truncated finding in the inbox and FHIR', async () => {
    // HIP-121 reads the head and the tail of an over-long note; the clinician
    // must know the middle was not read.
    const patientId = 'pat-long-note';
    const filler = 'Paciente estable, sin cambios relevantes en la evolución. '.repeat(500);
    const bundle = buildConsultationBundle({
      consultationId: 'long-note',
      patient: { id: patientId, name: 'Paciente Nota Larga' },
      specialty: 'internal_medicine',
      occurredAt: new Date((await h.call<{ now: string }>('/api/demo/clock')).body.now),
      noteText: `Paciente con HTA. ${filler} Plan: control en 1 mes.`,
    });
    expect((await h.call('/fhir?sync=true', { body: bundle, fhir: true })).status).toBe(200);

    const detail = await h.call<PatientDetail>(`/api/inbox/patients/${patientId}`);
    expect(detail.body.qualityFindings).toContainEqual(
      expect.objectContaining({
        code: 'note_truncated',
        documentId: 'long-note-note',
        label: 'Nota leída en parte',
      }),
    );
    const issues = await h.call<{
      entry?: { resource: { code: { coding: { code: string }[] } } }[];
    }>(`/fhir/DetectedIssue?patient=${patientId}`);
    expect(
      (issues.body.entry ?? []).flatMap((entry) =>
        entry.resource.code.coding.map((coding) => coding.code),
      ),
    ).toContain('note-truncated');
  });

  it('a note read whole has no note_truncated finding', async () => {
    const saved = await h.call<{
      bundle: { entry: { resource: { resourceType: string; id: string } }[] };
    }>('/api/demo/consultations', {
      body: {
        patientName: 'Paciente Corto',
        specialty: 'diabetology',
        noteText: DIABETES_PLAN_NOTE,
      },
    });
    const patientId =
      saved.body.bundle.entry.find((entry) => entry.resource.resourceType === 'Patient')?.resource
        .id ?? '';
    const detail = await h.call<PatientDetail>(`/api/inbox/patients/${patientId}`);
    expect(detail.body.qualityFindings.map((finding) => finding.code)).not.toContain(
      'note_truncated',
    );
  });
});
