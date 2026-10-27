import { clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { isStrictCompatible, toJsonSchema } from '../json-schema.ts';
import { createFakeProvider, FAKE_DEFAULT_MODEL } from '../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { DEFAULT_CONDITION_TERMS } from './condition-terms.ts';
import { modelOutputFromExpected, modelOutputFromExtraction } from './fixtures.ts';
import { heuristicExtraction, heuristicResponder } from './heuristic-baseline.ts';
import { createNoteExtractor } from './note-extractor.ts';
import { postProcessExtraction } from './post-process.ts';
import { gestationalAges, outcomeMentions, statesCurrentPregnancy } from './pregnancy-signals.ts';
import { NOTE_EXTRACTION_PROMPT_VERSION, NOTE_EXTRACTION_SYSTEM_PROMPT } from './prompt.ts';
import { normalizeForMatch } from './quote.ts';
import {
  ModelExtractionSchema,
  type ModelCondition,
  type ModelExtraction,
  type ModelPregnancy,
  type ModelPregnancyOutcome,
} from './schema.ts';

/*
 * HIP-137: the pregnancy reading of a note. Dating ("embarazo de 20
 * semanas", "FUM 03/04/2026", "FPP 10/01/2027") and outcome ("parto vaginal
 * el 02/03/2026", "cesárea hace 10 días", "aborto espontáneo") end up as
 * Observations and a provisional diagnosis that ends the pregnancy episode,
 * so false positives matter most: obstetric history and a routine FUM must
 * never read as a current pregnancy or its outcome.
 */

const NOTE_DAY = '2026-08-24';
const AUTHORED = new Date(`${NOTE_DAY}T12:00:00Z`);
const day = (date: Date | undefined): string | undefined => date?.toISOString().slice(0, 10);

const empty: ModelExtraction = {
  hasPlan: true,
  discharge: null,
  pregnancy: null,
  conditions: [],
  medications: [],
  planItems: [],
};

const noDating = {
  gestationalWeeks: null,
  gestationalDays: null,
  lastMenstrualPeriod: null,
  estimatedDeliveryDate: null,
  datingEvidenceQuote: null,
};

const outcome = (overrides: Partial<ModelPregnancyOutcome>): ModelPregnancy => ({
  ...noDating,
  outcome: {
    kind: 'vaginal_delivery',
    date: null,
    daysAgo: null,
    evidenceQuote: 'parto eutócico',
    ...overrides,
  },
});

const dating = (overrides: Partial<ModelPregnancy>): ModelPregnancy => ({
  ...noDating,
  outcome: null,
  ...overrides,
});

function check(text: string, pregnancy: ModelPregnancy, authoredAt = AUTHORED) {
  return postProcessExtraction({ ...empty, pregnancy }, { text, authoredAt });
}

/** The heuristic reader through the real gateway and post-checks (the demo pipeline). */
async function read(text: string, authoredAt = AUTHORED) {
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond: heuristicResponder }) },
    tasks: { note_extraction: { route: [{ provider: 'fake', model: FAKE_DEFAULT_MODEL }] } },
    usageLog: new InMemoryLlmUsageLog(),
  });
  return createNoteExtractor({ gateway }).extract(clinicId('clinic-pregnancy'), {
    documentId: 'doc',
    text,
    authoredAt,
  });
}

describe('model schema and prompt', () => {
  it('asks for the pregnancy in a new, strict-compatible prompt version', () => {
    expect(NOTE_EXTRACTION_PROMPT_VERSION).toBe('note-extraction@4');
    expect(Object.keys(ModelExtractionSchema.shape)).toContain('pregnancy');
    expect(isStrictCompatible(toJsonSchema(ModelExtractionSchema))).toBe(true);
    const schema = JSON.stringify(toJsonSchema(ModelExtractionSchema));
    for (const key of [
      'gestationalWeeks',
      'gestationalDays',
      'lastMenstrualPeriod',
      'estimatedDeliveryDate',
      'datingEvidenceQuote',
      'daysAgo',
    ]) {
      expect(schema).toContain(key);
    }
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toContain('G2P1');
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toContain('cesarea previa');
    expect(NOTE_EXTRACTION_SYSTEM_PROMPT).toMatch(/Never compute weeks from dates/);
  });

  it('rejects a reply without the pregnancy key (strict output)', () => {
    const withoutPregnancy: Partial<ModelExtraction> = { ...empty };
    delete withoutPregnancy.pregnancy;
    expect(ModelExtractionSchema.safeParse(withoutPregnancy).success).toBe(false);
    expect(ModelExtractionSchema.safeParse(empty).success).toBe(true);
  });
});

