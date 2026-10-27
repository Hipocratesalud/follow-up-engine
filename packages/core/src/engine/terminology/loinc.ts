import type { ResultReceivedEvent } from '../../domain/clinical-event.ts';
import type { Coding } from '../../domain/resource.ts';
import { sameCoding } from '../matching/match-key.ts';

/**
 * LOINC equivalence: codes that report the same measurement (HbA1c by HPLC,
 * by immunoassay or IFCC in mmol/mol) and lab panels with their components
 * (a lipid panel arrives as total cholesterol, HDL, LDL and triglyceride
 * results). A terminology fact, not a clinical policy: which results a rule
 * or protocol accepts is still its own config.
 */

export const LOINC_SYSTEM = 'http://loinc.org';

/** `canonical = factor * value + offset`, from a unit to its concept's canonical unit. */
interface UnitConversion {
  readonly unit: string;
  readonly factor: number;
  readonly offset: number;
}

/** One measurement, whatever the method code it is reported under. */
interface LoincConcept {
  readonly key: string;
  /** LOINC codes of the concept, each with the unit it is reported in. */
  readonly codes: readonly { readonly code: string; readonly unit: string }[];
  readonly canonicalUnit: string;
  /** Units other than the canonical one, with their conversion. */
  readonly conversions?: readonly UnitConversion[];
}

/** A panel: its own codes, and the concepts a result of any of them reports. */
interface LoincPanel {
  readonly key: string;
  readonly codes: readonly string[];
  readonly components: readonly string[];
}

const CONCEPTS: readonly LoincConcept[] = [
  {
    key: 'hba1c',
    codes: [
      { code: '4548-4', unit: '%' },
      { code: '17856-6', unit: '%' },
      { code: '4549-2', unit: '%' },
      { code: '62388-4', unit: '%' },
      { code: '59261-8', unit: 'mmol/mol' },
    ],
    canonicalUnit: '%',
    // IFCC-NGSP master equation: NGSP % = 0.0915 * IFCC mmol/mol + 2.15.
    conversions: [{ unit: 'mmol/mol', factor: 0.0915, offset: 2.15 }],
  },
  {
    key: 'cholesterol_total',
    codes: [{ code: '2093-3', unit: 'mg/dL' }],
    canonicalUnit: 'mg/dL',
  },
  { key: 'hdl', codes: [{ code: '2085-9', unit: 'mg/dL' }], canonicalUnit: 'mg/dL' },
  {
    key: 'ldl',
    codes: [
      { code: '13457-7', unit: 'mg/dL' },
      { code: '18262-6', unit: 'mg/dL' },
      { code: '2089-1', unit: 'mg/dL' },
    ],
    canonicalUnit: 'mg/dL',
  },
  { key: 'triglycerides', codes: [{ code: '2571-8', unit: 'mg/dL' }], canonicalUnit: 'mg/dL' },
  {
    key: 'creatinine',
    codes: [
      { code: '2160-0', unit: 'mg/dL' },
      { code: '38483-4', unit: 'mg/dL' },
      { code: '14682-9', unit: 'umol/L' },
    ],
    canonicalUnit: 'mg/dL',
    // 1 mg/dL of creatinine is 88.42 umol/L.
    conversions: [{ unit: 'umol/L', factor: 1 / 88.42, offset: 0 }],
  },
  {
    // Estimated GFR by any creatinine (or cystatin) equation: MDRD, CKD-EPI 2009 and 2021.
    key: 'egfr',
    codes: [
      { code: '33914-3', unit: 'mL/min/{1.73_m2}' },
      { code: '48642-3', unit: 'mL/min/{1.73_m2}' },
      { code: '48643-1', unit: 'mL/min/{1.73_m2}' },
      { code: '62238-1', unit: 'mL/min/{1.73_m2}' },
      { code: '77147-7', unit: 'mL/min/{1.73_m2}' },
      { code: '88293-6', unit: 'mL/min/{1.73_m2}' },
      { code: '88294-4', unit: 'mL/min/{1.73_m2}' },
      { code: '98979-8', unit: 'mL/min/{1.73_m2}' },
    ],
    canonicalUnit: 'mL/min/{1.73_m2}',
  },
  {
    // Urine albumin/creatinine ratio (KDIGO albuminuria category).
    key: 'uacr',
    codes: [
      { code: '9318-7', unit: 'mg/g' },
      { code: '14959-1', unit: 'mg/g' },
      { code: '32294-1', unit: 'mg/g' },
      { code: '13705-9', unit: 'mg/g' },
    ],
    canonicalUnit: 'mg/g',
    // 1 mg/mmol is 8.84 mg/g.
    conversions: [{ unit: 'mg/mmol', factor: 8.84, offset: 0 }],
  },
  {
    key: 'tsh',
    codes: [
      { code: '3016-3', unit: 'm[IU]/L' },
      { code: '11580-8', unit: 'm[IU]/L' },
      { code: '11579-0', unit: 'm[IU]/L' },
    ],
    canonicalUnit: 'm[IU]/L',
    // uIU/mL is numerically mIU/L.
    conversions: [{ unit: 'u[IU]/mL', factor: 1, offset: 0 }],
  },
  {
    // Gestational age, in weeks (estimated, from the LMP, by ultrasound).
    key: 'gestational_age',
    codes: [
      { code: '11884-4', unit: 'wk' },
      { code: '11885-1', unit: 'wk' },
      { code: '18185-9', unit: 'wk' },
      { code: '49051-6', unit: 'wk' },
    ],
    canonicalUnit: 'wk',
    conversions: [
      ...['wks', 'week', 'weeks', 'sem', 'semana', 'semanas'].map((unit) => ({
        unit,
        factor: 1,
        offset: 0,
      })),
      ...['d', 'day', 'days', 'dia', 'dias', 'día', 'días'].map((unit) => ({
        unit,
        factor: 1 / 7,
        offset: 0,
      })),
    ],
  },
  {
    // Estimated date of delivery (a date value): overall, from the LMP, from ovulation.
    key: 'estimated_delivery_date',
    codes: [
      { code: '11778-8', unit: 'date' },
      { code: '11779-6', unit: 'date' },
      { code: '11780-4', unit: 'date' },
    ],
    canonicalUnit: 'date',
  },
  {
    key: 'last_menstrual_period',
    codes: [{ code: '8665-2', unit: 'date' }],
    canonicalUnit: 'date',
  },
];

