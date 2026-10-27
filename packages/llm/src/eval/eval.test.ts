import { fileURLToPath } from 'node:url';
import { ICD10_SYSTEM, clinicId } from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import { createNoteFixtureResponder, modelOutputFromExpected } from '../extraction/fixtures.ts';
import { heuristicResponder } from '../extraction/heuristic-baseline.ts';
import { createNoteExtractor } from '../extraction/note-extractor.ts';
import { NOTE_EXTRACTION_PROMPT_VERSION, NOTE_EXTRACTION_TASK } from '../extraction/prompt.ts';
import { createLlmGateway } from '../gateway/gateway.ts';
import { createFakeProvider, fakeRequestKey, type FakeResponder } from '../providers/fake.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { goldAuthoredAt, loadGoldNotes, type GoldNote } from './gold.ts';
import {
  compareExtraction,
  drugName,
  dueDaysMatch,
  icd10Category,
  levenshtein,
  matchCounts,
  medicationsMatch,
  percentile,
  scores,
} from './metrics.ts';
import { renderReport, reportFileName } from './report.ts';
import { mapWithConcurrency, runExtractionEval, summarize, type NoteResult } from './run.ts';

const GOLD_DIR = fileURLToPath(new URL('../../test/fixtures/gold-notes', import.meta.url));

