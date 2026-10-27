import { PLAN_ITEM_KINDS } from '@follow-up-engine/core';
import { z } from 'zod';
import type { FakeResponder } from '../providers/fake.ts';
import { readNoteFromMessages } from './prompt.ts';
import { normalizeForMatch } from './quote.ts';
import type { ModelExtraction } from './schema.ts';

/**
 * The expected reading of a note, in the shared gold-note / scenario
 * fixture format (`expected` in `fixtures/gold-notes/*.json`, `llmFixture`
 * in scenarios). Plan timing is `dueInDays` relative to the note date.
 */
export const ExpectedExtractionSchema = z.object({
  hasPlan: z.boolean(),
  conditions: z.array(
    z.object({
      icd10: z.string(),
      evidenceQuote: z.string(),
      display: z.string().optional(),
      confidence: z.number().optional(),
    }),
  ),
  medications: z.array(
    z.object({
      text: z.string(),
      evidenceQuote: z.string(),
      durationDays: z.number().optional(),
    }),
  ),
  planItems: z.array(
    z.object({
      kind: z.enum(PLAN_ITEM_KINDS),
      dueInDays: z.number(),
      evidenceQuote: z.string(),
      description: z.string().optional(),
      confidence: z.number().optional(),
    }),
  ),
});
export type ExpectedExtraction = z.infer<typeof ExpectedExtractionSchema>;

/**
 * What a perfect model would return for an expected extraction. Used to
 * script the fake provider in scenarios (`llmFixture`) and as the oracle
 * that checks the eval harness itself scores 100%.
 */
export function modelOutputFromExpected(expected: ExpectedExtraction): ModelExtraction {
  return {
    hasPlan: expected.hasPlan,
    conditions: expected.conditions.map((c) => ({
      icd10: c.icd10,
      display: c.display ?? '',
      confidence: c.confidence ?? 0.9,
      evidenceQuote: c.evidenceQuote,
    })),
    medications: expected.medications.map((m) => ({
      text: m.text,
      duration: m.durationDays === undefined ? null : { amount: m.durationDays, unit: 'day' },
      evidenceQuote: m.evidenceQuote,
    })),
    planItems: expected.planItems.map((p) => ({
      kind: p.kind,
      description: p.description ?? p.kind.replaceAll('_', ' '),
      timing: { amount: p.dueInDays, unit: 'day', date: null },
      loincCode: null,
      evidenceQuote: p.evidenceQuote,
      confidence: p.confidence ?? 0.9,
    })),
  };
}

/**
 * A post-processed extraction as JSON (the scenario `llmFixture` format:
 * `NoteExtraction` with ISO `dueAt`). Extra fields are ignored.
 */
export const ExtractionFixtureSchema = z.object({
  hasPlan: z.boolean(),
  conditions: z.array(
    z.object({
      code: z.object({ code: z.string(), display: z.string().optional() }),
      confidence: z.number(),
      evidenceQuote: z.string(),
    }),
  ),
  medications: z.array(
    z.object({ text: z.string(), durationDays: z.number().optional(), evidenceQuote: z.string() }),
  ),
  planItems: z.array(
    z.object({
      kind: z.enum(PLAN_ITEM_KINDS),
      description: z.string(),
      dueAt: z.string(),
      evidenceQuote: z.string(),
      confidence: z.number(),
      code: z.object({ system: z.string(), code: z.string() }).optional(),
    }),
  ),
});
export type ExtractionFixture = z.infer<typeof ExtractionFixtureSchema>;

/**
 * The model reply that the extractor turns back into `fixture`: due dates
 * become explicit calendar dates (resolved to noon UTC, the fixture
 * convention), LOINC codes on lab items are kept. Lets scenarios run the
 * real gateway and post-checks with the fake provider.
 */
export function modelOutputFromExtraction(fixture: ExtractionFixture): ModelExtraction {
  return {
    hasPlan: fixture.hasPlan,
    conditions: fixture.conditions.map((c) => ({
      icd10: c.code.code,
      display: c.code.display ?? '',
      confidence: c.confidence,
      evidenceQuote: c.evidenceQuote,
    })),
    medications: fixture.medications.map((m) => ({
      text: m.text,
      duration: m.durationDays === undefined ? null : { amount: m.durationDays, unit: 'day' },
      evidenceQuote: m.evidenceQuote,
    })),
    planItems: fixture.planItems.map((p) => ({
      kind: p.kind,
      description: p.description,
      timing: { amount: null, unit: null, date: p.dueAt.slice(0, 10) },
      loincCode: p.code?.system === 'http://loinc.org' ? p.code.code : null,
      evidenceQuote: p.evidenceQuote,
      confidence: p.confidence,
    })),
  };
}

export interface NoteFixture {
  readonly text: string;
  readonly output: ModelExtraction;
}

/**
 * A fake-provider responder that answers extraction requests from fixtures,
 * matched by note text (whitespace and accent insensitive). Returns
 * `undefined` for unknown notes so it can be chained with another responder.
 */
export function createNoteFixtureResponder(fixtures: Iterable<NoteFixture>): FakeResponder {
  const byText = new Map<string, ModelExtraction>();
  for (const fixture of fixtures) byText.set(normalizeForMatch(fixture.text), fixture.output);
  return (request) => {
    const note = readNoteFromMessages(request.messages);
    return note === undefined ? undefined : byText.get(normalizeForMatch(note));
  };
}

/** Tries responders in order and returns the first defined reply. */
export function chainResponders(...responders: readonly FakeResponder[]): FakeResponder {
  return (request) => {
    for (const responder of responders) {
      const reply = responder(request);
      if (reply !== undefined) return reply;
    }
    return undefined;
  };
}