const PANELS: readonly LoincPanel[] = [
  {
    key: 'lipid_panel',
    codes: ['24331-1', '57698-3', '57696-7'],
    components: ['cholesterol_total', 'hdl', 'ldl', 'triglycerides'],
  },
  {
    // Glucose challenge and tolerance tests used to screen for gestational
    // diabetes: 1 h after 50 g, 2 h after 75 g, 2 h after a dose.
    key: 'glucose_tolerance',
    codes: ['1504-0', '1518-0', '20436-2'],
    components: [],
  },
];

/** Key of the measurement or panel a LOINC code reports (`egfr`, `lipid_panel`), if the table knows it. */
export function loincConceptKey(coding: Pick<Coding, 'system' | 'code'>): string | undefined {
  return conceptOf(coding)?.key ?? panelOf(coding)?.key;
}

function isLoinc(coding: Pick<Coding, 'system'>): boolean {
  return coding.system === LOINC_SYSTEM;
}

function conceptOf(coding: Pick<Coding, 'system' | 'code'>): LoincConcept | undefined {
  return isLoinc(coding)
    ? CONCEPTS.find((concept) => concept.codes.some((entry) => entry.code === coding.code))
    : undefined;
}

function panelOf(coding: Pick<Coding, 'system' | 'code'>): LoincPanel | undefined {
  return isLoinc(coding) ? PANELS.find((panel) => panel.codes.includes(coding.code)) : undefined;
}

/** The same code, or two LOINC codes of the same measurement (HbA1c 4548-4 and 59261-8). */
export function sameConcept(
  left: Pick<Coding, 'system' | 'code'>,
  right: Pick<Coding, 'system' | 'code'>,
): boolean {
  if (sameCoding(left, right)) {
    return true;
  }
  const concept = conceptOf(left);
  if (concept !== undefined) {
    return concept === conceptOf(right);
  }
  const panel = panelOf(left);
  return panel !== undefined && panel === panelOf(right);
}

