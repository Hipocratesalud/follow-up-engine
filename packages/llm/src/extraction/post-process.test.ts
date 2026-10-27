import { ICD10_SYSTEM } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  clampConfidence,
  MAX_ITEM_CONFIDENCE,
  isValidLoinc,
  normalizeIcd10,
  postProcessExtraction,
} from './post-process.ts';
import { locateQuote, normalizeForMatch } from './quote.ts';
import type { ModelExtraction, ModelPlanItem } from './schema.ts';

const note = {
  text: 'Pcte fem 58a, DM2 e  HTA.\nContinúa metformina 850 mg c/12h. Plan: ctrl en 3 meses con HbA1c. Solicito perfil lipídico.',
  authoredAt: new Date('2025-03-10T12:00:00Z'),
};

const empty: ModelExtraction = {
  hasPlan: false,
  discharge: null,
  pregnancy: null,
  conditions: [],
  medications: [],
  planItems: [],
};

function plan(item: Partial<ModelPlanItem>): ModelPlanItem {
  return {
    kind: 'follow_up_visit',
    description: 'follow-up visit',
    timing: { amount: 3, unit: 'month', date: null },
    loincCode: null,
    evidenceQuote: 'ctrl en 3 meses',
    confidence: 0.9,
    ...item,
  };
}

describe('locateQuote', () => {
  it('matches ignoring case, accents and whitespace runs, and returns the verbatim span', () => {
    expect(locateQuote(note.text, 'continua METFORMINA 850 mg')).toBe('Continúa metformina 850 mg');
    expect(locateQuote(note.text, 'DM2 e HTA')).toBe('DM2 e  HTA');
    expect(locateQuote(note.text, '“perfil lipidico”')).toBe('perfil lipídico');
  });

  it('rejects quotes that are not in the note', () => {
    expect(locateQuote(note.text, 'ctrl en 6 meses')).toBeUndefined();
    expect(locateQuote(note.text, 'metformina ... HbA1c')).toBeUndefined();
    expect(locateQuote(note.text, '  ')).toBeUndefined();
  });

  it('normalizes for comparison', () => {
    expect(normalizeForMatch('  Próximo   MES\n')).toBe('proximo mes');
  });
});

