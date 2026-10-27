import { BASE_DATE } from '../constants.ts';
import type { FollowUp } from './notes.ts';
import type { Prng } from './prng.ts';
import type { PatientTimeline } from './timeline.ts';

/**
 * Shared building blocks of the synthetic patients' histories: the
 * per-patient generation context, office-hours visit times, and booking
 * the next visit.
 */

/** History starts two years before the base date. */
export const HISTORY_DAYS = 730;
export const MS_PER_DAY = 86_400_000;

/** Probability that a routine note has no plan section. */
export const NO_PLAN_RATE = 0.22;

export interface Context {
  readonly rng: Prng;
  readonly timeline: PatientTimeline;
  readonly sex: 'female' | 'male';
  readonly birthDate: Date;
  /** Usual weight, so notes of the same patient stay consistent. */
  readonly weightKg: number;
  /** Previous pregnancies. */
  readonly gravida: number;
  readonly stats: { consultations: number; withoutPlan: number };
}

/** Age in whole years on `date`. */
export function ageAt(ctx: Context, date: Date): number {
  const birth = ctx.birthDate;
  let age = date.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    date.getUTCMonth() < birth.getUTCMonth() ||
    (date.getUTCMonth() === birth.getUTCMonth() && date.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** A weekday office-hours instant `day` days after the base date (local UTC-4, 08:00 to 16:45). */
export function visitTime(rng: Prng, day: number): Date {
  let date = new Date(BASE_DATE.getTime() + Math.round(day) * MS_PER_DAY);
  const weekday = date.getUTCDay();
  if (weekday === 6) date = new Date(date.getTime() + 2 * MS_PER_DAY);
  if (weekday === 0) date = new Date(date.getTime() + MS_PER_DAY);
  date.setUTCHours(rng.int(12, 20), rng.pick([0, 15, 30, 45]), 0, 0);
  return date;
}

export const dayOf = (date: Date): number => (date.getTime() - BASE_DATE.getTime()) / MS_PER_DAY;
export const plusDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * MS_PER_DAY);

export function maybePlan(
  ctx: Context,
  followUp: FollowUp,
  noPlanRate = NO_PLAN_RATE,
): FollowUp | undefined {
  return ctx.rng.chance(noPlanRate) ? undefined : followUp;
}

/** Counts a consultation; `hasPlan` is false when its note has no follow-up plan. */
export function record(ctx: Context, hasPlan: boolean): void {
  ctx.stats.consultations += 1;
  if (!hasPlan) ctx.stats.withoutPlan += 1;
}

export interface Visit {
  readonly start: Date;
  readonly appointmentId?: string;
}

/**
 * Books the next visit at the end of a consultation (when the patient
 * leaves with a plan) and, when the patient will not show up, sometimes
 * cancels it. Returns the next visit, or undefined when it will not happen.
 */
export function scheduleNext(
  ctx: Context,
  end: Date,
  nextDay: number,
  options: {
    readonly booked: boolean;
    readonly attends: boolean;
    readonly minutes: number;
    readonly description: string;
  },
): Visit | undefined {
  const start = visitTime(ctx.rng, nextDay);
  let appointmentId: string | undefined;
  if (options.booked) {
    appointmentId = ctx.timeline.book(
      plusDays(end, 10 / 1440),
      start,
      options.minutes,
      options.description,
    );
    if (!options.attends && ctx.rng.chance(0.5)) {
      const cancelAt = plusDays(start, -ctx.rng.int(1, 4));
      if (cancelAt <= BASE_DATE && cancelAt > end) {
        ctx.timeline.cancel(
          appointmentId,
          cancelAt,
          plusDays(end, 10 / 1440),
          start,
          options.minutes,
          options.description,
        );
      }
    }
  }
  if (!options.attends || start > BASE_DATE) return undefined;
  return { start, ...(appointmentId ? { appointmentId } : {}) };
}