/**
 * Whether a result coded `result` answers a request (an order, a plan item)
 * for `requested`: the same measurement under any of its codes, a component
 * of the requested panel, or a panel that includes the requested component.
 * An HDL result does not answer an LDL order.
 */
export function resultAnswers(
  result: Pick<Coding, 'system' | 'code'>,
  requested: Pick<Coding, 'system' | 'code'>,
): boolean {
  if (sameConcept(result, requested)) {
    return true;
  }
  const requestedPanel = panelOf(requested);
  const resultConcept = conceptOf(result);
  if (requestedPanel !== undefined && resultConcept !== undefined) {
    return requestedPanel.components.includes(resultConcept.key);
  }
  const resultPanel = panelOf(result);
  const requestedConcept = conceptOf(requested);
  return (
    resultPanel !== undefined &&
    requestedConcept !== undefined &&
    resultPanel.components.includes(requestedConcept.key)
  );
}

/** `%`, `mmol/mol`, `mg/dL` as labs write them (`% Hb`, `mmol/mol Hb`, `mg/dl`). */
function normalizeUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/\s+hb$/, '')
    .replace(/\s+/g, '')
    .replace(/[[\]{}_]/g, '')
    .replace(/,/g, '.')
    .replace(/^[µμ]/u, 'u')
    .replace(/ui/g, 'iu');
}

function toCanonical(concept: LoincConcept, value: number, unit: string): number | undefined {
  const normalized = normalizeUnit(unit);
  if (normalized === normalizeUnit(concept.canonicalUnit)) {
    return value;
  }
  const conversion = concept.conversions?.find(
    (candidate) => normalizeUnit(candidate.unit) === normalized,
  );
  return conversion === undefined ? undefined : conversion.factor * value + conversion.offset;
}

function fromCanonical(concept: LoincConcept, value: number, unit: string): number | undefined {
  const normalized = normalizeUnit(unit);
  if (normalized === normalizeUnit(concept.canonicalUnit)) {
    return value;
  }
  const conversion = concept.conversions?.find(
    (candidate) => normalizeUnit(candidate.unit) === normalized,
  );
  return conversion === undefined ? undefined : (value - conversion.offset) / conversion.factor;
}

/**
 * The value of a result expressed as `target` (code and its unit): an IFCC
 * HbA1c of 53 mmol/mol is 7.0 when read as LOINC 4548-4 (%). `undefined`
 * when the result has no value, is not the same measurement or its unit
 * cannot be converted. The result's own unit wins over its code's usual one.
 */
export function resultValueAs(
  target: Pick<Coding, 'system' | 'code'>,
  result: Pick<ResultReceivedEvent, 'code' | 'value'>,
): number | undefined {
  const value = result.value?.value;
  if (value === undefined || !sameConcept(result.code, target)) {
    return undefined;
  }
  const concept = conceptOf(target);
  if (concept === undefined) {
    return value;
  }
  const resultUnit =
    result.value?.unit ?? concept.codes.find((entry) => entry.code === result.code.code)?.unit;
  const targetUnit = concept.codes.find((entry) => entry.code === target.code)?.unit;
  if (
    resultUnit === undefined ||
    targetUnit === undefined ||
    normalizeUnit(resultUnit) === normalizeUnit(targetUnit)
  ) {
    return value;
  }
  const canonical = toCanonical(concept, value, resultUnit);
  return canonical === undefined ? undefined : fromCanonical(concept, canonical, targetUnit);
}

/** Every LOINC code of the measurement or panel of `coding` (itself included). */
export function equivalentCodes(coding: Pick<Coding, 'system' | 'code'>): string[] {
  const concept = conceptOf(coding);
  if (concept !== undefined) {
    return concept.codes.map((entry) => entry.code);
  }
  return panelOf(coding)?.codes.slice() ?? [coding.code];
}
