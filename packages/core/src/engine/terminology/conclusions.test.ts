import { describe, expect, it } from 'vitest';
import { readConclusion } from './conclusions.ts';

describe('readConclusion', () => {
  it.each([
    [
      'BI-RADS 3. Hallazgo probablemente benigno; se sugiere control a corto plazo.',
      'birads_3',
      180,
    ],
    [
      'BI-RADS categoría 0: estudio incompleto, se requieren proyecciones adicionales.',
      'birads_0',
      30,
    ],
    ['BIRADS 4. Microcalcificaciones agrupadas, se sugiere biopsia.', 'birads_4', 14],
    ['BI-RADS 5: highly suggestive of malignancy.', 'birads_5', 14],
    [
      'Embarazo único activo. Biometría por debajo del percentil 10 para edad gestacional. Sugiere control.',
      'fetal_growth_below_p10',
      14,
    ],
    ['Peso fetal estimado en percentil <10. RCIU.', 'fetal_growth_below_p10', 14],
    [
      'Estimated fetal weight below the 10th percentile, consistent with FGR.',
      'fetal_growth_below_p10',
      14,
    ],
    ['Restricción del crecimiento intrauterino.', 'fetal_growth_below_p10', 14],
  ])('reads %s as abnormal with a follow-up study', (text, finding, days) => {
    expect(readConclusion(text)).toEqual({
      interpretation: 'abnormal',
      finding,
      followUpDays: days,
    });
  });

  it.each([
    'Nódulo hipoecoico con hallazgo sospechoso de malignidad.',
    'Suspicious mass in the left breast.',
  ])('reads %s as abnormal without a guideline interval', (text) => {
    expect(readConclusion(text)).toEqual({
      interpretation: 'abnormal',
      finding: 'suspicious_finding',
    });
  });

  it.each([
    ['BI-RADS 1. Negativo.', 'normal'],
    ['BI-RADS 2. Hallazgo benigno. Sin hallazgos sospechosos de malignidad.', 'normal'],
    ['Negativo para lesión intraepitelial o malignidad (NILM).', 'normal'],
    [
      'Embarazo único, intrauterino, activo. Biometría acorde a edad gestacional. Líquido amniótico normal.',
      'normal',
    ],
    ['No se observa restricción del crecimiento. Biometría acorde a edad gestacional.', 'normal'],
    ['Sin hallazgos sospechosos.', 'unknown'],
    ['Ver informe adjunto.', 'unknown'],
    ['', 'unknown'],
  ])('reads %s as %s', (text, interpretation) => {
    expect(readConclusion(text).interpretation).toBe(interpretation);
    expect(readConclusion(text).followUpDays).toBeUndefined();
  });

  it('takes the worst BI-RADS category of a bilateral report', () => {
    expect(readConclusion('Mama derecha BI-RADS 2. Mama izquierda BI-RADS 4.').finding).toBe(
      'birads_4',
    );
  });
});
