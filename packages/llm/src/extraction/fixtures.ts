import { PLAN_ITEM_KINDS } from '@follow-up-engine/core';
import { z } from 'zod';
import type { FakeResponder } from '../providers/fake.ts';
import { namedTests } from './lab-tests.ts';
import { readNoteFromMessages } from './prompt.ts';
import { REDACTION_PLACEHOLDER, defangTags } from './prepare.ts';
import { normalizeForMatch } from './quote.ts';
import { PREGNANCY_OUTCOME_KINDS, type ModelExtraction, type ModelPregnancy } from './schema.ts';

/**
 * The expected pregnancy reading of a note (gold `expected.pregnancy`):
 * dates as `YYYY-MM-DD`, the outcome dated by `date` or `daysAgo` when the
 * note writes it. Absent means the note reports no current pregnancy.
 */
export const ExpectedPregnancySchema = z.object({
  gestationalWeeks: z.number().optional(),
  gestationalDays: z.number().optional(),
  lastMenstrualPeriod: z.string().optional(),
  estimatedDeliveryDate: z.string().optional(),
  datingEvidenceQuote: z.string().optional(),
  outcome: z
    .object({
      kind: z.enum(PREGNANCY_OUTCOME_KINDS),
      date: z.string().optional(),
      daysAgo: z.number().optional(),
      evidenceQuote: z.string(),
    })
    .optional(),
});
export type ExpectedPregnancy = z.infer<typeof ExpectedPregnancySchema>;

/** The model reply for an expected pregnancy reading (`null` when there is none). */
export function modelPregnancyFromExpected(
  expected: ExpectedPregnancy | undefined,
): ModelPregnancy | null {
  if (expected === undefined) return null;
  return {
    gestationalWeeks: expected.gestationalWeeks ?? null,
    gestationalDays: expected.gestationalDays ?? null,
    lastMenstrualPeriod: expected.lastMenstrualPeriod ?? null,
    estimatedDeliveryDate: expected.estimatedDeliveryDate ?? null,
    datingEvidenceQuote: expected.datingEvidenceQuote ?? null,
    outcome:
      expected.outcome === undefined
        ? null
        : {
            kind: expected.outcome.kind,
            date: expected.outcome.date ?? null,
            daysAgo: expected.outcome.daysAgo ?? null,
            evidenceQuote: expected.outcome.evidenceQuote,
          },
  };
}

/**
 * The expected reading of a note, in the shared gold-note / scenario
 * fixture format (`expected` in `fixtures/gold-notes/*.json`, `llmFixture`
 * in scenarios). Plan timing is `dueInDays` relative to the note date.
 */
export const ExpectedExtractionSchema = z.object({
  hasPlan: z.boolean(),
  /** Present when the note discharges the patient ("se da de alta"). */
  discharge: z.object({ evidenceQuote: z.string() }).optional(),
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
  /** Present when the note dates a current pregnancy or reports its outcome. */
  pregnancy: ExpectedPregnancySchema.optional(),
});
export type ExpectedExtraction = z.infer<typeof ExpectedExtractionSchema>;

/**
 * What a perfect model would return for an expected extraction. Used to
 * script the fake provider in scenarios (`llmFixture`) and as the oracle
 * that checks the eval harness itself scores 100%.
 */
