import { describe, expect, it } from 'vitest';
import { postProcessExtraction } from './post-process.ts';
import type { ModelExtraction, ModelPlanItem } from './schema.ts';

/*
 * Items Muse Spark (muse-spark-1.3, note-extraction@4) returned on the gold
 * notes that the post-checks dropped although the note backs them (eval of
 * 2026-10-27, docs/evals/README.md). Each case is the model's item as it
 * came, on the sentence of the gold note it quoted.
 */

const empty: ModelExtraction = {
  hasPlan: true,
  discharge: null,
  pregnancy: null,
  conditions: [],
  medications: [],
  planItems: [],
};

function run(text: string, ...items: ModelPlanItem[]) {
  return postProcessExtraction(
    { ...empty, planItems: items },
    { text, authoredAt: new Date('2025-08-11T12:00:00Z') },
  );
}

const visit: ModelPlanItem = {
  kind: 'follow_up_visit',
  description: 'follow-up visit',
  timing: { amount: 1, unit: 'month', date: null },
  loincCode: null,
  evidenceQuote: 'Ctrl en 1 mes',
  confidence: 0.9,
};

const lab = (evidenceQuote: string, description: string): ModelPlanItem => ({
  kind: 'lab',
  description,
  timing: null,
  loincCode: null,
  evidenceQuote,
  confidence: 0.9,
});

describe('post-checks on real Muse Spark phrasing', () => {
  it('keeps a test quoted by its bare abbreviation from a list ("K+", "HIV")', () => {
    const result = run(
      'Plan: Se solicita: hematología, creatinina, K+, glicemia. Hematología, VDRL, HIV y examen de orina. Ctrl en 1 mes con resultados.',
      lab('K+', 'potassium'),
      lab('HIV', 'HIV test'),
      visit,
    );
    expect(result.rejected).toEqual([]);
    expect(result.planItems.map((item) => item.description)).toEqual([
      'potassium',
      'HIV test',
      'follow-up visit',
    ]);
  });

  it('still rejects a short quote that names no test ("Plan", "ok")', () => {
    const result = run('Plan: ok. Ctrl en 1 mes.', lab('Plan', 'HbA1c'), lab('ok', 'TSH'), visit);
    expect(result.rejected.map((r) => r.reason)).toEqual(['quote_unrelated', 'quote_too_short']);
  });

  it('accepts a lab quoted by a lexicon name the plan wording lacks ("curva de tolerancia glucosada")', () => {
    const result = run(
      'Se solicita curva de tolerancia glucosada y HbA1c. Volver con resultados en 15 días.',
      { ...lab('curva de tolerancia glucosada', 'oral glucose tolerance test') },
      {
        ...visit,
        evidenceQuote: 'Volver con resultados en 15 días',
        timing: { amount: 15, unit: 'day', date: null },
      },
    );
    expect(result.rejected).toEqual([]);
    expect(result.planItems.map((item) => item.kind)).toEqual(['lab', 'follow_up_visit']);
  });

  it('accepts referrals and procedures by their usual abbreviations ("ref a nefrologia", "ECG")', () => {
    const result = run(
      'Ref a nefrologia en 1 mes. ECG en 1 mes. Ctrl en 1 mes.',
      {
        ...visit,
        kind: 'other',
        description: 'nephrology referral',
        evidenceQuote: 'ref a nefrologia en 1 mes',
      },
      { ...visit, kind: 'other', description: 'ECG', evidenceQuote: 'ECG' },
    );
    expect(result.rejected).toEqual([]);
    expect(result.planItems.map((item) => item.description)).toEqual([
      'nephrology referral',
      'ECG',
    ]);
  });
});

describe('the kind of a visit is read from its quote', () => {
  it('a follow-up visit quoted as the next session is a session ("Próx. sesión en 1 semana")', () => {
    const result = run(
      'Plan: TCC. Próx. sesión en 1 semana. Ctrl en 1 mes.',
      {
        ...visit,
        description: 'follow-up session',
        evidenceQuote: 'Próx. sesión en 1 semana.',
        timing: { amount: 1, unit: 'week', date: null },
      },
      visit,
    );
    expect(result.planItems.map((item) => item.kind)).toEqual(['session', 'follow_up_visit']);
  });
});

describe('a study due at a gestational age ("a las 20 semanas")', () => {
  const text =
    'Primigesta cursando embarazo de 12 sem por FUM.\nDx: embarazo de 12 semanas normoevolutivo.\nPlan: Eco obstétrico morfológico a las 20 semanas. Ctrl en 4 semanas.';
  const eco: ModelPlanItem = {
    kind: 'imaging',
    description: 'morphologic obstetric ultrasound',
    timing: null,
    loincCode: null,
    evidenceQuote: 'Eco obstétrico morfológico a las 20 semanas',
    confidence: 0.9,
  };
  const ctrl: ModelPlanItem = {
    ...visit,
    evidenceQuote: 'Ctrl en 4 semanas',
    timing: { amount: 4, unit: 'week', date: null },
  };
  const day = (date: Date | undefined) => date?.toISOString().slice(0, 10);

  it('is due when the pregnancy reaches it, from the age the note states (week 12 -> in 8 weeks)', () => {
    const result = run(text, eco, ctrl);
    // 2025-08-11 + 56 days
    expect(result.planItems.map((item) => [item.kind, day(item.dueAt)])).toEqual([
      ['imaging', '2025-10-06'],
      ['follow_up_visit', '2025-09-08'],
    ]);
    expect(result.planItems[0]?.confidence).toBe(0.9);
  });

  it('ignores a model date that contradicts that age, and inherits the visit without a stated age', () => {
    const wrong = { ...eco, timing: { amount: 20, unit: 'week' as const, date: null } };
    expect(day(run(text, wrong, ctrl).planItems[0]?.dueAt)).toBe('2025-10-06');
    const noAge = run(
      'Plan: Eco obstétrico morfológico a las 20 semanas. Ctrl en 4 semanas.',
      eco,
      ctrl,
    );
    expect(day(noAge.planItems[0]?.dueAt)).toBe('2025-09-08');
  });
});

describe('condition terms', () => {
  it('backs cystitis (N30) with "ITU baja", as Muse Spark codes a lower urinary tract infection', () => {
    const result = postProcessExtraction(
      {
        ...empty,
        conditions: [
          {
            icd10: 'N30',
            display: 'uncomplicated lower urinary tract infection',
            confidence: 0.95,
            evidenceQuote: 'ITU baja no complicada.',
          },
        ],
      },
      {
        text: 'Disuria y polaquiuria de 2 días.\nDx: ITU baja no complicada.',
        authoredAt: new Date('2025-08-11T12:00:00Z'),
      },
    );
    expect(result.rejected).toEqual([]);
    expect(result.conditions.map((condition) => condition.code.code)).toEqual(['N30']);
  });
});
