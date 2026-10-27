import { describe, expect, it } from 'vitest';
import { reviewLocaleOf } from './runtime.ts';

describe('reviewer language of a clinic', () => {
  it('writes findings in the language of the clinic locale, English otherwise', () => {
    expect(reviewLocaleOf('es-VE')).toBe('es');
    expect(reviewLocaleOf('en-US')).toBe('en');
    expect(reviewLocaleOf('pt-BR')).toBe('en');
    expect(reviewLocaleOf(undefined)).toBe('en');
  });
});
