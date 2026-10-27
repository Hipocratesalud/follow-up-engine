import type { AlbuminuriaCategory, GfrCategory } from '../../config/protocol.ts';
import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { ICD10_SYSTEM } from '../../domain/resource.ts';
import { LOINC_SYSTEM, loincConceptKey, resultValueAs } from '../terminology/loinc.ts';

/**
 * Chronic kidney disease staging (KDIGO 2012): the GFR category from the
 * latest estimated GFR, the albuminuria category from the latest urine
 * albumin/creatinine ratio. A terminology-level fact; how often to monitor
 * each stage is the protocol's config.
 */

const EGFR = { system: LOINC_SYSTEM, code: '62238-1' };
const UACR = { system: LOINC_SYSTEM, code: '9318-7' };

/** KDIGO GFR category of an eGFR in mL/min/1.73 m2. */
export function gfrCategory(egfr: number): GfrCategory {
  if (egfr >= 90) return 'G1';
  if (egfr >= 60) return 'G2';
  if (egfr >= 45) return 'G3a';
  if (egfr >= 30) return 'G3b';
  if (egfr >= 15) return 'G4';
  return 'G5';
}

/** KDIGO albuminuria category of a urine albumin/creatinine ratio in mg/g. */
export function albuminuriaCategory(ratioMgPerG: number): AlbuminuriaCategory {
  if (ratioMgPerG < 30) return 'A1';
  if (ratioMgPerG <= 300) return 'A2';
  return 'A3';
}

/** A patient's CKD stage; a category is absent when nothing in the record gives it. */
export interface CkdStage {
  readonly gfr?: GfrCategory;
  readonly albuminuria?: AlbuminuriaCategory;
}

/** GFR category an ICD-10 N18 code states (`N18.3` is G3a, ICD-10-CM `N18.32` is G3b). */
export function gfrCategoryOfCode(code: string): GfrCategory | undefined {
  const normalized = code.replace('.', '').trim().toUpperCase();
  if (!normalized.startsWith('N18')) return undefined;
  switch (normalized.slice(3)) {
    case '1':
      return 'G1';
    case '2':
      return 'G2';
    case '3':
    case '30':
    case '31':
      return 'G3a';
    case '32':
      return 'G3b';
    case '4':
      return 'G4';
    case '5':
    case '6':
      return 'G5';
    default:
      return undefined;
  }
}

function latestValue(
  events: readonly ClinicalEvent[],
  concept: string,
  target: typeof EGFR,
): number | undefined {
  let latest: { readonly at: number; readonly value: number } | undefined;
  for (const event of events) {
    if (event.type !== 'result.received' || loincConceptKey(event.code) !== concept) {
      continue;
    }
    const value = resultValueAs(target, event);
    if (value !== undefined && (latest === undefined || event.occurredAt.getTime() >= latest.at)) {
      latest = { at: event.occurredAt.getTime(), value };
    }
  }
  return latest?.value;
}

/**
 * The patient's stage: categories from the latest eGFR and urine
 * albumin/creatinine ratio; without an eGFR, the GFR category a coded
 * N18 diagnosis states.
 */
export function ckdStage(
  events: readonly ClinicalEvent[],
  conditions: readonly PatientCondition[],
): CkdStage {
  const egfr = latestValue(events, 'egfr', EGFR);
  const ratio = latestValue(events, 'uacr', UACR);
  const coded = conditions
    .filter(
      (condition) =>
        (condition.status === 'confirmed' || condition.status === 'probable') &&
        condition.code.system === ICD10_SYSTEM,
    )
    .map((condition) => gfrCategoryOfCode(condition.code.code))
    .find((category) => category !== undefined);
  const gfr = egfr === undefined ? coded : gfrCategory(egfr);
  return {
    ...(gfr === undefined ? {} : { gfr }),
    ...(ratio === undefined ? {} : { albuminuria: albuminuriaCategory(ratio) }),
  };
}