describe('heuristic baseline reads Spanish pregnancy notes', () => {
  it.each([
    [
      'Primigesta de 26a cursando embarazo de 20 semanas. Asintomática.',
      20,
      undefined,
      'embarazo de 20 semanas',
    ],
    [
      'Pcte cursando embarazo de 20 semanas y 3 días, asintomática.',
      20,
      3,
      'embarazo de 20 semanas y 3 días',
    ],
    ['Embarazo en curso, 20 sem. Movimientos fetales presentes.', 20, undefined, '20 sem'],
    ['Pcte 29a, G2P1, 20 sem. Asintomática.', 20, undefined, '20 sem'],
    ['Embarazada, EG 20 sem por eco del primer trimestre.', 20, undefined, 'EG 20 sem'],
    ['Control prenatal. EG: 20+3. TA 110/70.', 20, 3, 'EG: 20+3'],
    [
      'pcte g2p1 de 30a cursando embarazo de 34 sem por FUM. Sin edemas.',
      34,
      undefined,
      'embarazo de 34 sem',
    ],
  ])('dates %j', async (text, weeks, days, quote) => {
    const { pregnancy } = await read(text);
    expect(pregnancy?.gestationalWeeks).toBe(weeks);
    expect(pregnancy?.gestationalDays).toBe(days);
    expect(pregnancy?.datingEvidenceQuote).toBe(quote);
    expect(pregnancy?.outcome).toBeUndefined();
  });

  it('reads FUM and FPP as written (dd/mm/yyyy), year inferred when missing', async () => {
    const { pregnancy } = await read(
      'Pcte 31a, G2P1. Embarazo en curso. FUM 03/04/2026, FPP 08/01/2027. Asintomática.',
    );
    expect(day(pregnancy?.lastMenstrualPeriod)).toBe('2026-04-03');
    expect(day(pregnancy?.estimatedDeliveryDate)).toBe('2027-01-08');
    expect(pregnancy?.datingEvidenceQuote).toBe('FUM 03/04/2026');
    const short = await read('Embarazo de 8 semanas. FUM: 3/4. FPP por eco: 8/1.');
    expect(day(short.pregnancy?.lastMenstrualPeriod)).toBe('2026-04-03');
    expect(day(short.pregnancy?.estimatedDeliveryDate)).toBe('2027-01-08');
  });

  it('keeps FUM and FPP dates out of the plan', async () => {
    const result = await read(
      'Embarazo de 20 sem. FUM 03/04/2026, FPP 08/01/2027.\nPlan: control en 4 semanas.',
    );
    expect(result.planItems.map((item) => item.kind)).toEqual(['follow_up_visit']);
    expect(result.planItems[0]?.evidenceQuote).toBe('control en 4 semanas');
  });

  it.each([
    [
      'Parto vaginal el 02/03/2026, sin complicaciones.',
      'vaginal_delivery',
      '2026-03-02',
      'Parto vaginal',
    ],
    [
      'Puérpera de 10 días, parto eutócico sin complicaciones.',
      'vaginal_delivery',
      '2026-08-14',
      'Puérpera de 10 días, parto eutócico',
    ],
    [
      'puerpera de 10 dias, cesarea segmentaria sin complicaciones.',
      'cesarean_delivery',
      '2026-08-14',
      'puerpera de 10 dias, cesarea segmentaria',
    ],
    [
      'Pcte 33a, G2P2, cesárea segmentaria hace 10 días por presentación podálica.',
      'cesarean_delivery',
      '2026-08-14',
      'cesárea segmentaria',
    ],
    [
      'Cesárea el 17/08/2026 por cesárea anterior, sin complicaciones.',
      'cesarean_delivery',
      '2026-08-17',
      'Cesárea',
    ],
    ['Puerperio de 12 días. Parto eutócico.', 'vaginal_delivery', undefined, 'Parto eutócico'],
    [
      'Aborto espontáneo hace 5 días, expulsión completa.',
      'loss',
      '2026-08-19',
      'Aborto espontáneo',
    ],
    [
      'Pcte de 30a, G2P1, control a las 2 semanas de aborto espontáneo completo.',
      'loss',
      '2026-08-10',
      'aborto espontáneo completo',
    ],
    ['Dx: pérdida gestacional temprana.', 'loss', undefined, 'pérdida gestacional'],
    ['Embarazo ectópico roto, operada hace 3 días.', 'loss', '2026-08-21', 'Embarazo ectópico'],
  ])('reads the outcome of %j', async (text, kind, date, quote) => {
    const { pregnancy } = await read(text);
    expect(pregnancy?.outcome?.kind).toBe(kind);
    expect(day(pregnancy?.outcome?.date)).toBe(date);
    expect(pregnancy?.outcome?.evidenceQuote).toBe(quote);
    expect(pregnancy?.gestationalWeeks).toBeUndefined();
  });

  it('does not date a pregnancy the note ends', async () => {
    const { pregnancy } = await read(
      'G2P1 de 30 años con embarazo de 8 semanas por FUM, consulta por sangrado.\nDx: aborto espontáneo completo.',
    );
    expect(pregnancy).toEqual({
      outcome: { kind: 'loss', evidenceQuote: 'aborto espontáneo completo' },
    });
  });

  it.each([
    // Routine FUM: not a pregnancy.
    'Pcte 44a, G2P2, FUM 10/01/2026. Acude a control ginecológico anual. Asintomática.',
    'Pcte 36a, FUM: 30/07/2026, ciclos regulares. Método anticonceptivo: DIU de cobre.',
    'Prueba de embarazo negativa. FUM 01/08/2026.',
    'Pcte con dolor pélvico de 2 semanas. FUM 01/08/2026.',
    'Desea embarazo, se indica ácido fólico. FUM 01/08/2026.',
    'Niega embarazo. FUM 01/08/2026.',
    // Obstetric history: never an outcome.
    'Pcte 38a, G3P2, cesárea previa hace 3 años. Consulta por dismenorrea.',
    'Antecedente de cesárea. Parto anterior en 2019.',
    'AGO: G3P2C1, cesárea en 2021, parto eutócico en 2018.',
    'Pcte con 2 partos vaginales y 1 cesárea.',
    'Antecedente de aborto espontáneo. Ciclos regulares.',
    'Cesárea hace 3 años, sin complicaciones. Consulta por flujo.',
    'Su último parto fue vaginal. Consulta por flujo.',
    'Diabetes gestacional en embarazo previo. Control ginecológico de rutina.',
  ])('reads no pregnancy in %j', async (text) => {
    const { pregnancy } = await read(text);
    expect(pregnancy).toBeUndefined();
  });

  it.each([
    'Amenaza de aborto en embarazo de 8 sem. Reposo.',
    'Embarazo de 34 sem. Cesárea programada para el 10/10/2026.',
    'Embarazo de 34 sem. Se conversa sobre vía del parto.',
    'Embarazo de 34 sem. Control posparto con anticoncepción.',
    'Pcte 32a, G3P2, cesárea previa hace 3 años y parto vaginal anterior. Cursando embarazo de 34 semanas.',
    'Embarazo de 34 sem con placenta previa. Reposo.',
  ])('dates the ongoing pregnancy of %j without an outcome', async (text) => {
    const { pregnancy } = await read(text);
    expect(pregnancy?.outcome).toBeUndefined();
    expect(pregnancy?.gestationalWeeks).toBe(Number(/(\d+) se/.exec(text)?.[1]));
  });

  it('reads no gestational age from an interval, a target age or a duration', () => {
    const ages = (text: string) => gestationalAges(normalizeForMatch(text)).map((a) => a.weeks);
    expect(
      ages('Embarazo de 12 sem. Eco morfológico a las 20 semanas. Ctrl en 4 semanas.'),
    ).toEqual([12]);
    expect(ages('Embarazo de 20 sem con dolor pélvico de 2 semanas de evolución.')).toEqual([20]);
    expect(ages('Pcte con tos de 2 semanas.')).toEqual([]);
    expect(ages('Embarazo previo de 38 semanas sin complicaciones.')).toEqual([]);
    expect(ages('Puérpera de 6 semanas postparto.')).toEqual([]);
  });

  it('tells a current pregnancy from a wish, a test or a past one', () => {
    const current = (text: string) => statesCurrentPregnancy(normalizeForMatch(text));
    expect(current('Acude por amenorrea y prueba de embarazo en orina positiva.')).toBe(true);
    expect(current('Prueba de embarazo en orina negativa.')).toBe(false);
    expect(current('Si desea nuevo embarazo, iniciar ácido fólico.')).toBe(false);
    expect(current('Embarazo ectópico roto.')).toBe(false);
    expect(current('Diabetes gestacional en embarazo previo.')).toBe(false);
    expect(current('Control prenatal.')).toBe(true);
  });

  it('names why each delivery or loss word is not an outcome', () => {
    const reasons = (text: string) =>
      outcomeMentions(normalizeForMatch(text), 2026).map(
        (m) => m.excluded ?? m.kind ?? 'puerperium',
      );
    expect(reasons('G3P2, cesárea previa. Amenaza de aborto. Sin aborto. Parto eutócico.')).toEqual(
      ['not_current', 'quote_unrelated', 'negated', 'vaginal_delivery'],
    );
    expect(reasons('Parto vaginal en 2019. Puérpera.')).toEqual(['not_current', 'puerperium']);
  });
});

