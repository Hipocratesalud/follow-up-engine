import { describe, expect, it } from 'vitest';
import { findQuote, segmentByQuotes } from './highlight.ts';

const NOTE =
  'HbA1c previa 8,4 %. Plan: control en 3 meses con HbA1c y perfil lipídico. Referir a oftalmología.';

describe('findQuote', () => {
  it('splits the text around a verbatim quote', () => {
    const match = findQuote(NOTE, 'control en 3 meses con HbA1c y perfil lipídico');
    expect(match).toEqual({
      before: 'HbA1c previa 8,4 %. Plan: ',
      match: 'control en 3 meses con HbA1c y perfil lipídico',
      after: '. Referir a oftalmología.',
    });
  });

  it('tolerates re-flowed whitespace and case, returning the text as written', () => {
    const match = findQuote(NOTE, 'Control en 3  meses\ncon hba1c');
    expect(match?.match).toBe('control en 3 meses con HbA1c');
  });

  it('returns undefined when the quote is not in the excerpt', () => {
    expect(findQuote(NOTE, 'ecocardiograma')).toBeUndefined();
    expect(findQuote(NOTE, '   ')).toBeUndefined();
  });
});

describe('segmentByQuotes', () => {
  it('marks every quote and keeps the rest as plain text, in order', () => {
    const segments = segmentByQuotes(NOTE, ['Referir a oftalmología', 'control en 3 meses']);
    expect(segments.map((segment) => segment.text).join('')).toBe(NOTE);
    expect(segments.filter((segment) => segment.quoteIndex !== undefined)).toEqual([
      { text: 'control en 3 meses', quoteIndex: 1 },
      { text: 'Referir a oftalmología', quoteIndex: 0 },
    ]);
  });

  it('drops a quote that overlaps an earlier one', () => {
    const segments = segmentByQuotes(NOTE, ['control en 3 meses con HbA1c', 'HbA1c y perfil']);
    expect(segments.filter((segment) => segment.quoteIndex !== undefined)).toHaveLength(1);
  });
});