describe('postProcessExtraction', () => {
  it('keeps grounded items, resolves due dates in code and stores verbatim quotes', () => {
    const result = postProcessExtraction(
      {
        hasPlan: true,
        discharge: null,
        pregnancy: null,
        conditions: [
          { icd10: 'e11.9', display: 'Type 2 diabetes', confidence: 0.95, evidenceQuote: 'dm2' },
        ],
        medications: [
          {
            text: 'metformina 850 mg c/12h',
            duration: { amount: 3, unit: 'month' },
            evidenceQuote: 'metformina 850 mg c/12h',
          },
        ],
        planItems: [plan({})],
      },
      note,
    );
    expect(result.conditions).toEqual([
      {
        code: { system: ICD10_SYSTEM, code: 'E11.9', display: 'Type 2 diabetes' },
        confidence: 0.9,
        evidenceQuote: 'DM2',
      },
    ]);
    expect(result.medications).toEqual([
      {
        text: 'metformina 850 mg c/12h',
        durationDays: 90,
        evidenceQuote: 'metformina 850 mg c/12h',
      },
    ]);
    expect(result.planItems).toEqual([
      {
        kind: 'follow_up_visit',
        description: 'follow-up visit',
        dueAt: new Date('2025-06-10T12:00:00Z'),
        evidenceQuote: 'ctrl en 3 meses',
        confidence: 0.9,
      },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.modelItemCount).toBe(3);
  });

  it('drops every item whose quote is not in the note (hallucination guard)', () => {
    const result = postProcessExtraction(
      {
        hasPlan: true,
        discharge: null,
        pregnancy: null,
        conditions: [{ icd10: 'E78', display: '', confidence: 0.8, evidenceQuote: 'dislipidemia' }],
        medications: [
          { text: 'atorvastatina 20 mg', duration: null, evidenceQuote: 'atorvastatina 20 mg' },
        ],
        planItems: [plan({ evidenceQuote: 'control en tres meses' })],
      },
      note,
    );
    expect(result.conditions).toEqual([]);
    expect(result.medications).toEqual([]);
    expect(result.planItems).toEqual([]);
    expect(result.rejected.map((r) => [r.field, r.reason])).toEqual([
      ['condition', 'quote_not_found'],
      ['medication', 'quote_not_found'],
      ['planItem', 'quote_not_found'],
    ]);
    expect(result.hasPlan).toBe(true); // the model saw a plan; only the items were ungrounded
  });

  it('clamps confidences and rejects malformed ICD-10 codes', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        conditions: [
          { icd10: 'I10', display: '', confidence: 7, evidenceQuote: 'HTA' },
          { icd10: 'hypertension', display: '', confidence: 0.5, evidenceQuote: 'HTA' },
        ],
        planItems: [plan({ confidence: -1 })],
      },
      note,
    );
    expect(result.conditions[0]?.confidence).toBe(MAX_ITEM_CONFIDENCE);
    expect(result.conditions[0]?.code).toEqual({ system: ICD10_SYSTEM, code: 'I10' });
    expect(result.planItems[0]?.confidence).toBe(0);
    expect(result.rejected).toEqual([
      { field: 'condition', reason: 'invalid_code', evidenceQuote: 'HTA' },
    ]);
  });

  it('dedupes conditions (keeping the most confident), medications and plan items', () => {
    const result = postProcessExtraction(
      {
        hasPlan: true,
        discharge: null,
        pregnancy: null,
        conditions: [
          { icd10: 'E11', display: '', confidence: 0.6, evidenceQuote: 'DM2' },
          { icd10: 'E11', display: 'T2DM', confidence: 0.9, evidenceQuote: 'DM2' },
        ],
        medications: [
          { text: 'Metformina 850 mg c/12h', duration: null, evidenceQuote: 'metformina 850 mg' },
          { text: 'metformina 850 mg c/12h', duration: null, evidenceQuote: 'metformina' },
        ],
        planItems: [plan({}), plan({ evidenceQuote: 'Plan: ctrl en 3 meses' })],
      },
      note,
    );
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]?.confidence).toBe(0.9);
    expect(result.medications).toHaveLength(1);
    expect(result.planItems).toHaveLength(1);
    expect(result.rejected.every((r) => r.reason === 'duplicate')).toBe(true);
    expect(result.rejected).toHaveLength(3);
  });

  it('gives an untimed lab the date of the follow-up visit, and drops other untimed items', () => {
    const result = postProcessExtraction(
      {
        hasPlan: true,
        discharge: null,
        pregnancy: null,
        conditions: [],
        medications: [],
        planItems: [
          plan({
            kind: 'lab',
            description: 'lipid panel',
            timing: null,
            evidenceQuote: 'perfil lipídico',
          }),
          plan({}),
          plan({ kind: 'other', description: 'diet', timing: null, evidenceQuote: 'Plan:' }),
        ],
      },
      note,
    );
    expect(result.planItems.map((p) => [p.kind, p.dueAt.toISOString()])).toEqual([
      ['lab', '2025-06-10T12:00:00.000Z'],
      ['follow_up_visit', '2025-06-10T12:00:00.000Z'],
    ]);
    expect(result.rejected).toEqual([
      { field: 'planItem', reason: 'quote_unrelated', evidenceQuote: 'Plan:' },
    ]);
  });

  it('drops an untimed lab when there is no follow-up visit to anchor it', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        hasPlan: true,
        discharge: null,
        pregnancy: null,
        planItems: [plan({ kind: 'lab', timing: null, evidenceQuote: 'HbA1c' })],
      },
      note,
    );
    expect(result.planItems).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('no_due_date');
  });

  it('rejects explicit dates before the note', () => {
    const result = postProcessExtraction(
      { ...empty, planItems: [plan({ timing: { amount: null, unit: null, date: '2024-12-01' } })] },
      note,
    );
    expect(result.rejected[0]?.reason).toBe('due_before_note');
  });

  it('reports no plan for a note without one', () => {
    const result = postProcessExtraction(empty, note);
    expect(result).toMatchObject({
      hasPlan: false,
      planItems: [],
      rejected: [],
      modelItemCount: 0,
    });
  });

  it('sets hasPlan when grounded plan items exist even if the model said false', () => {
    expect(postProcessExtraction({ ...empty, planItems: [plan({})] }, note).hasPlan).toBe(true);
  });
});