describe('postProcessExtraction checks a model pregnancy reading', () => {
  const postpartum =
    'Pcte 33a, G2P2. Puérpera de 10 días, cesárea segmentaria por presentación podálica. Herida limpia.';

  it('keeps a grounded outcome, decides its kind from the quote and dates "hace N días" in code', () => {
    const result = check(
      postpartum,
      outcome({
        kind: 'vaginal_delivery',
        daysAgo: 10,
        evidenceQuote: 'Puérpera de 10 días, cesárea segmentaria',
      }),
    );
    expect(result.pregnancy).toEqual({
      outcome: {
        kind: 'cesarean_delivery',
        date: new Date('2026-08-14T12:00:00Z'),
        evidenceQuote: 'Puérpera de 10 días, cesárea segmentaria',
      },
    });
    expect(result.rejected).toEqual([]);
    expect(result.modelItemCount).toBe(1);
  });

  it('accepts a puerperium word for a delivery of the model kind, never for a loss', () => {
    const delivery = check(
      postpartum,
      outcome({ kind: 'vaginal_delivery', evidenceQuote: 'Puérpera de 10 días' }),
    );
    expect(delivery.pregnancy?.outcome?.kind).toBe('vaginal_delivery');
    const loss = check(postpartum, outcome({ kind: 'loss', evidenceQuote: 'Puérpera de 10 días' }));
    expect(loss.pregnancy).toBeUndefined();
    expect(loss.rejected).toEqual([
      { field: 'pregnancy', reason: 'quote_unrelated', evidenceQuote: 'Puérpera de 10 días' },
    ]);
  });

  it.each([
    ['G2P2', 'not_current', postpartum],
    ['G2P2. Puérpera de 10 días, cesárea', 'not_current', postpartum],
    ['cesárea previa', 'not_current', 'Pcte G3P2, cesárea previa hace 3 años. Embarazo de 20 sem.'],
    [
      'cesárea hace 3 años',
      'not_current',
      'Antecedentes: cesárea hace 3 años. Consulta por flujo.',
    ],
    [
      'parto vaginal en 2019',
      'not_current',
      'Antecedentes: parto vaginal en 2019. Consulta por flujo.',
    ],
    ['antecedente de aborto', 'not_current', 'Pcte con antecedente de aborto. Consulta por flujo.'],
    ['aborto', 'negated', 'Pcte sin aborto ni cesárea. Consulta por flujo.'],
    ['Amenaza de aborto', 'quote_unrelated', 'Amenaza de aborto en embarazo de 8 sem.'],
    [
      'Cesárea programada',
      'quote_unrelated',
      'Embarazo de 38 sem. Cesárea programada para mañana.',
    ],
    ['vía del parto', 'quote_unrelated', 'Embarazo de 34 sem. Se conversa sobre vía del parto.'],
    [
      'Control posparto',
      'quote_unrelated',
      'Embarazo de 34 sem. Control posparto con anticoncepción.',
    ],
    ['Herida limpia', 'quote_unrelated', postpartum],
    ['parto en casa', 'quote_not_found', postpartum],
  ])('rejects the outcome quoted as %j (%s)', (quote, reason, text) => {
    const result = check(text, outcome({ evidenceQuote: quote }));
    expect(result.pregnancy?.outcome).toBeUndefined();
    expect(result.rejected).toEqual([{ field: 'pregnancy', reason, evidenceQuote: quote }]);
  });

  it('drops a date or elapsed time the note does not write, and keeps the outcome', () => {
    const text = 'Puérpera, parto vaginal sin complicaciones.';
    const unwritten = check(text, outcome({ date: '2026-08-10', evidenceQuote: 'parto vaginal' }));
    expect(unwritten.pregnancy).toEqual({
      outcome: { kind: 'vaginal_delivery', evidenceQuote: 'parto vaginal' },
    });
    expect(unwritten.rejected).toEqual([
      { field: 'pregnancy', reason: 'timing_unsupported', evidenceQuote: 'parto vaginal' },
    ]);
    const ago = check(text, outcome({ daysAgo: 12, evidenceQuote: 'parto vaginal' }));
    expect(ago.pregnancy?.outcome?.date).toBeUndefined();
    expect(ago.rejected.map((r) => r.reason)).toEqual(['timing_unsupported']);
  });

  it('falls back from an unwritten date to the elapsed time the clause states', () => {
    const result = check(
      'Cesárea segmentaria hace 2 semanas.',
      outcome({
        kind: 'cesarean_delivery',
        date: '2026-08-01',
        daysAgo: 14,
        evidenceQuote: 'Cesárea segmentaria',
      }),
    );
    expect(day(result.pregnancy?.outcome?.date)).toBe('2026-08-10');
    expect(result.rejected).toEqual([]);
  });

  it('rejects an outcome dated after the note or more than 300 days before it', () => {
    const future = check(
      'Parto vaginal el 30/08/2026.',
      outcome({ date: '2026-08-30', evidenceQuote: 'Parto vaginal el 30/08/2026' }),
    );
    expect(future.pregnancy).toBeUndefined();
    expect(future.rejected.map((r) => r.reason)).toEqual(['out_of_range']);
    const old = check(
      'Parto vaginal el 02/01/2025.',
      outcome({ date: '2025-01-02', evidenceQuote: 'Parto vaginal el 02/01/2025' }),
    );
    expect(old.pregnancy).toBeUndefined();
    expect(old.rejected.map((r) => r.reason)).toEqual(['out_of_range']);
  });

  const prenatal =
    'Pcte G2P1, cursando embarazo de 20 semanas y 3 días. FUM 03/04/2026. FPP 08/01/2027. Placenta anterior.';

  it('keeps dating written in the note and in range', () => {
    const result = check(
      prenatal,
      dating({
        gestationalWeeks: 20,
        gestationalDays: 3,
        lastMenstrualPeriod: '2026-04-03',
        estimatedDeliveryDate: '2027-01-08',
        datingEvidenceQuote: 'embarazo de 20 semanas y 3 días',
      }),
    );
    expect(result.pregnancy).toEqual({
      gestationalWeeks: 20,
      gestationalDays: 3,
      lastMenstrualPeriod: new Date('2026-04-03T12:00:00Z'),
      estimatedDeliveryDate: new Date('2027-01-08T12:00:00Z'),
      datingEvidenceQuote: 'embarazo de 20 semanas y 3 días',
    });
    expect(result.rejected).toEqual([]);
  });

  it('drops each dating value the note does not write, or that is out of range', () => {
    const result = check(
      prenatal,
      dating({
        gestationalWeeks: 21,
        lastMenstrualPeriod: '2026-04-02',
        estimatedDeliveryDate: '2027-01-08',
        datingEvidenceQuote: 'FPP 08/01/2027',
      }),
    );
    expect(result.pregnancy).toEqual({
      estimatedDeliveryDate: new Date('2027-01-08T12:00:00Z'),
      datingEvidenceQuote: 'FPP 08/01/2027',
    });
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'timing_unsupported',
      'timing_unsupported',
    ]);
    const range = check(
      prenatal,
      dating({
        gestationalWeeks: 50,
        gestationalDays: 3,
        lastMenstrualPeriod: '2026-09-01',
        estimatedDeliveryDate: '2028-01-08',
        datingEvidenceQuote: 'embarazo de 20 semanas',
      }),
    );
    expect(range.pregnancy).toBeUndefined();
    expect(range.rejected.map((r) => r.reason)).toEqual([
      'out_of_range',
      'out_of_range',
      'out_of_range',
    ]);
  });

  it('drops days that do not go with the written weeks', () => {
    const result = check(
      'Embarazo de 20 semanas.',
      dating({
        gestationalWeeks: 20,
        gestationalDays: 4,
        datingEvidenceQuote: 'Embarazo de 20 semanas',
      }),
    );
    expect(result.pregnancy).toEqual({
      gestationalWeeks: 20,
      datingEvidenceQuote: 'Embarazo de 20 semanas',
    });
    expect(result.rejected.map((r) => r.reason)).toEqual(['timing_unsupported']);
  });

  it('does not date a note that states no current pregnancy (routine FUM)', () => {
    const text = 'Pcte 44a, G2P2, FUM 10/08/2026. Acude a control ginecológico anual.';
    const result = check(
      text,
      dating({ lastMenstrualPeriod: '2026-08-10', datingEvidenceQuote: 'FUM 10/08/2026' }),
    );
    expect(result.pregnancy).toBeUndefined();
    expect(result.rejected).toEqual([
      { field: 'pregnancy', reason: 'not_current', evidenceQuote: 'FUM 10/08/2026' },
    ]);
  });

  it('does not date a pregnancy that the same note ends', () => {
    const text = 'Embarazo de 8 semanas por FUM. Dx: aborto espontáneo completo.';
    const result = check(text, {
      ...dating({ gestationalWeeks: 8, datingEvidenceQuote: 'Embarazo de 8 semanas' }),
      outcome: {
        kind: 'loss',
        date: null,
        daysAgo: null,
        evidenceQuote: 'aborto espontáneo completo',
      },
    });
    expect(result.pregnancy).toEqual({
      outcome: { kind: 'loss', evidenceQuote: 'aborto espontáneo completo' },
    });
    expect(result.rejected.map((r) => r.reason)).toEqual(['not_current']);
    expect(result.modelItemCount).toBe(2);
  });

  it('rejects a dating quote that is missing, invented or says nothing about dating', () => {
    const missing = check(prenatal, dating({ gestationalWeeks: 20 }));
    expect(missing.rejected.map((r) => r.reason)).toEqual(['quote_not_found']);
    const invented = check(
      prenatal,
      dating({ gestationalWeeks: 20, datingEvidenceQuote: 'EG 20 sem' }),
    );
    expect(invented.rejected.map((r) => r.reason)).toEqual(['quote_not_found']);
    const unrelated = check(
      prenatal,
      dating({ gestationalWeeks: 20, datingEvidenceQuote: 'Placenta anterior' }),
    );
    expect(unrelated.rejected.map((r) => r.reason)).toEqual(['quote_unrelated']);
  });
});

