import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import { ICD10_SYSTEM, type ResourceRef } from '../../domain/resource.ts';
import { addDays } from '../support/time.ts';
import { LOINC_SYSTEM, loincConceptKey, resultValueAs } from '../terminology/loinc.ts';

/**
 * Gestational age from what the record says about a pregnancy: an estimated
 * delivery date (LOINC 11778-8), a last menstrual period (8665-2), a
 * gestational age at a date (11884-4, "embarazo de 20 semanas" read from a
 * note), or an ICD-10-CM weeks-of-gestation code (Z3A.20). Naegele's rule:
 * the delivery date is 280 days after the last menstrual period.
 */

/** Days from the last menstrual period to the estimated delivery date. */
export const PREGNANCY_DAYS = 280;

const MS_PER_DAY = 86_400_000;

/** What a dating fact is, most authoritative first when two share a date. */
export const DATING_BASES = [
  'estimated_delivery_date',
  'gestational_age',
  'gestational_weeks_code',
  'last_menstrual_period',
] as const;
export type DatingBasis = (typeof DATING_BASES)[number];

/** A pregnancy dated by one fact of the record. */
export interface PregnancyDating {
  readonly estimatedDeliveryDate: Date;
  readonly basis: DatingBasis;
  /** When the fact was recorded (the clinician's estimate at that time). */
  readonly recordedAt: Date;
  readonly source: ResourceRef;
}

/** Completed weeks and days of gestation. */
export interface GestationalAge {
  readonly weeks: number;
  readonly days: number;
  /** Days since the (estimated) last menstrual period. */
  readonly totalDays: number;
}

/** A gestational age outside this range is a typo, not a pregnancy. */
const MAX_GESTATIONAL_WEEKS = 45;

const GESTATIONAL_AGE_LOINC = { system: LOINC_SYSTEM, code: '11884-4' };

function plausibleWeeks(weeks: number): boolean {
  return Number.isFinite(weeks) && weeks >= 0 && weeks <= MAX_GESTATIONAL_WEEKS;
}

/** The delivery date of a pregnancy that is `weeks` along on `at`. */
function deliveryDateAt(at: Date, weeks: number): Date {
  return addDays(at, PREGNANCY_DAYS - Math.round(weeks * 7));
}

/** Weeks of an ICD-10-CM "weeks of gestation" code (`Z3A.20` is 20 weeks; `Z3A.0x` is undated). */
function weeksOfCode(code: string): number | undefined {
  const match = /^Z3A\.?(\d{2})$/i.exec(code.trim());
  const weeks = match?.[1] === undefined ? undefined : Number(match[1]);
  return weeks !== undefined && weeks >= 8 && weeks <= 42 ? weeks : undefined;
}

/** The pregnancy dating an event carries, if it carries a plausible one. */
export function datingOf(event: ClinicalEvent): PregnancyDating | undefined {
  const base = { recordedAt: event.occurredAt, source: event.source };
  if (event.type === 'condition.recorded' && event.code.system === ICD10_SYSTEM) {
    const weeks = weeksOfCode(event.code.code);
    return weeks === undefined
      ? undefined
      : {
          ...base,
          basis: 'gestational_weeks_code',
          estimatedDeliveryDate: deliveryDateAt(event.occurredAt, weeks),
        };
  }
  if (event.type !== 'result.received') {
    return undefined;
  }
  const at = event.occurredAt.getTime();
  switch (loincConceptKey(event.code)) {
    case 'estimated_delivery_date': {
      const edd = event.valueDate;
      // Due no more than 45 weeks ahead, or recorded up to 4 weeks after it (late entry).
      const plausible =
        edd !== undefined &&
        edd.getTime() <= at + MAX_GESTATIONAL_WEEKS * 7 * MS_PER_DAY &&
        edd.getTime() >= at - 28 * MS_PER_DAY;
      return plausible
        ? { ...base, basis: 'estimated_delivery_date', estimatedDeliveryDate: edd }
        : undefined;
    }
    case 'last_menstrual_period': {
      const lmp = event.valueDate;
      const plausible =
        lmp !== undefined &&
        lmp.getTime() <= at &&
        lmp.getTime() >= at - MAX_GESTATIONAL_WEEKS * 7 * MS_PER_DAY;
      return plausible
        ? {
            ...base,
            basis: 'last_menstrual_period',
            estimatedDeliveryDate: addDays(lmp, PREGNANCY_DAYS),
          }
        : undefined;
    }
    case 'gestational_age': {
      const weeks = resultValueAs(GESTATIONAL_AGE_LOINC, event);
      return weeks !== undefined && plausibleWeeks(weeks)
        ? {
            ...base,
            basis: 'gestational_age',
            estimatedDeliveryDate: deliveryDateAt(event.occurredAt, weeks),
          }
        : undefined;
    }
    case undefined:
    default:
      return undefined;
  }
}

/**
 * The current dating of a pregnancy: the latest dating fact recorded after
 * `since` (the end of the previous pregnancy), the clinician's latest
 * estimate (an ultrasound that corrects the dates replaces the LMP). For
 * facts recorded the same day, the most authoritative basis wins.
 */
export function currentDating(
  events: readonly ClinicalEvent[],
  since?: Date,
): PregnancyDating | undefined {
  let best: PregnancyDating | undefined;
  for (const event of events) {
    if (since !== undefined && event.occurredAt.getTime() <= since.getTime()) {
      continue;
    }
    const dating = datingOf(event);
    if (dating === undefined) {
      continue;
    }
    if (
      best === undefined ||
      dayOf(dating.recordedAt) > dayOf(best.recordedAt) ||
      (dayOf(dating.recordedAt) === dayOf(best.recordedAt) &&
        DATING_BASES.indexOf(dating.basis) <= DATING_BASES.indexOf(best.basis))
    ) {
      best = dating;
    }
  }
  return best;
}

function dayOf(date: Date): number {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

/** Gestational age on `at` (negative before the estimated last menstrual period). */
export function gestationalAgeAt(
  dating: Pick<PregnancyDating, 'estimatedDeliveryDate'>,
  at: Date,
): GestationalAge {
  const totalDays =
    PREGNANCY_DAYS -
    Math.ceil((dating.estimatedDeliveryDate.getTime() - at.getTime()) / MS_PER_DAY);
  return { weeks: Math.floor(totalDays / 7), days: ((totalDays % 7) + 7) % 7, totalDays };
}

/** The day the pregnancy reaches `week` weeks of gestation. */
export function dateAtGestationalWeek(
  dating: Pick<PregnancyDating, 'estimatedDeliveryDate'>,
  week: number,
): Date {
  return addDays(dating.estimatedDeliveryDate, week * 7 - PREGNANCY_DAYS);
}