describe('LOINC codes', () => {
  it('validates the mod-10 check digit', () => {
    expect(isValidLoinc('4548-4')).toBe(true); // HbA1c
    expect(isValidLoinc('2345-7')).toBe(true); // glucose
    expect(isValidLoinc('3016-3')).toBe(true); // TSH
    expect(isValidLoinc('4548-5')).toBe(false);
    expect(isValidLoinc('HbA1c')).toBe(false);
  });

  it('keeps a valid LOINC on lab items only, and codes an invented one by the test its quote names', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        planItems: [
          plan({ kind: 'lab', description: 'HbA1c', evidenceQuote: 'HbA1c', loincCode: '4548-4' }),
          plan({
            kind: 'lab',
            description: 'lipids',
            evidenceQuote: 'perfil lipídico',
            loincCode: '1234-1',
          }),
          plan({ loincCode: '4548-4' }),
        ],
      },
      note,
    );
    // "1234-1" is invented: the quote names a lipid panel, so the item gets
    // the lexicon's lipid panel code instead (the engine matches results by it).
    expect(result.planItems.map((p) => p.code?.code)).toEqual(['4548-4', '57698-3', undefined]);
  });
});

describe('small helpers', () => {
  it('clamps confidence', () => {
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(0.42)).toBe(0.42);
  });

  it('normalizes ICD-10 codes', () => {
    expect(normalizeIcd10(' e119 ')).toBe('E11.9');
    expect(normalizeIcd10('J45.20')).toBe('J45.20');
    expect(normalizeIcd10('E11')).toBe('E11');
    expect(normalizeIcd10('11E')).toBeUndefined();
  });
});

describe('plan tests coded by the lexicon (diabetology audit)', () => {
  const diabetes = {
    text: 'DM2. Plan: pendiente HbA1c, creatinina, microalbuminuria y fondo de ojo, se reitera orden. Control en 3 meses.',
    authoredAt: new Date('2025-03-10T12:00:00Z'),
  };
  const quote = 'pendiente HbA1c, creatinina, microalbuminuria y fondo de ojo, se reitera orden';

  it('codes an uncoded lab item by the test its description and quote name', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        planItems: [plan({ kind: 'lab', description: 'creatinine', evidenceQuote: quote })],
      },
      diabetes,
    );
    expect(result.planItems.map((p) => [p.kind, p.code?.code])).toEqual([['lab', '2160-0']]);
  });

  it('splits one lab item that names several tests into one coded item per test', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        planItems: [plan({ kind: 'lab', description: 'laboratory tests', evidenceQuote: quote })],
      },
      diabetes,
    );
    expect(result.planItems.map((p) => [p.kind, p.description, p.code?.code])).toEqual([
      ['lab', 'HbA1c', '4548-4'],
      ['lab', 'creatinine', '2160-0'],
      ['lab', 'urine microalbumin', '14959-1'],
    ]);
  });

  it('reads "fondo de ojo" as the eye fundus exam, whatever kind the model gave it', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        planItems: [
          plan({ kind: 'other', description: 'ophthalmology referral', evidenceQuote: quote }),
        ],
      },
      diabetes,
    );
    expect(result.planItems.map((p) => [p.kind, p.code?.system, p.code?.code])).toEqual([
      ['imaging', 'https://hipocratesalud.com/fhir/CodeSystem/procedure', 'fundus-exam'],
    ]);
  });
});
