import { clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createLlmGateway } from '../gateway/gateway.ts';
import { createFakeProvider, FAKE_DEFAULT_MODEL } from '../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import type { ProviderRequest } from '../usage.ts';
import { heuristicExtraction, heuristicResponder } from './heuristic-baseline.ts';
import { detectNoteLanguage, lexiconLanguage, resolveNoteLanguage } from './language.ts';
import { createNoteExtractor } from './note-extractor.ts';
import { postProcessExtraction } from './post-process.ts';
import { NOTE_EXTRACTION_TASK, readNoteLanguageFromMessages } from './prompt.ts';
import { normalizeForMatch } from './quote.ts';
import type { ModelExtraction, ModelPlanItem } from './schema.ts';
import {
  conditionContext,
  findDischarge,
  forwardIntervals,
  hasKindKeyword,
  isConditional,
  isHedgedMention,
  isNegatedMention,
  statedTiming,
  statesSuspension,
} from './signals.ts';

const SPANISH =
  'Pcte fem 58a con DM2 e HTA. Refiere buena adherencia a la metformina. Plan: control en 3 meses con HbA1c.';
const ENGLISH =
  '58 yo F with T2DM and HTN, here for f/u. Reports good adherence to metformin. Plan: repeat A1c in 3 months and RTC in 3 months.';
const PORTUGUESE =
  'Paciente do sexo feminino com diabetes, nega dor. Retorno em 3 meses com exames e uma consulta de nutrição.';

/** Where `term` is in the normalized `text`, for the mention-level checks. */
function mention(text: string, term: string): [string, number, number] {
  const normalized = normalizeForMatch(text);
  const start = normalized.indexOf(term);
  if (start < 0) throw new Error(`${term} not in ${normalized}`);
  return [normalized, start, start + term.length];
}

describe('note language detection', () => {
  it('tells Spanish, English and Portuguese notes apart', () => {
    expect(detectNoteLanguage(SPANISH)).toBe('es');
    expect(detectNoteLanguage(ENGLISH)).toBe('en');
    expect(detectNoteLanguage(PORTUGUESE)).toBe('pt');
  });

  it('says nothing when the note is too short or too mixed to tell', () => {
    expect(detectNoteLanguage('Ok.')).toBeUndefined();
    expect(detectNoteLanguage('HbA1c 7.4%. TA 120/80.')).toBeUndefined();
  });

  it('prefers the host language, canonicalized, and detects otherwise', () => {
    expect(resolveNoteLanguage('EN_us', SPANISH)).toBe('en-US');
    expect(resolveNoteLanguage('not a tag', SPANISH)).toBe('es');
    expect(resolveNoteLanguage(undefined, ENGLISH)).toBe('en');
  });

  it('reads English with English lexicons and anything else with the Spanish ones', () => {
    expect(lexiconLanguage('en-GB')).toBe('en');
    expect(lexiconLanguage('es-VE')).toBe('es');
    expect(lexiconLanguage('pt-BR')).toBe('es');
    expect(lexiconLanguage(undefined)).toBe('es');
  });
});