describe('obstetric conditions', () => {
  const condition = (icd10: string, evidenceQuote: string): ModelCondition => ({
    icd10,
    display: '',
    confidence: 0.9,
    evidenceQuote,
  });

  it('backs the categories the protocols rely on with Spanish terms', () => {
    for (const code of [
      'Z33',
      'Z34',
      'Z35',
      'Z39',
      'O80',
      'O82',
      'O03',
      'F32',
      'F33',
      'F41',
      'E03',
      'E78',
      'N18',
    ]) {
      expect(DEFAULT_CONDITION_TERMS[code]?.length, code).toBeGreaterThan(0);
    }
  });

  it('drops a past delivery or loss read as a current one', () => {
    const text =
      'Pcte G3P2, cesárea previa. Antecedente de aborto. Puérpera de 8 días, parto eutócico.';
    const result = postProcessExtraction(
      {
        ...empty,
        conditions: [
          condition('O82', 'cesárea previa'),
          condition('O03', 'Antecedente de aborto'),
          condition('O80', 'parto eutócico'),
          condition('Z39', 'Puérpera de 8 días'),
        ],
      },
      { text, authoredAt: AUTHORED },
    );
    expect(result.conditions.map((c) => c.code.code)).toEqual(['O80', 'Z39']);
    expect(result.rejected.map((r) => [r.evidenceQuote, r.reason])).toEqual([
      ['cesárea previa', 'not_current'],
      ['Antecedente de aborto', 'not_current'],
    ]);
  });

  it('still reads gestational diabetes in a past pregnancy as not current', () => {
    const text = 'Antecedente de diabetes gestacional en embarazo previo. Control de rutina.';
    const result = postProcessExtraction(
      { ...empty, conditions: [condition('O24', 'diabetes gestacional en embarazo previo')] },
      { text, authoredAt: AUTHORED },
    );
    expect(result.rejected.map((r) => r.reason)).toEqual(['not_current']);
  });
});

