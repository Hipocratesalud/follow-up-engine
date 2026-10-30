import { describe, expect, it } from 'vitest';
import { findingTextIn } from '../../domain/clinical-finding.ts';
import type {
  ClinicalReviewAgent,
  ProposedFinding,
  ReviewAgentResult,
} from '../../ports/clinical-review-agent.ts';
import { reviewRecord } from './pipeline.ts';
import { CLINIC, medication, note, result, snapshot } from './test-support.ts';

/*
 * A finding is read in the viewer's language, not only the clinic's: the
 * detectors render every locale from the same templates, a model's proposal
 * carries both languages, and the clinic-locale text stays the stored one.
 * Quotes are never translated.
 */

const RECORD = snapshot([
  result(-400, '2160-0', 1.05, 'mg/dL', { id: 'obs-1' }),
  result(-300, '2160-0', 1.1, 'mg/dL', { id: 'obs-2' }),
  result(-150, '2160-0', 1.4, 'mg/dL', { id: 'obs-3' }),
  result(-40, '2160-0', 1.75, 'mg/dL', { id: 'obs-4' }),
  note(-30, 'Control de DM2. Buena tolerancia a la metformina. Alergias: niega.', {
    specialty: 'diabetology',
  }),
  medication(-500, 'Metformina 850 mg', { atc: 'A10BA02' }),
]);
const ALL = (): boolean => true;

function agentWith(proposals: readonly ProposedFinding[]): ClinicalReviewAgent {
  return {
    review(): Promise<ReviewAgentResult> {
      return Promise.resolve({
        proposals,
        stopReason: 'submitted',
        steps: 2,
        toolCalls: 1,
        trace: [],
        inputTokens: 1000,
        outputTokens: 200,
        costUsd: 0.002,
        modelId: 'test:model',
        promptVersion: 'test@2',
      });
    },
  };
}

describe('finding texts in every review locale', () => {
  it.each(['en', 'es'] as const)(
    'a detector (template) finding of a clinic in %s carries English and Spanish',
    async (locale) => {
      const outcome = await reviewRecord(CLINIC, RECORD, {
        enabled: ALL,
        patientRef: 'P-1',
        locale,
      });
      const trend = outcome.findings.find((finding) => finding.category === 'lab_trend');
      if (trend === undefined) throw new Error('no lab trend');
      expect(trend.texts?.en?.summary).toMatch(/^Creatinine rising over the last/);
      expect(trend.texts?.en?.suggestion).toMatch(/^Consider assessing renal function/);
      expect(trend.texts?.es?.summary).toMatch(/^Creatinina en ascenso en los últimos/);
      expect(trend.texts?.es?.suggestion).toMatch(/^Considera evaluar la función renal/);
      // Numbers as each reader writes them.
      expect(trend.texts?.en?.summary).toContain('(1.05 → 1.1 → 1.4 → 1.75 mg/dL)');
      expect(trend.texts?.es?.summary).toContain('(1,05 → 1,1 → 1,4 → 1,75 mg/dL)');
      // Dates in the sentences in each reader's way, never ISO.
      expect(trend.texts?.en?.rationale).toMatch(/between [A-Z][a-z]{2} \d{1,2}, \d{4} and/);
      expect(trend.texts?.es?.rationale).toMatch(/entre el \d{1,2} [a-z]+ \d{4} y el/);
      expect(`${trend.texts?.en?.rationale ?? ''} ${trend.texts?.es?.rationale ?? ''}`).not.toMatch(
        /\d{4}-\d{2}-\d{2}/,
      );
      // The stored text is the clinic's locale, and its own entry is the same words.
      expect(trend.texts?.[locale]).toEqual({
        summary: trend.summary,
        rationale: trend.rationale,
        suggestion: trend.suggestion,
      });
      // Every signal the model would see carries both languages too.
      expect(outcome.signals.every((signal) => signal.texts?.en && signal.texts.es)).toBe(true);
      // Quotes are the record's canonical lines in the clinic's locale, never translated per text.
      expect(trend.citations.at(-1)?.quote).toBe(
        locale === 'en' ? 'Creatinine: 1.75 mg/dL' : 'Creatinina: 1,75 mg/dL',
      );
    },
  );

  it("keeps a model's own English and Spanish, its texts winning over its main fields", async () => {
    const outcome = await reviewRecord(CLINIC, RECORD, {
      enabled: ALL,
      patientRef: 'P-1',
      locale: 'en',
      agent: agentWith([
        {
          category: 'lab_trend',
          severity: 'high',
          summary: 'Creatinine keeps rising',
          rationale: 'Four results in a row got worse.',
          suggestion: 'Consider checking renal function.',
          citations: [{ docId: 'R4', quote: 'Creatinine: 1.75 mg/dL' }],
          signalIds: [],
          texts: {
            en: {
              summary: 'Creatinine keeps rising (model en)',
              rationale: 'Four results in a row got worse.',
              suggestion: 'Consider checking renal function.',
            },
            es: {
              summary: 'La creatinina sigue en ascenso',
              rationale: 'Cuatro resultados seguidos empeoran.',
              suggestion: 'Considera revisar la función renal.',
            },
          },
        },
      ]),
    });
    const [finding] = outcome.findings;
    expect(finding?.texts?.es?.summary).toBe('La creatinina sigue en ascenso');
    // The model's English entry wins (Muse Spark wrote main fields in Spanish for an English clinic).
    expect(finding?.texts?.en?.summary).toBe('Creatinine keeps rising (model en)');
    expect(finding && findingTextIn(finding, 'es').suggestion).toBe(
      'Considera revisar la función renal.',
    );
  });

  it('drops a finding whose translation addresses the patient', async () => {
    const outcome = await reviewRecord(CLINIC, RECORD, {
      enabled: ALL,
      patientRef: 'P-1',
      locale: 'en',
      agent: agentWith([
        {
          category: 'lab_trend',
          severity: 'high',
          summary: 'Creatinine keeps rising',
          rationale: 'Four results in a row got worse.',
          suggestion: 'Consider checking renal function.',
          citations: [{ docId: 'R4', quote: 'Creatinine: 1.75 mg/dL' }],
          signalIds: [],
          texts: {
            en: {
              summary: 'Creatinine keeps rising',
              rationale: 'Four results in a row got worse.',
              suggestion: 'Consider checking renal function.',
            },
            es: {
              summary: 'Creatinina en ascenso',
              rationale: 'Cuatro resultados seguidos empeoran.',
              suggestion: 'Envía un mensaje al paciente para que suspenda la metformina.',
            },
          },
        },
      ]),
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.discarded.patient_directed).toBe(1);
  });

  it('a model finding without translations falls back to the stored text', () => {
    const stored = { summary: 'Only English', rationale: 'r', suggestion: 's' };
    expect(findingTextIn(stored, 'es')).toEqual(stored);
    expect(
      findingTextIn({ ...stored, texts: { es: { ...stored, summary: 'Solo' } } }, 'es'),
    ).toMatchObject({ summary: 'Solo' });
    expect(findingTextIn(stored, 'fr')).toEqual(stored);
  });
});
