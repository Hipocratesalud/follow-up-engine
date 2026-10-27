import { describe, expect, it } from 'vitest';
import { FakeNoteExtractor } from '../fake-note-extractor.ts';
import { CODES, defined, SCENARIO_BASE_DATE, scenario } from '../testing/index.ts';

const DIABETES_NOTE_WITHOUT_PLAN =
  'Paciente femenina de 58 años con DM2 en tratamiento con metformina 850 mg c/12h. Refiere buena adherencia. Sin cambios.';

describe('PRD acceptance scenarios', () => {
  it('diabetic woman without a visit in 6 months and a note without plan: one protocol case and a quality finding', async () => {
    const world = await scenario()
      .at(0)
      .consult({
        encounterId: 'enc-1',
        specialty: 'internal_medicine',
        practitionerId: 'dr-rivas',
        conditions: [{ id: 'cond-dm2', icd10: 'E11.9' }],
        note: { id: 'doc-1', text: DIABETES_NOTE_WITHOUT_PLAN },
      })
      .check(({ lastIngest }) => {
        expect(lastIngest?.qualityFindings.map((finding) => finding.kind)).toEqual([
          'note_without_plan',
        ]);
        expect(
          lastIngest?.expectationsCreated.map((expectation) => expectation.ruleId).sort(),
        ).toEqual([
          'protocol_diabetes_fundus',
          'protocol_diabetes_hba1c',
          'protocol_diabetes_lipids',
          'protocol_diabetes_visit',
        ]);
      })
      .at(181)
      .runWatcher()
      .expectCases([
        { reasons: ['protocol_diabetes_hba1c', 'protocol_diabetes_visit'], status: 'open' },
      ])
      .run();

    const [followUpCase] = await world.activeCases();
    expect(followUpCase?.assignee).toBe('dr-rivas');
    expect(world.outbox().filter((event) => event.type === 'case.opened')).toHaveLength(1);
  });

  it('doctor plan "control en 3 meses" beats the protocol visit and opens the case at month 3', async () => {
    await scenario()
      .at(0)
      .consult({
        encounterId: 'enc-1',
        conditions: [{ id: 'cond-dm2', icd10: 'E11' }],
        note: { id: 'doc-1', text: 'Paciente con DM2 estable. Plan: control en 3 meses.' },
      })
      .expectOpenExpectations([
        { ruleId: 'doctor_plan_followup', layer: 'doctor_plan', matchKey: 'visit', dueDay: 90 },
        { ruleId: 'protocol_diabetes_hba1c', matchKey: 'loinc:4548-4', dueDay: 90 },
        { ruleId: 'protocol_diabetes_lipids', dueDay: 365 },
        { ruleId: 'protocol_diabetes_fundus', dueDay: 365 },
      ])
      .at(89)
      .runWatcher()
      .expectNoCases()
      .at(91)
      .runWatcher()
      .expectCases([{ reasons: ['doctor_plan_followup', 'protocol_diabetes_hba1c'] }])
      .run();
  });

  it('a plan that also asks for HbA1c covers the protocol HbA1c item too', async () => {
    await scenario()
      .at(0)
      .consult({
        encounterId: 'enc-1',
        conditions: [{ id: 'cond-dm2', icd10: 'E11' }],
        note: { id: 'doc-1', text: 'DM2. Plan: ctrl en 3 meses con HbA1c.' },
      })
      .expectOpenExpectations([
        { ruleId: 'doctor_plan_followup', matchKey: 'visit', dueDay: 90 },
        { ruleId: 'doctor_plan_followup', matchKey: 'loinc:4548-4', dueDay: 90 },
        { ruleId: 'protocol_diabetes_lipids' },
        { ruleId: 'protocol_diabetes_fundus' },
      ])
      .run();
  });

  it('repeated lab orders: the same test supersedes (new clock), a different test coexists, a visit does not close them', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', labs: [{ id: 'sr-1', code: CODES.hba1c }] })
      .at(10)
      .consult({
        encounterId: 'enc-2',
        labs: [
          { id: 'sr-2', code: CODES.hba1c },
          { id: 'sr-3', code: CODES.creatinine },
        ],
      })
      .check((world) => {
        const first = world.expectations().find((expectation) => expectation.source.id === 'sr-1');
        expect(first?.status).toBe('superseded');
        expect(first?.closedReason).toBe('superseded_by_new_order');
      })
      .at(12)
      .consult({ encounterId: 'enc-3', specialty: 'cardiology' })
      .at(16)
      .runWatcher()
      .expectNoCases()
      .expectOpenExpectations([
        { ruleId: 'lab_order_result_pending', matchKey: 'loinc:4548-4', dueDay: 25 },
        { ruleId: 'lab_order_result_pending', matchKey: 'loinc:2160-0', dueDay: 25 },
        // Two diabetology visits 10 days apart already make a pattern (3 x 10 days).
        { ruleId: 'cadence_break', dueDay: 40 },
      ])
      .at(26)
      .runWatcher()
      .expectCases([{ reasons: ['lab_order_result_pending', 'lab_order_result_pending'] }])
      .run();
  });

  it('a newer order of the same test closes the case of the old one as superseded', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', labs: [{ id: 'sr-1', code: CODES.hba1c }] })
      .at(16)
      .runWatcher()
      .expectCases([{ reasons: ['lab_order_result_pending'] }])
      .at(20)
      .consult({ encounterId: 'enc-2', labs: [{ id: 'sr-2', code: CODES.hba1c }] })
      .expectNoCases()
      .check(async (world) => {
        const [closed] = await world.cases();
        expect(closed?.status).toBe('resolved');
        expect(closed?.resolution?.kind).toBe('not_needed');
        const audit = await world.audit(defined(closed).id);
        expect(audit.at(-1)?.payload).toMatchObject({ closedReasons: ['superseded_by_new_order'] });
      })
      .expectOpenExpectations([
        { ruleId: 'lab_order_result_pending', dueDay: 35 },
        { ruleId: 'cadence_break', dueDay: 80 },
      ])
      .run();
  });

  it('a result for the order (basedOn) fulfills the expectation', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', labs: [{ id: 'sr-1', code: CODES.hba1c }] })
      .at(5)
      .ingest((world) => [
        {
          type: 'result.received',
          clinicId: world.clinicId,
          patientId: world.patientId,
          source: { resourceType: 'DiagnosticReport', id: 'dr-1' },
          occurredAt: world.clock.now(),
          idempotencyKey: 'DiagnosticReport/dr-1/1#result.received',
          basedOnOrderId: 'sr-1',
          code: CODES.hba1c,
          interpretation: 'normal',
        },
      ])
      .expectOpenExpectations([])
      .at(30)
      .runWatcher()
      .expectNoCases()
      .run();
  });

  it('psychology patient with monthly sessions who stops coming: cadence case after 3x the interval', async () => {
    const sessions = [0, 30, 60, 90];
    let built = scenario();
    for (const [index, day] of sessions.entries()) {
      built = built
        .at(day)
        .consult({ encounterId: `enc-${String(index)}`, specialty: 'psychology' });
    }
    await built
      .expectOpenExpectations([
        { ruleId: 'cadence_break', layer: 'cadence', matchKey: 'visit', dueDay: 180 },
      ])
      .at(179)
      .runWatcher()
      .expectNoCases()
      .at(181)
      .runWatcher()
      .expectCases([{ reasons: ['cadence_break'] }])
      .run();
  });

  it('a single visit never builds a cadence', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'enc-1', specialty: 'psychology' })
      .expectOpenExpectations([])
      .run();
  });

  it('7-day treatment without follow-up: expectation at day 10, then a case', async () => {
    await scenario()
      .at(0)
      .consult({
        encounterId: 'enc-1',
        medications: [{ id: 'mr-1', text: 'amoxicilina 500 mg c/8h', durationDays: 7 }],
      })
      .expectOpenExpectations([
        { ruleId: 'short_treatment_followup', matchKey: 'visit', dueDay: 10 },
      ])
      .at(9.5)
      .runWatcher()
      .expectNoCases()
      .at(10)
      .runWatcher()
      .expectCases([{ reasons: ['short_treatment_followup'] }])
      .run();
  });

  describe('gynecology "control en 6 semanas" postpartum', () => {
    const note = {
      id: 'doc-pp',
      text: 'Puerperio de 2 semanas sin complicaciones. Lactancia exclusiva. Control en 6 semanas.',
    };

    it('opens a case at 6 weeks when nothing was booked', async () => {
      await scenario()
        .at(0)
        .consult({ encounterId: 'enc-1', specialty: 'gynecology', note })
        .expectOpenExpectations([{ ruleId: 'doctor_plan_followup', dueDay: 42 }])
        .at(43)
        .runWatcher()
        .expectCases([{ reasons: ['doctor_plan_followup'] }])
        .run();
    });

    it('a booking fulfills it before the deadline', async () => {
      await scenario()
        .at(0)
        .consult({ encounterId: 'enc-1', specialty: 'gynecology', note })
        .at(20)
        .ingest((world) => [
          {
            type: 'appointment.booked',
            clinicId: world.clinicId,
            patientId: world.patientId,
            source: { resourceType: 'Appointment', id: 'apt-1' },
            occurredAt: world.clock.now(),
            idempotencyKey: 'Appointment/apt-1/1#appointment.booked',
            scheduledFor: world.dayAt(41),
            specialty: 'gynecology',
          },
        ])
        .expectOpenExpectations([])
        // Past the 6-week deadline: the booking (day 41) still stands until
        // its grace days end without a visit.
        .at(42)
        .runWatcher()
        .expectNoCases()
        .run();
    });

    it('a booking after the case opened resolves it', async () => {
      await scenario()
        .at(0)
        .consult({ encounterId: 'enc-1', specialty: 'gynecology', note })
        .at(43)
        .runWatcher()
        .expectCases([{ reasons: ['doctor_plan_followup'] }])
        .at(45)
        .ingest((world) => [
          {
            type: 'appointment.booked',
            clinicId: world.clinicId,
            patientId: world.patientId,
            source: { resourceType: 'Appointment', id: 'apt-1' },
            occurredAt: world.clock.now(),
            idempotencyKey: 'Appointment/apt-1/1#appointment.booked',
            scheduledFor: world.dayAt(50),
          },
        ])
        .expectNoCases()
        .expectOutbox({ 'case.opened': 1, 'case.resolved': 1 })
        .check(async (world) => {
          const [resolved] = await world.cases();
          expect(resolved?.resolution?.kind).toBe('fulfilled');
          const audit = await world.audit(defined(resolved).id);
          expect(audit.at(-1)).toMatchObject({
            type: 'resolved',
            actor: { type: 'rule', id: 'doctor_plan_followup' },
          });
        })
        .run();
    });
  });

  it('three layers firing for the same patient and reason merge into one case with three reasons', async () => {
    // The plan asks for a lab, not a visit: it does not cover the visit pattern.
    const extractor = new FakeNoteExtractor().setExtraction('doc-60', {
      planItems: [
        {
          kind: 'lab',
          description: 'repeat HbA1c',
          dueAt: new Date(SCENARIO_BASE_DATE.getTime() + 120 * 86_400_000),
          evidenceQuote: 'HbA1c en 2 meses',
          confidence: 0.9,
          code: CODES.hba1c,
        },
      ],
    });
    await scenario({ extractor })
      .at(0)
      .consult({ encounterId: 'enc-0' })
      .at(30)
      .consult({ encounterId: 'enc-30' })
      .at(60)
      .consult({
        encounterId: 'enc-60',
        results: [{ id: 'obs-glu', code: CODES.glucose, interpretation: 'abnormal' }],
        note: { id: 'doc-60', text: 'Glucemia alterada. HbA1c en 2 meses.' },
      })
      .expectOpenExpectations([
        { ruleId: 'abnormal_result_followup', layer: 'universal', dueDay: 67 },
        { ruleId: 'doctor_plan_followup', layer: 'doctor_plan', dueDay: 120 },
        { ruleId: 'cadence_break', layer: 'cadence', dueDay: 150 },
      ])
      .at(68)
      .runWatcher()
      .at(121)
      .runWatcher()
      .at(151)
      .runWatcher()
      .expectCases([
        { reasons: ['abnormal_result_followup', 'doctor_plan_followup', 'cadence_break'] },
      ])
      .check(async (world) => {
        const [merged] = await world.activeCases();
        const audit = await world.audit(defined(merged).id);
        expect(audit.map((event) => event.type)).toEqual([
          'opened',
          'reason_added',
          'reason_added',
        ]);
        expect(new Set(world.expectations().map((expectation) => expectation.layer))).toEqual(
          new Set(['universal', 'doctor_plan', 'cadence']),
        );
      })
      .run();
  });

  it('a note that discharges the patient ends the visit pattern (no cadence after it)', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'psy-0', specialty: 'psychology' })
      .at(14)
      .consult({ encounterId: 'psy-14', specialty: 'psychology' })
      .expectOpenExpectations([{ ruleId: 'cadence_break', dueDay: 56 }])
      .at(28)
      .consult({
        encounterId: 'psy-28',
        specialty: 'psychology',
        note: { id: 'doc-28', text: 'Se revisan logros del proceso. Se da de alta.' },
      })
      .expectOpenExpectations([])
      .at(120)
      .runWatcher()
      .expectNoCases()
      .run();
  });

  it('a visit in the doctor’s plan beats the cadence layer for the next visit', async () => {
    await scenario()
      .at(0)
      .consult({ encounterId: 'enc-0' })
      .at(30)
      .consult({
        encounterId: 'enc-30',
        note: { id: 'doc-30', text: 'Paciente estable. Control en 2 meses.' },
      })
      .expectOpenExpectations([
        { ruleId: 'doctor_plan_followup', layer: 'doctor_plan', dueDay: 90 },
      ])
      .at(60)
      .consult({ encounterId: 'enc-60' })
      // The planned visit happened: the plan is fulfilled, so the pattern applies again.
      .expectOpenExpectations([{ ruleId: 'cadence_break', layer: 'cadence', dueDay: 150 }])
      .run();
  });

  it('re-ingesting the same batch creates no duplicates and does not call the extractor again', async () => {
    const world = await scenario()
      .at(0)
      .consult({
        encounterId: 'enc-1',
        labs: [{ id: 'sr-1', code: CODES.hba1c }],
        medications: [{ id: 'mr-1', text: 'amoxicilina', durationDays: 7 }],
        note: { id: 'doc-1', text: 'Faringitis. Control en 2 semanas.' },
      })
      .consult({
        encounterId: 'enc-1',
        labs: [{ id: 'sr-1', code: CODES.hba1c }],
        medications: [{ id: 'mr-1', text: 'amoxicilina', durationDays: 7 }],
        note: { id: 'doc-1', text: 'Faringitis. Control en 2 semanas.' },
      })
      .check(({ lastIngest }) => {
        expect(lastIngest?.eventsInserted).toBe(0);
        expect(lastIngest?.expectationsCreated).toEqual([]);
        expect(lastIngest?.notes).toEqual([{ documentId: 'doc-1', status: 'already_extracted' }]);
      })
      .at(30)
      .runWatcher()
      .runWatcher()
      .run();

    expect(world.harness.extractor.calls).toHaveLength(1);
    expect(world.expectations()).toHaveLength(3);
    expect(await world.cases()).toHaveLength(2);
  });
});