export function modelOutputFromExpected(expected: ExpectedExtraction): ModelExtraction {
  // Gold notes label one lab item per named test and may share one quote
  // ("control en 1 mes con creatinina y potasio"): the n-th item of a kind
  // with that quote describes the n-th test the quote names.
  const seen = new Map<string, number>();
  const describe = (p: ExpectedExtraction['planItems'][number]): string => {
    if (p.description !== undefined) return p.description;
    if (p.kind !== 'lab' && p.kind !== 'imaging') return p.kind.replaceAll('_', ' ');
    const key = `${p.kind}|${p.evidenceQuote}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const groups = [
      ...new Set(
        namedTests(normalizeForMatch(p.evidenceQuote))
          .filter((test) => test.group.kind === p.kind)
          .map((test) => test.group.label),
      ),
    ];
    return groups[nth] ?? p.kind;
  };
  return {
    hasPlan: expected.hasPlan,
    discharge: expected.discharge ? { evidenceQuote: expected.discharge.evidenceQuote } : null,
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
      description: describe(p),
      timing: { amount: p.dueInDays, unit: 'day', date: null },
      loincCode: null,
      evidenceQuote: p.evidenceQuote,
      confidence: p.confidence ?? 0.9,
    })),
    pregnancy: modelPregnancyFromExpected(expected.pregnancy),
  };
}

/**
 * A post-processed extraction as JSON (the scenario `llmFixture` format:
 * `NoteExtraction` with ISO `dueAt`). Extra fields are ignored.
 */
export const ExtractionFixtureSchema = z.object({
  hasPlan: z.boolean(),
  discharged: z.boolean().optional(),
  /** The note text that discharges the patient; a discharge without it cannot be verified and is dropped. */
  dischargeEvidenceQuote: z.string().optional(),
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
  /**
   * The pregnancy reading, dates as ISO strings. An outcome date or a
   * last menstrual period the note does not write is dropped by the
   * post-checks, like any other unsupported date.
   */
  pregnancy: z
    .object({
      gestationalWeeks: z.number().optional(),
      gestationalDays: z.number().optional(),
      lastMenstrualPeriod: z.string().optional(),
      estimatedDeliveryDate: z.string().optional(),
      datingEvidenceQuote: z.string().optional(),
      outcome: z
        .object({
          kind: z.enum(PREGNANCY_OUTCOME_KINDS),
          date: z.string().optional(),
          evidenceQuote: z.string(),
        })
        .optional(),
    })
    .optional(),
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
    discharge:
      fixture.discharged === true && fixture.dischargeEvidenceQuote !== undefined
        ? { evidenceQuote: fixture.dischargeEvidenceQuote }
        : null,
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
    pregnancy:
      fixture.pregnancy === undefined
        ? null
        : modelPregnancyFromExpected({
            ...fixture.pregnancy,
            ...(fixture.pregnancy.lastMenstrualPeriod === undefined
              ? {}
              : { lastMenstrualPeriod: fixture.pregnancy.lastMenstrualPeriod.slice(0, 10) }),
            ...(fixture.pregnancy.estimatedDeliveryDate === undefined
              ? {}
              : { estimatedDeliveryDate: fixture.pregnancy.estimatedDeliveryDate.slice(0, 10) }),
            ...(fixture.pregnancy.outcome === undefined
              ? {}
              : {
                  outcome: {
                    kind: fixture.pregnancy.outcome.kind,
                    evidenceQuote: fixture.pregnancy.outcome.evidenceQuote,
                    ...(fixture.pregnancy.outcome.date === undefined
                      ? {}
                      : { date: fixture.pregnancy.outcome.date.slice(0, 10) }),
                  },
                }),
          }),
  };
}

export interface NoteFixture {
  readonly text: string;
  readonly output: ModelExtraction;
}

/**
 * A fake-provider responder that answers extraction requests from fixtures,
 * matched by note text (whitespace and accent insensitive) as the model sees
 * it: delimiter-shaped tags neutralized, and each masked name or identifier
 * (`[REDACTADO]`) matching any text. Returns `undefined` for unknown notes so
 * it can be chained with another responder.
 */
export function createNoteFixtureResponder(fixtures: Iterable<NoteFixture>): FakeResponder {
  const byText = new Map<string, ModelExtraction>();
  for (const fixture of fixtures) {
    byText.set(normalizeForMatch(defangTags(fixture.text)), fixture.output);
  }
  const placeholder = normalizeForMatch(REDACTION_PLACEHOLDER);
  return (request) => {
    const note = readNoteFromMessages(request.messages);
    if (note === undefined) return undefined;
    const key = normalizeForMatch(note);
    const exact = byText.get(key);
    if (exact !== undefined || !key.includes(placeholder)) return exact;
    const parts = key.split(placeholder);
    for (const [text, output] of byText) {
      if (matchesInOrder(text, parts)) return output;
    }
    return undefined;
  };
}

/** Whether `text` is `parts` joined by arbitrary non-empty text (a masked span each). */
function matchesInOrder(text: string, parts: readonly string[]): boolean {
  const first = parts[0] ?? '';
  const last = parts.at(-1) ?? '';
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at + 1);
    if (found < 0) return false;
    at = found + part.length;
  }
  return text.length - last.length > at;
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
