import { describe, expect, it } from 'vitest';
import { TEST_GROUPS, testGroupOfLoinc, testGroupsIn } from './lab-tests.ts';
import { isValidLoinc } from './post-process.ts';
import { normalizeForMatch } from './quote.ts';

describe('test lexicon', () => {
  it('has well-formed LOINC codes, each in one group', () => {
    const codes = TEST_GROUPS.flatMap((group) => group.loinc);
    expect(codes.filter((code) => !isValidLoinc(code))).toEqual([]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(testGroupOfLoinc('7918-6')?.id).toBe('hiv');
  });

  it('reads Spanish test names and English descriptions alike', () => {
    const read = (text: string) => [...testGroupsIn(normalizeForMatch(text))];
    expect(read('perfil lipídico y microalbuminuria antes de la próxima consulta')).toEqual([
      'lipids',
      'urine_albumin',
    ]);
    expect(read('Repetir hemoglobina glicosilada en 3 meses')).toEqual(['hba1c']);
    expect(read('microalbuminuria en orina de 24 h')).toEqual(['urine_albumin']);
    expect(read('HIV-1 and HIV-2 antibody test')).toEqual(['hiv']);
    expect(read('Control en 3 meses')).toEqual([]);
  });
});
