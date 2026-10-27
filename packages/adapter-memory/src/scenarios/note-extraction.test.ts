import {
  type ClinicId,
  NOTE_EXTRACTION_JOB,
  TenantMismatchError,
  ValidationError,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { FakeNoteExtractor } from '../fake-note-extractor.ts';
import { CODES, consultation, icd10, scenario } from '../testing/index.ts';

const NOTE = { id: 'doc-1', text: 'HTA en control. Plan: control en 3 meses.' };

describe('note extraction during ingest', () => {
  it('an extractor failure keeps the structured expectations and enqueues a retry job', async () => {
    const extractor = new FakeNoteExtractor().failFor('doc-1');
    const world = await scenario({ extractor })
      .at(0)
      .consult({ encounterId: 'enc-1', labs: [{ id: 'sr-1', code: CODES.creatinine }], note: NOTE })
      .check(({ lastIngest }) => {
        expect(lastIngest?.notes).toMatchObject([
          {
            documentId: 'doc-1',
            status: 'failed',
            error: 'FakeExtractionError: Extraction of doc-1 failed',
          },
        ]);
        expect(lastIngest?.notes[0]?.retryJobId).toBeDefined();
      })
      .expectOpenExpectations([{ ruleId: 'lab_order_result_pending', matchKey: 'loinc:2160-0' }])
      .run();

    const [job] = world.harness.stores.jobs.list(world.clinicId);
    expect(job).toMatchObject({
      type: NOTE_EXTRACTION_JOB,
      payload: { patientId: 'pat-1', documentId: 'doc-1' },
      status: 'pending',
    });
    expect(JSON.stringify(job?.payload)).not.toContain('HTA');

    await expect(
      world.engine.runNoteExtractionJob(world.clinicId, job?.payload ?? {}),
    ).rejects.toThrow(/Extraction of doc-1 failed/u);

    extractor.recover();
    const retried = await world.engine.runNoteExtractionJob(world.clinicId, job?.payload ?? {});
    expect(retried.notes).toMatchObject([{ documentId: 'doc-1', status: 'extracted' }]);
    // The plan's visit covers the protocol visit; the pending creatinine order covers the protocol labs.
    expect(retried.expectationsCreated.map((expectation) => expectation.ruleId)).toEqual([
      'doctor_plan_followup',
    ]);
    expect(retried.conditionsUpserted).toMatchObject([
      {
        code: icd10('I10'),
        status: 'probable',
        sourceType: 'extracted_from_note',
        confidence: 0.9,
      },
    ]);

    const again = await world.engine.runNoteExtractionJob(world.clinicId, job?.payload ?? {});
    expect(again.notes).toEqual([{ documentId: 'doc-1', status: 'already_extracted' }]);
    expect(again.expectationsCreated).toEqual([]);
    expect(extractor.calls).toHaveLength(3);
  });

  it('a retry job for an unknown note or a malformed payload is rejected', async () => {
    const world = await scenario().run();
    await expect(
      world.engine.runNoteExtractionJob(world.clinicId, { patientId: 'pat-1', documentId: 'nope' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      world.engine.runNoteExtractionJob(world.clinicId, { patientId: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a canned extraction drives the plan, conditions and evidence', async () => {
    const extractor = new FakeNoteExtractor().setExtraction('doc-1', {
      hasPlan: true,
      conditions: [{ code: icd10('E11'), confidence: 0.95, evidenceQuote: 'DM2' }],
      planItems: [
        {
          kind: 'imaging',
          description: 'chest x-ray',
          dueAt: new Date('2026-01-19T12:00:00.000Z'),
          evidenceQuote: 'Rx de tórax en 2 semanas',
          confidence: 0.8,
          code: CODES.chestXray,
        },
        {
          kind: 'follow_up_visit',
          description: 'low confidence visit',
          dueAt: new Date('2026-02-05T12:00:00.000Z'),
          evidenceQuote: 'quizás volver',
          confidence: 0.2,
        },
      ],
      costUsd: 0.0012,
    });
    const world = await scenario({ extractor })
      .at(0)
      .consult({
        encounterId: 'enc-1',
        note: { id: 'doc-1', text: 'DM2. Rx de tórax en 2 semanas.' },
      })
      .run();
    const plan = world.expectations().find((expectation) => expectation.layer === 'doctor_plan');
    expect(plan).toMatchObject({
      matchKey: 'loinc:36643-5',
      evidence: { quote: 'Rx de tórax en 2 semanas', sourceDocumentId: 'doc-1' },
    });
    expect(
      world.expectations().filter((expectation) => expectation.layer === 'doctor_plan'),
    ).toHaveLength(1);
    expect(world.lastIngest?.notes[0]?.extraction?.costUsd).toBe(0.0012);
    expect(world.lastIngest?.derivedEvents.map((event) => event.type)).toEqual([
      'plan.extracted',
      'condition.recorded',
    ]);
  });

  it('a result fulfills a doctor-plan lab item of the same code', async () => {
    const extractor = new FakeNoteExtractor();
    await scenario({ extractor })
      .at(0)
      .consult({
        encounterId: 'enc-1',
        note: { id: 'doc-1', text: 'Plan: ctrl en 3 meses con HbA1c.' },
      })
      .at(80)
      .consult({
        encounterId: 'enc-2',
        specialty: 'lab',
        results: [{ id: 'obs-1', code: CODES.hba1c, value: 6.1 }],
      })
      .expectOpenExpectations([])
      .run();
  });

  it('an HbA1c of 6.5 or more makes diabetes probable', async () => {
    const world = await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', results: [{ id: 'obs-1', code: CODES.hba1c, value: 7.2 }] })
      .run();
    expect(world.lastIngest?.conditionsUpserted).toMatchObject([
      { code: icd10('E14'), status: 'probable', sourceType: 'inferred_from_result' },
    ]);
  });

  it('rejects batches mixing clinics or patients', async () => {
    const world = await scenario().run();
    const batch = consultation(world.context(), { encounterId: 'enc-1' });
    await expect(
      world.engine.ingest({ ...batch, clinicId: 'other-clinic' as ClinicId }),
    ).rejects.toBeInstanceOf(TenantMismatchError);
    await expect(
      world.engine.ingest({ ...batch, patientId: world.context('pat-2').patientId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a coded diagnosis is never downgraded by a provisional one', async () => {
    const world = await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', conditions: [{ id: 'c-1', icd10: 'I10' }] })
      .at(5)
      .consult({
        encounterId: 'enc-2',
        conditions: [{ id: 'c-2', icd10: 'I10', provisional: true }],
      })
      .run();
    const conditions = await world.harness.stores.conditions.listByPatient(
      world.clinicId,
      world.patientId,
    );
    expect(conditions).toMatchObject([{ status: 'confirmed', confidence: 1 }]);
  });
});