describe('fixtures carry the pregnancy through the real gateway', () => {
  it('turns a gold expectation into the model reply, null when absent', () => {
    const base = { hasPlan: false, conditions: [], medications: [], planItems: [] };
    expect(modelOutputFromExpected(base).pregnancy).toBeNull();
    expect(
      modelOutputFromExpected({
        ...base,
        pregnancy: {
          outcome: {
            kind: 'cesarean_delivery',
            daysAgo: 10,
            evidenceQuote: 'cesárea hace 10 días',
          },
        },
      }).pregnancy,
    ).toEqual({
      ...noDating,
      outcome: {
        kind: 'cesarean_delivery',
        date: null,
        daysAgo: 10,
        evidenceQuote: 'cesárea hace 10 días',
      },
    });
  });

  it('turns a scenario fixture (ISO instants) into the model reply', () => {
    const output = modelOutputFromExtraction({
      hasPlan: true,
      conditions: [],
      medications: [],
      planItems: [],
      pregnancy: {
        gestationalWeeks: 20,
        lastMenstrualPeriod: '2026-04-03T12:00:00.000Z',
        datingEvidenceQuote: 'embarazo de 20 sem',
        outcome: { kind: 'loss', date: '2026-08-20T12:00:00.000Z', evidenceQuote: 'aborto' },
      },
    });
    expect(output.pregnancy).toEqual({
      ...noDating,
      gestationalWeeks: 20,
      lastMenstrualPeriod: '2026-04-03',
      datingEvidenceQuote: 'embarazo de 20 sem',
      outcome: { kind: 'loss', date: '2026-08-20', daysAgo: null, evidenceQuote: 'aborto' },
    });
    expect(
      modelOutputFromExtraction({ hasPlan: false, conditions: [], medications: [], planItems: [] })
        .pregnancy,
    ).toBeNull();
  });

  it('runs without a note date (no pregnancy reading, no crash)', () => {
    expect(heuristicExtraction('Embarazo de 20 sem.').pregnancy).toBeNull();
  });
});