describe('English lexicons of the deterministic checks', () => {
  it('reads negation and hedging', () => {
    expect(isNegatedMention(...mention('Denies DM/HTN.', 'htn'), 'en')).toBe(true);
    expect(isNegatedMention(...mention('No history of diabetes.', 'diabetes'), 'en')).toBe(true);
    expect(isNegatedMention(...mention('Pt with no DM, HTN on lisinopril', 'htn'), 'en')).toBe(
      false,
    );
    expect(isNegatedMention(...mention('T2DM, not at goal.', 't2dm'), 'en')).toBe(false);
    expect(isHedgedMention(...mention('Possible hypothyroidism.', 'hypothyroidism'), 'en')).toBe(
      true,
    );
    // The Spanish lexicon does not read English cues, and the other way round.
    expect(isNegatedMention(...mention('Denies HTN.', 'htn'), 'es')).toBe(false);
    expect(isNegatedMention(...mention('Niega HTA.', 'hta'), 'en')).toBe(false);
  });

  it('reads family history and non-current conditions', () => {
    const [text, start, end] = mention('FHx: mother with T2DM, father with HTN.', 't2dm');
    expect(conditionContext(text, start, end, 'E11', 'en')).toBe('family_history');
    const risk = mention('Counseling given, at risk for diabetes.', 'diabetes');
    expect(conditionContext(...risk, 'E11', 'en')).toBe('not_current');
    const gestational = mention('History of gestational diabetes.', 'diabetes');
    expect(conditionContext(...gestational, 'E11', 'en')).toBe('not_current');
    const own = mention('PMH: T2DM, HTN.', 't2dm');
    expect(conditionContext(...own, 'E11', 'en')).toBeUndefined();
  });

  it('reads conditional returns, scheduled ones with an early-return clause and cancellations', () => {
    const norm = normalizeForMatch;
    expect(isConditional(norm('Return if symptoms worsen'), undefined, 'en')).toBe(true);
    expect(isConditional(norm('return in 1 week only if symptoms persist'), undefined, 'en')).toBe(
      true,
    );
    expect(isConditional(norm('ibuprofen 400 mg PRN pain'), undefined, 'en')).toBe(true);
    expect(isConditional(norm('F/u in 1 month or sooner if worse'), undefined, 'en')).toBe(false);
    expect(isConditional(norm('RTC in 3 months'), undefined, 'en')).toBe(false);
    expect(isConditional(norm('see in 1 week'), norm('If no better, see in 1 week'), 'en')).toBe(
      true,
    );
    expect(statesSuspension(norm('cancel the 1-month f/u that was scheduled'), 'en')).toBe(true);
    expect(statesSuspension(norm('f/u in 3 months'), 'en')).toBe(false);
  });

  it('reads a discharge, never a hospital discharge', () => {
    const norm = normalizeForMatch;
    expect(findDischarge(norm("Plan: d/c'd from therapy today."), 'en')).toBeDefined();
    expect(findDischarge(norm('Discharged from PT, goals met.'), 'en')).toBeDefined();
    expect(findDischarge(norm('No further follow-up needed.'), 'en')).toBeDefined();
    expect(
      findDischarge(norm('Discharged from the hospital 5 days ago after CHF exacerbation.'), 'en'),
    ).toBeUndefined();
    expect(findDischarge(norm('Not yet discharged from therapy.'), 'en')).toBeUndefined();
    expect(findDischarge(norm('d/c metformin, f/u in 3 months'), 'en')).toBeUndefined();
  });

  it('reads US timing expressions', () => {
    const days = (text: string): readonly number[] =>
      statedTiming(normalizeForMatch(text), '2026-03-01', 'en').days;
    expect(days('f/u in 3 months')).toEqual([90]);
    expect(days('RTC 6 wks')).toEqual([42]);
    expect(days('A1c q3 months')).toEqual([90]);
    expect(days('every 6 months')).toEqual([180]);
    expect(days('next month')).toEqual([30]);
    expect(days('lipid panel annually')).toEqual([365]);
    expect(days('3-month follow-up')).toEqual([90]);
    // Durations, ages and the past are not intervals.
    expect(forwardIntervals(normalizeForMatch('amoxicillin for 10 days'), 'en')).toEqual([]);
    expect(forwardIntervals(normalizeForMatch('cough x 4 days'), 'en')).toEqual([]);
    expect(forwardIntervals(normalizeForMatch('45 years old'), 'en')).toEqual([]);
    expect(forwardIntervals(normalizeForMatch('lifted boxes 3 days ago'), 'en')).toEqual([]);
    const timing = (text: string) => statedTiming(normalizeForMatch(text), '2026-03-01', 'en');
    expect(timing('RTC on 03/15/2026').dates).toEqual(['2026-03-15']);
    expect(timing('Follow-up visit on May 4, 2026').dates).toEqual(['2026-05-04']);
    expect(timing('see her on March 15th').dates).toEqual(['2026-03-15']);
    expect(timing('labs before next visit').nextVisit).toBe(true);
    // The Spanish lexicon reads the same date as dd/mm.
    expect(statedTiming('15/03/2026', '2026-03-01').dates).toEqual(['2026-03-15']);
  });

  it('reads US plan and test wording', () => {
    expect(hasKindKeyword('follow_up_visit', normalizeForMatch('RTC 6 wks'), 'en')).toBe(true);
    expect(hasKindKeyword('follow_up_visit', normalizeForMatch('f/u in 3 months'), 'en')).toBe(
      true,
    );
    expect(hasKindKeyword('lab', normalizeForMatch('BMP in 1 week'), 'en')).toBe(true);
    expect(hasKindKeyword('imaging', normalizeForMatch('CXR in 6 weeks'), 'en')).toBe(true);
    expect(hasKindKeyword('imaging', normalizeForMatch('call us with any concerns'), 'en')).toBe(
      false,
    );
  });
});

