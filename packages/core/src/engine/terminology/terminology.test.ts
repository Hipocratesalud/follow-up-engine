import { describe, expect, it } from 'vitest';
import { atcCodeOf, atcCodeOfName } from './atc.ts';
import { LOINC_SYSTEM, resultAnswers, resultValueAs, sameConcept } from './loinc.ts';

const loinc = (code: string) => ({ system: LOINC_SYSTEM, code });

describe('LOINC equivalence', () => {
  it('treats every HbA1c method code as the same measurement', () => {
    expect(sameConcept(loinc('17856-6'), loinc('4548-4'))).toBe(true);
    expect(sameConcept(loinc('59261-8'), loinc('4548-4'))).toBe(true);
    expect(sameConcept(loinc('2085-9'), loinc('13457-7'))).toBe(false);
    expect(sameConcept({ system: 'urn:other', code: '4548-4' }, loinc('4548-4'))).toBe(false);
  });

  it('answers a panel request with its components and a component request with the panel', () => {
    expect(resultAnswers(loinc('2085-9'), loinc('57698-3'))).toBe(true);
    expect(resultAnswers(loinc('24331-1'), loinc('13457-7'))).toBe(true);
    expect(resultAnswers(loinc('18262-6'), loinc('13457-7'))).toBe(true);
    expect(resultAnswers(loinc('2085-9'), loinc('13457-7'))).toBe(false);
    expect(resultAnswers(loinc('4548-4'), loinc('57698-3'))).toBe(false);
  });

  it('converts an IFCC HbA1c in mmol/mol to the NGSP % of the target code', () => {
    const ifcc = (value: number, unit?: string) => ({
      code: loinc('59261-8'),
      value: unit === undefined ? { value } : { value, unit },
    });
    expect(resultValueAs(loinc('4548-4'), ifcc(53, 'mmol/mol'))).toBeCloseTo(7.0, 1);
    expect(resultValueAs(loinc('4548-4'), ifcc(64))).toBeCloseTo(8.0, 1);
    expect(resultValueAs(loinc('59261-8'), ifcc(53, 'mmol/mol'))).toBe(53);
    expect(
      resultValueAs(loinc('59261-8'), { code: loinc('4548-4'), value: { value: 7, unit: '%' } }),
    ).toBeCloseTo(53, 0);
    expect(resultValueAs(loinc('4548-4'), ifcc(53, 'g/L'))).toBeUndefined();
    expect(
      resultValueAs(loinc('4548-4'), { code: loinc('2085-9'), value: { value: 5, unit: '%' } }),
    ).toBeUndefined();
  });
});

describe('ATC classification by name', () => {
  it('maps Spanish and INN names, accents ignored, at the start of a word', () => {
    expect(atcCodeOfName('Apixabán 5 mg')).toBe('B01AF02');
    expect(atcCodeOfName('Losartán/Hidroclorotiazida 50/12,5 mg')).toBe('C09CA01');
    expect(atcCodeOfName('Amoxicilina + ácido clavulánico 875 mg')).toBe('J01CA04');
    expect(atcCodeOfName('Fármaco sintético X')).toBeUndefined();
  });

  it('tells low-dose aspirin (antiplatelet) from analgesic aspirin', () => {
    expect(atcCodeOfName('Ácido acetilsalicílico 100 mg')).toBe('B01AC06');
    expect(atcCodeOfName('Aspirina 500 mg')).toBe('N02BA01');
  });

  it('tells an inhaled corticosteroid from its nasal spray', () => {
    expect(atcCodeOfName('Budesonida 200 mcg inhalador')).toBe('R03BA02');
    expect(atcCodeOfName('Budesonida spray nasal')).toBe('R01AD05');
  });

  it('prefers the prescription’s own ATC code, else reads the name', () => {
    expect(
      atcCodeOf({
        text: 'Clopidogrel',
        code: { system: 'http://www.whocc.no/atc', code: 'b01ac04' },
      }),
    ).toBe('B01AC04');
    expect(
      atcCodeOf({
        text: 'Clopidogrel 75 mg',
        code: { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '309362' },
      }),
    ).toBe('B01AC04');
  });
});
