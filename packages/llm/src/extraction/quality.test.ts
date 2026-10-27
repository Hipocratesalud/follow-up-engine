import { clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { isStrictCompatible, toJsonSchema } from '../json-schema.ts';
import { createFakeProvider, FAKE_DEFAULT_MODEL, type FakeResponder } from '../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { heuristicExtraction, heuristicResponder } from './heuristic-baseline.ts';
import { createNoteExtractor } from './note-extractor.ts';
import { postProcessExtraction } from './post-process.ts';
import {
  NOTE_EXTRACTION_PROMPT_VERSION,
  NOTE_EXTRACTION_SYSTEM_PROMPT,
  NOTE_EXTRACTION_TASK,
} from './prompt.ts';
import { ModelExtractionSchema, type ModelExtraction, type ModelPlanItem } from './schema.ts';

/*
 * HIP-122: extraction quality in the default pipeline (fue-qa round 1:
 * clinical #3, #13; inbox #11). The default demo runs the heuristic reader
 * behind the fake provider, through the real gateway and post-checks.
 */

const CLINIC = clinicId('clinic-demo');
const AUTHORED = new Date('2026-01-05T12:00:00Z');

function extractorWith(respond: FakeResponder) {
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond }) },
    tasks: { [NOTE_EXTRACTION_TASK]: { route: [{ provider: 'fake', model: FAKE_DEFAULT_MODEL }] } },
    usageLog: new InMemoryLlmUsageLog(),
  });
  return createNoteExtractor({ gateway });
}

const read = (text: string) =>
  extractorWith(heuristicResponder).extract(CLINIC, {
    documentId: 'doc',
    text,
    authoredAt: AUTHORED,
  });

const empty: ModelExtraction = {
  hasPlan: false,
  discharge: null,
  conditions: [],
  medications: [],
  planItems: [],
};

const plan = (overrides: Partial<ModelPlanItem>): ModelPlanItem => ({
  kind: 'follow_up_visit',
  description: 'follow-up visit',
  timing: { amount: 1, unit: 'week', date: null },
  loincCode: null,
  evidenceQuote: 'Ctrl en 1 semana',
  confidence: 0.9,
  ...overrides,
});

describe('discharge ("se da de alta") is read by the real extraction path (clinical #3)', () => {
  it('is part of the model schema and of a new prompt version', () => {
    expect(NOTE_EXTRACTION_PROMPT_VERSION).toBe('note-extraction@2');
    expect(Object.keys(ModelExtractionSchema.shape)).toContain('discharge');
    expect(isStrictCompatible(toJsonSchema(ModelExtractionSchema))).toBe(true);
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toContain('se da de alta');
  });

  it.each([
    'Sesion 3. Se revisan logros del proceso. Se da de alta, puede solicitar cita si lo requiere.',
    'Pcte acude a control post tto por ITU baja. Completó tratamiento. Asintomática. Se da de alta.',
    'Sesión 12. Se da de alta del proceso.',
  ])('the default (heuristic) pipeline marks %j as discharged', async (note) => {
    const result = await read(note);
    expect(result.discharged).toBe(true);
    expect(result.dischargeEvidenceQuote).toMatch(/se da de alta/i);
    expect(result.hasPlan).toBe(true);
  });

  it.each([
    'Cuadro de IRA alta de 3 dias. Ctrl en 1 semana.',
    'Refiere presion alta en casa. Control en 1 mes.',
    'Aun no se da de alta: continuar sesiones. Proxima sesion en 2 semanas.',
  ])('does not mistake %j for a discharge', async (note) => {
    expect((await read(note)).discharged).toBeUndefined();
  });

  it('accepts a model discharge only when its quote states one', () => {
    const note = {
      text: 'Paciente estable. Se da de alta. Ctrl si lo requiere.',
      authoredAt: AUTHORED,
    };
    const ok = postProcessExtraction(
      { ...empty, discharge: { evidenceQuote: 'Se da de alta' } },
      note,
    );
    expect(ok.discharged).toBe(true);
    const unrelated = postProcessExtraction(
      { ...empty, discharge: { evidenceQuote: 'Paciente estable' } },
      note,
    );
    expect(unrelated.discharged).toBe(false);
    expect(unrelated.rejected).toEqual([
      { field: 'discharge', reason: 'quote_unrelated', evidenceQuote: 'Paciente estable' },
    ]);
  });
});