describe('post-checks on an English note', () => {
  const NOTE =
    '62 yo M. Denies HTN. FHx: mother with T2DM. Dx: hypothyroidism.\nPlan: Repeat TSH in 6 wks. Return in 1 week only if symptoms persist. Cancel the 1-month f/u. RTC 3 months.';
  const authoredAt = new Date('2026-03-02T12:00:00Z');
  const plan = (evidenceQuote: string, kind: ModelPlanItem['kind'], amount: number) => ({
    kind,
    description: kind === 'lab' ? 'repeat TSH' : 'follow-up visit',
    timing: { amount, unit: kind === 'lab' ? ('week' as const) : ('month' as const), date: null },
    loincCode: kind === 'lab' ? '3016-3' : null,
    evidenceQuote,
    confidence: 0.9,
  });
  const raw: ModelExtraction = {
    hasPlan: true,
    discharge: null,
    pregnancy: null,
    conditions: [
      { icd10: 'I10', display: 'hypertension', confidence: 0.9, evidenceQuote: 'Denies HTN' },
      { icd10: 'E11', display: 'diabetes', confidence: 0.9, evidenceQuote: 'mother with T2DM' },
      { icd10: 'E03', display: 'hypothyroidism', confidence: 0.9, evidenceQuote: 'hypothyroidism' },
    ],
    medications: [],
    planItems: [
      plan('Repeat TSH in 6 wks', 'lab', 6),
      plan('Return in 1 week', 'follow_up_visit', 0.25),
      plan('Cancel the 1-month f/u', 'follow_up_visit', 1),
      plan('RTC 3 months', 'follow_up_visit', 3),
    ],
  };

  it('keeps what the note backs and drops what the English lexicons rule out', () => {
    const result = postProcessExtraction(raw, { text: NOTE, authoredAt }, { language: 'en' });
    expect(result.conditions.map((c) => c.code.code)).toEqual(['E03']);
    expect(result.planItems.map((p) => [p.kind, p.evidenceQuote, p.code?.code])).toEqual([
      ['lab', 'Repeat TSH in 6 wks', '3016-3'],
      ['follow_up_visit', 'RTC 3 months', undefined],
    ]);
    expect(result.rejected.map((r) => [r.field, r.reason])).toEqual([
      ['condition', 'negated'],
      ['condition', 'family_history'],
      ['planItem', 'conditional'],
      ['planItem', 'cancelled'],
    ]);
  });
});

describe('the rule-based reader and the extractor on English notes', () => {
  it('reads an English note with the English lexicons', () => {
    const output = heuristicExtraction(
      "45 yo M. Denies DM/HTN. Dx: hyperlipidemia.\nPlan: atorvastatin 20 mg daily. Lipid panel in 3 months. F/u in 3 months. Return if worse. D/c'd from PT.",
      '2026-03-02',
    );
    expect(output.conditions.map((c) => c.icd10)).toEqual(['E78']);
    expect(output.medications.map((m) => m.text)).toEqual(['atorvastatin 20 mg daily']);
    expect(output.planItems.map((p) => [p.kind, p.evidenceQuote])).toEqual([
      ['lab', 'Lipid panel in 3 months'],
      ['follow_up_visit', 'F/u in 3 months'],
    ]);
    expect(output.discharge?.evidenceQuote).toBe("D/c'd from PT");
  });

  it('reports the language it read: the host language first, else detected', async () => {
    const seen: ProviderRequest<unknown>[] = [];
    const gateway = createLlmGateway({
      providers: {
        fake: createFakeProvider({
          respond: (request) => {
            seen.push(request);
            return heuristicResponder(request);
          },
        }),
      },
      tasks: {
        [NOTE_EXTRACTION_TASK]: { route: [{ provider: 'fake', model: FAKE_DEFAULT_MODEL }] },
      },
      usageLog: new InMemoryLlmUsageLog(),
    });
    const extractor = createNoteExtractor({ gateway });
    const clinic = clinicId('clinic-language');
    const authoredAt = new Date('2026-03-02T12:00:00Z');
    const detected = await extractor.extract(clinic, {
      documentId: 'n1',
      text: ENGLISH,
      authoredAt,
    });
    expect(detected.noteLanguage).toBe('en');
    expect(detected.planItems.map((p) => p.kind).sort()).toEqual(['follow_up_visit', 'lab']);
    const stated = await extractor.extract(clinic, {
      documentId: 'n2',
      text: SPANISH,
      authoredAt,
      language: 'es-VE',
    });
    expect(stated.noteLanguage).toBe('es-VE');
    expect(seen.map((request) => readNoteLanguageFromMessages(request.messages))).toEqual([
      'en',
      'es-VE',
    ]);
    const unknown = await extractor.extract(clinic, { documentId: 'n3', text: 'Ok.', authoredAt });
    expect(unknown.noteLanguage).toBeUndefined();
  });
});
