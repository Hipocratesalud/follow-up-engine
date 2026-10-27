import { describe, expect, it } from 'vitest';
import { EXAMPLE_NOTES } from '../features/demo/example-notes.ts';
import { extractFromNote, parseDueInDays } from './extraction.ts';

const AUTHORED_AT = new Date('2026-10-27T13:00:00.000Z');

function example(id: string): string {
  const note = EXAMPLE_NOTES.find((candidate) => candidate.id === id);
  if (!note) throw new Error(`missing example ${id}`);
  return note.noteText;
}

describe('parseDueInDays', () => {
  it.each([
    ['control en 3 meses', 90],
    ['próxima sesión en 1 semana', 7],
    ['en dos semanas', 14],
    ['en 10 días', 10],
    ['durante 10 semanas', undefined],
  ])('%s → %s', (clause, days) => {
    expect(parseDueInDays(clause)).toBe(days);
  });
});

describe('extractFromNote', () => {
  it('reads the plan of the diabetes example with verbatim quotes and resolved dates', () => {
    const text = example('diabetes-plan');
    const extraction = extractFromNote(text, AUTHORED_AT);

    expect(extraction.hasPlan).toBe(true);
    expect(extraction.planItems.map((item) => item.kind)).toEqual(['follow_up_visit', 'lab']);
    expect(extraction.planItems[0]?.dueAt).toBe('2027-01-25T13:00:00.000Z');
    expect(extraction.conditions.map((condition) => condition.code.code)).toEqual(['E11', 'I10']);
    expect(
      extraction.medications.find((med) => med.text.startsWith('sitagliptina'))?.durationDays,
    ).toBe(90);
    const quotes = [
      ...extraction.planItems.map((item) => item.evidenceQuote),
      ...extraction.conditions.map((item) => item.evidenceQuote),
      ...extraction.medications.map((item) => item.evidenceQuote),
    ];
    for (const quote of quotes) expect(text).toContain(quote);
  });

  it('turns weekly sessions into a 7-day expectation', () => {
    const extraction = extractFromNote(example('psychology-plan'), AUTHORED_AT);
    expect(extraction.planItems[0]).toMatchObject({
      kind: 'session',
      evidenceQuote: 'sesiones semanales durante 10 semanas',
      dueAt: '2026-11-03T13:00:00.000Z',
    });
  });

  it('reports a note without a plan', () => {
    const extraction = extractFromNote(example('gynecology-no-plan'), AUTHORED_AT);
    expect(extraction.hasPlan).toBe(false);
    expect(extraction.planItems).toEqual([]);
    expect(extraction.conditions[0]?.code.code).toBe('D25.1');
  });
});