describe('negated conditions are not extracted (clinical #13)', () => {
  it('the heuristic reader skips "niega HTA y diabetes"', async () => {
    const result = await read(
      'Antecedentes: niega HTA y diabetes. Consulta por esguince de tobillo. Ctrl en 10 dias.',
    );
    expect(result.conditions).toEqual([]);
  });

  it.each([
    ['sin antecedentes de HTA. DM2 en tto.', ['E11']],
    ['Descarta diabetes. HTA controlada.', ['I10']],
    ['Niega diabetes. HTA de larga data.', ['I10']],
    ['Niega HTA, diabetes y asma. Consulta por lumbalgia.', ['M54']],
    ['DM2 sin complicaciones, HTA.', ['E11', 'I10']],
  ])('%j -> %j', (note, codes) => {
    expect(heuristicExtraction(note).conditions.map((c) => c.icd10)).toEqual(codes);
  });

  it('the post-checks drop a negated condition from any model', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        conditions: [
          { icd10: 'I10', display: 'hypertension', confidence: 0.9, evidenceQuote: 'HTA' },
          { icd10: 'E11', display: 'diabetes', confidence: 0.9, evidenceQuote: 'diabetes' },
        ],
      },
      { text: 'Antecedentes: niega HTA y diabetes. Esguince de tobillo.', authoredAt: AUTHORED },
    );
    expect(result.conditions).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual(['negated', 'negated']);
  });
});

describe('lab values are never medications (inbox #11)', () => {
  const GYN =
    'Paciente de 44 años, G2P2, consulta por sangrado menstrual abundante en los últimos 4 meses. ' +
    'Al examen, útero aumentado de tamaño, irregular. Ecografía con mioma intramural de 4 cm. ' +
    'Hemoglobina 10,8 g/dL.';

  it('the demo "Ginecología sin plan" note lists no medication', async () => {
    expect((await read(GYN)).medications).toEqual([]);
  });

  it('the post-checks drop a measurement a model lists as a medication', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        medications: [
          { text: 'Hemoglobina 10,8 g/dL', duration: null, evidenceQuote: 'Hemoglobina 10,8 g/dL' },
        ],
      },
      { text: GYN, authoredAt: AUTHORED },
    );
    expect(result.medications).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('not_a_medication');
  });

  it('keeps real drugs, including as-needed ones', async () => {
    const result = await read(
      'DM2. Metformina 850 mg c/12h. Paracetamol 500 mg c/8h si dolor. Glicemia 126 mg/dl. Ctrl en 3 meses.',
    );
    expect(result.medications.map((m) => m.text)).toEqual([
      'Metformina 850 mg c/12h',
      'Paracetamol 500 mg c/8h si dolor',
    ]);
  });
});

describe('conditional returns are not scheduled follow-up', () => {
  it.each([
    'Ctrl en 1 semana solo si persisten los sintomas.',
    'Volver en caso de fiebre en 2 dias.',
  ])('%j creates no plan item', async (note) => {
    expect((await read(`Faringitis aguda. ${note}`)).planItems).toEqual([]);
  });

  it('a scheduled control with an early-return clause stays', async () => {
    const result = await read('HTA. Control en 1 mes o antes si empeora.');
    expect(result.planItems.map((p) => p.evidenceQuote)).toEqual(['Control en 1 mes']);
  });

  it('the post-checks drop a conditional item from any model', () => {
    const result = postProcessExtraction(
      { ...empty, planItems: [plan({})] },
      { text: 'Plan: Ctrl en 1 semana solo si persisten los sintomas.', authoredAt: AUTHORED },
    );
    expect(result.planItems).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('conditional');
  });
});