describe('metric math', () => {
  it('computes precision, recall and F1', () => {
    const s = scores({ tp: 3, fp: 1, fn: 2 });
    expect([s.precision, s.recall]).toEqual([0.75, 0.6]);
    expect(s.f1).toBeCloseTo(2 / 3, 10);
    expect(scores({ tp: 0, fp: 0, fn: 0 })).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(scores({ tp: 0, fp: 2, fn: 0 })).toEqual({ precision: 0, recall: 1, f1: 0 });
    expect(scores({ tp: 0, fp: 0, fn: 2 })).toEqual({ precision: 1, recall: 0, f1: 0 });
  });

  it('matches one to one, preferring the closest prediction', () => {
    const distance = (e: number, p: number) => (Math.abs(e - p) <= 5 ? Math.abs(e - p) : undefined);
    expect(matchCounts([10, 12], [11, 30, 13], distance)).toEqual({ tp: 2, fp: 1, fn: 0 });
    expect(matchCounts([10, 10], [10], distance)).toEqual({ tp: 1, fp: 0, fn: 1 });
  });

  it('matches plan due dates within ±20% (at least one day)', () => {
    expect(dueDaysMatch(90, 92)).toBe(true);
    expect(dueDaysMatch(90, 108)).toBe(true);
    expect(dueDaysMatch(90, 109)).toBe(false);
    expect(dueDaysMatch(2, 3)).toBe(true);
    expect(dueDaysMatch(2, 4)).toBe(false);
  });

  it('matches ICD-10 by category and medications by fuzzy drug name', () => {
    expect(icd10Category('e11.9')).toBe('E11');
    expect(drugName('Losartán 50 mg c/24h')).toBe('losartan');
    expect(medicationsMatch('losartán 50 mg', 'Losartan potásico 100 mg')).toBe(true);
    expect(medicationsMatch('metformina 850 mg', 'metfromina 850')).toBe(true);
    expect(medicationsMatch('metformina', 'metoprolol')).toBe(false);
    expect(medicationsMatch('', 'x')).toBe(false);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([10], 95)).toBe(10);
  });

  it('compares an extraction with the gold expectation', () => {
    const authoredAt = new Date('2025-03-10T12:00:00Z');
    const compared = compareExtraction(
      {
        hasPlan: true,
        conditions: [
          { icd10: 'E11', evidenceQuote: 'DM2' },
          { icd10: 'I10', evidenceQuote: 'HTA' },
        ],
        medications: [{ text: 'metformina 850 mg', evidenceQuote: 'x' }],
        planItems: [
          { kind: 'follow_up_visit', dueInDays: 90, evidenceQuote: 'x' },
          { kind: 'lab', dueInDays: 90, evidenceQuote: 'x' },
        ],
      },
      {
        hasPlan: true,
        conditions: [
          { code: { system: ICD10_SYSTEM, code: 'E11.9' }, confidence: 1, evidenceQuote: 'DM2' },
          { code: { system: ICD10_SYSTEM, code: 'E78' }, confidence: 1, evidenceQuote: 'x' },
        ],
        medications: [{ text: 'Metformina 850mg', evidenceQuote: 'x' }],
        planItems: [
          {
            kind: 'follow_up_visit',
            description: '',
            dueAt: new Date('2025-06-10T12:00:00Z'),
            evidenceQuote: 'x',
            confidence: 1,
          },
          {
            kind: 'imaging',
            description: '',
            dueAt: new Date('2025-06-10T12:00:00Z'),
            evidenceQuote: 'x',
            confidence: 1,
          },
        ],
      },
      authoredAt,
    );
    expect(compared).toEqual({
      conditions: { tp: 1, fp: 1, fn: 1 },
      medications: { tp: 1, fp: 0, fn: 0 },
      planItems: { tp: 1, fp: 1, fn: 1 },
      hasPlanCorrect: true,
    });
  });

  it('aggregates hallucinated quotes, cost and latency', () => {
    const base: NoteResult = {
      id: 'a',
      specialty: 's1',
      counts: {
        conditions: { tp: 1, fp: 0, fn: 0 },
        medications: { tp: 0, fp: 0, fn: 0 },
        planItems: { tp: 1, fp: 1, fn: 0 },
      },
      hasPlanCorrect: true,
      modelItemCount: 4,
      quoteRejected: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.002,
      latencyMs: 100,
    };
    const summary = summarize([
      base,
      { ...base, id: 'b', specialty: 's2', quoteRejected: 0, latencyMs: 300, costUsd: 0.004 },
      {
        ...base,
        id: 'c',
        specialty: 's2',
        error: 'boom',
        hasPlanCorrect: false,
        modelItemCount: 0,
        quoteRejected: 0,
        costUsd: 0,
        latencyMs: 0,
      },
    ]);
    expect(summary.overall.hallucinatedQuoteRate).toBeCloseTo(1 / 8);
    expect(summary.overall.hasPlanAccuracy).toBeCloseTo(2 / 3);
    expect(summary.overall.errors).toBe(1);
    expect(summary.cost.totalUsd).toBeCloseTo(0.006);
    expect(summary.latencyMs).toEqual({ p50: 100, p95: 300 });
    expect(summary.bySpecialty.map((s) => [s.specialty, s.notes])).toEqual([
      ['s1', 1],
      ['s2', 2],
    ]);
  });

  it('runs tasks with bounded concurrency in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

async function evaluate(notes: readonly GoldNote[], respond: FakeResponder) {
  const gateway = createLlmGateway({
    providers: { fake: createFakeProvider({ respond }) },
    tasks: { [NOTE_EXTRACTION_TASK]: { route: [{ provider: 'fake', model: 'fake-extractor' }] } },
    usageLog: new InMemoryLlmUsageLog(),
  });
  return runExtractionEval({
    notes,
    extractor: createNoteExtractor({ gateway }),
    provider: 'fake',
    model: 'fake-extractor',
    promptVersion: NOTE_EXTRACTION_PROMPT_VERSION,
    clinicId: clinicId('clinic-eval'),
    now: () => new Date('2026-10-27T00:00:00Z'),
  });
}

describe('eval harness on the gold notes', () => {
  it('loads and validates the gold notes', async () => {
    const notes = await loadGoldNotes(GOLD_DIR);
    expect(notes.length).toBeGreaterThanOrEqual(6);
    const [first] = notes;
    if (!first) throw new Error('no gold notes');
    expect(goldAuthoredAt(first).toISOString()).toBe('2025-03-10T12:00:00.000Z');
    // Every expected quote is really in its note, or the gold set itself is wrong.
    for (const note of notes) {
      const quotes = [
        ...note.expected.conditions,
        ...note.expected.medications,
        ...note.expected.planItems,
      ].map((i) => i.evidenceQuote);
      for (const quote of quotes) expect(note.text, `${note.id}: ${quote}`).toContain(quote);
    }
  });

  it('scores 100% with an oracle that returns the gold answer', async () => {
    const notes = await loadGoldNotes(GOLD_DIR);
    const oracle = createNoteFixtureResponder(
      notes.map((n) => ({ text: n.text, output: modelOutputFromExpected(n.expected) })),
    );
    const run = await evaluate(notes, oracle);
    const { overall } = run.summary;
    expect(overall.errors).toBe(0);
    expect(overall.scores.conditions.f1).toBe(1);
    expect(overall.scores.medications.f1).toBe(1);
    expect(overall.scores.planItems.f1).toBe(1);
    expect(overall.hasPlanAccuracy).toBe(1);
    expect(overall.hallucinatedQuoteRate).toBe(0);
  });

  it('produces a Markdown report for the rule-based baseline', async () => {
    const notes = await loadGoldNotes(GOLD_DIR);
    const run = await evaluate(notes, heuristicResponder);
    const report = renderReport(run, '> baseline');
    expect(reportFileName(run)).toBe('2026-10-27-fake-fake-extractor.md');
    expect(report).toContain('# Note extraction eval: fake / fake-extractor');
    expect(report).toContain('Hallucinated-quote rate');
    expect(report).toContain('## By specialty');
    expect(report).toContain('| gold-llm-001 |');
  });

  it('scores a failing provider as misses instead of crashing', async () => {
    const notes = (await loadGoldNotes(GOLD_DIR)).slice(0, 2);
    const run = await evaluate(notes, () => undefined);
    expect(run.summary.overall.errors).toBe(2);
    expect(run.summary.overall.scores.conditions.recall).toBe(0);
    expect(run.results[0]?.error).toContain('No fake response');
  });
});

describe('fake provider', () => {
  it('answers from a map keyed by the request hash', async () => {
    const request = {
      model: 'fake-extractor',
      messages: [{ role: 'user' as const, content: 'hello' }],
      output: {
        name: 'x',
        schema: (await import('zod')).z.object({ a: (await import('zod')).z.number() }),
      },
    };
    const provider = createFakeProvider({ responses: { [fakeRequestKey(request)]: { a: 1 } } });
    await expect(provider.complete(request)).resolves.toMatchObject({
      output: { a: 1 },
      provider: 'fake',
    });
    expect(fakeRequestKey(request)).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      provider.complete({ ...request, messages: [{ role: 'user', content: 'other' }] }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
