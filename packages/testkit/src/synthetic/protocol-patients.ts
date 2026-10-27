import { BASE_DATE } from '../constants.ts';
import {
  CONDITIONS,
  type ConditionDefinition,
  MEDICATIONS,
  type MedicationDefinition,
  type OrderDefinition,
  ORDERS,
} from './catalog.ts';
import { type DateFact, isoDate } from './fhir-builders.ts';
import { type FollowUp, psychologyNote } from './notes.ts';
import {
  antidepressantNote,
  deliveryVisitNote,
  kidneyNote,
  type LipidValues,
  lipidNote,
  miscarriageNote,
  postLossNote,
  type PregnancyDatingSource,
  prenatalNote,
  puerperalControlNote,
  thyroidNote,
} from './protocol-notes.ts';
import type { ConsultationRecord, ConsultationSpec, Provider } from './timeline.ts';
import {
  ageAt,
  type Context,
  dayOf,
  maybePlan,
  MS_PER_DAY,
  plusDays,
  record,
  type Visit,
  visitTime,
} from './visits.ts';

/**
 * Patients that exercise the care protocols added after the first demo
 * (pregnancy, treatment follow-up, hypothyroidism, dyslipidemia, chronic
 * kidney disease). Each pattern has a few deliberate variants, picked by
 * the patient's ordinal within the pattern, so the demo always shows the
 * case that is on track and the one the protocol catches.
 */

export const PROTOCOL_PATTERNS = [
  'pregnancy_ongoing',
  'pregnancy_delivered',
  'pregnancy_loss',
  'ssri_stable',
  'ssri_dose_change',
  'hypothyroidism',
  'dyslipidemia_statin',
  'ckd_g3',
  'ckd_g4',
  'ckd_uncoded',
] as const;
export type ProtocolPattern = (typeof PROTOCOL_PATTERNS)[number];

/** Internists who see the psychology patients the clinic refers for medication. */
const INTERNISTS = ['prac-im-01', 'prac-im-02'] as const;

const BIWEEKLY: FollowUp = { amount: 15, unit: 'días' };
const MONTHS = (amount: number): FollowUp => ({ amount, unit: 'meses' });
const WEEKS = (amount: number): FollowUp => ({ amount, unit: 'semanas' });

/** The variant of a pattern for the patient's ordinal within it. */
function variantOf<T>(variants: readonly [T, ...T[]], ordinal: number): T {
  return variants[ordinal % variants.length] ?? variants[0];
}

/** Midnight UTC of the day `day` days after the base date. */
function dayDate(day: number): Date {
  const date = new Date(BASE_DATE.getTime() + Math.round(day) * MS_PER_DAY);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

const lmpFact = (lmp: Date): DateFact => ({
  loinc: '8665-2',
  display: 'Last menstrual period start date',
  value: isoDate(lmp),
});

const eddFact = (edd: Date): DateFact => ({
  loinc: '11778-8',
  display: 'Delivery date Estimated',
  value: isoDate(edd),
});

/** Days from the last menstrual period to the estimated delivery date (Naegele). */
const PREGNANCY_DAYS = 280;

const completedWeeks = (lmp: Date, at: Date): number =>
  Math.floor((at.getTime() - lmp.getTime()) / (7 * MS_PER_DAY));

/** A consultation, counted in the clinic stats (`hasPlan` from the follow-up, unless given). */
function consult(ctx: Context, spec: ConsultationSpec, hasPlan: boolean): ConsultationRecord {
  record(ctx, hasPlan);
  return ctx.timeline.consultation(spec);
}

/** Books the visit at `start` from the consultation that ended at `end`. */
function book(
  ctx: Context,
  end: Date,
  start: Date,
  minutes: number,
  description: string,
  provider?: Provider,
): string {
  return ctx.timeline.book(plusDays(end, 10 / 1440), start, minutes, description, provider);
}

/** The patient cancels a booked visit one to three days before it (if that is in the past). */
function cancelBooked(
  ctx: Context,
  id: string,
  end: Date,
  start: Date,
  minutes: number,
  description: string,
  provider?: Provider,
): void {
  const at = plusDays(start, -ctx.rng.int(1, 3));
  if (at <= BASE_DATE && at > end) {
    ctx.timeline.cancel(id, at, plusDays(end, 10 / 1440), start, minutes, description, provider);
  }
}

/**
 * A lab the patient had done at an outside lab, reported without a linked
 * order: sampled `daysBefore` days before `at` (3 to 6 by default) and
 * reported the next day. Returns when it was reported, or undefined when
 * that would be after the base date.
 */
function outsideLab(
  ctx: Context,
  order: OrderDefinition,
  at: Date,
  analyteValues: readonly number[],
  daysBefore?: number,
): Date | undefined {
  const collectedAt = plusDays(at, -(daysBefore ?? ctx.rng.int(3, 6)) + ctx.rng.int(0, 90) / 1440);
  const issuedAt = plusDays(collectedAt, 1 + ctx.rng.int(0, 240) / 1440);
  const arrived = ctx.timeline.result(ctx.rng, order, undefined, collectedAt, {
    abnormal: false,
    analyteValues,
    timing: { collectedAt, issuedAt },
  });
  return arrived ? issuedAt : undefined;
}

// --- Pregnancy ---------------------------------------------------------------

interface PrenatalPlan {
  readonly lmp: Date;
  readonly firstWeek: number;
  /** No prenatal visit at or after this instant (the delivery, the loss). */
  readonly until: Date;
  readonly dating: PregnancyDatingSource;
  /** The prenatal visits code Z34.9 (false: the record only has the dating ultrasound). */
  readonly coded: boolean;
  /** Whether the OGTT is ordered in weeks 24 to 27 (and resulted). */
  readonly ogtt: boolean;
  /** Last scheduled week the patient attends; the next booked control is cancelled. */
  readonly lastAttendedWeek?: number;
  readonly obstetric: string;
}

/**
 * Prenatal controls every 4 weeks up to week 28 and every 2 weeks up to 36,
 * each booking the next: first-visit labs and dating ultrasound,
 * morphology ultrasound at 20-23 weeks, OGTT at 24-27, third-trimester
 * ultrasound at 32-34.
 */
function prenatalCourse(ctx: Context, plan: PrenatalPlan): void {
  const { rng, timeline } = ctx;
  const edd = plusDays(plan.lmp, PREGNANCY_DAYS);
  const lmpDay = dayOf(plan.lmp);
  let week = plan.firstWeek;
  let visit: Visit = { start: visitTime(rng, lmpDay + week * 7) };
  let review: { ogtt?: { fasting: number; twoHour: number }; ultrasound?: boolean } = {};
  const done = { morphology: false, ogtt: false, thirdTrimester: false };
  let first = true;
  while (visit.start < plan.until && visit.start <= BASE_DATE) {
    const weeks = completedWeeks(plan.lmp, visit.start);
    const orders: OrderDefinition[] = [];
    if (first) orders.push(ORDERS.cbc, ORDERS.glucose, ORDERS.urinalysis, ORDERS.obstetricUs);
    if (!first && weeks >= 20 && weeks < 24 && !done.morphology) {
      orders.push(ORDERS.obstetricUs);
      done.morphology = true;
    }
    if (plan.ogtt && weeks >= 24 && weeks < 28 && !done.ogtt) {
      orders.push(ORDERS.ogtt);
      done.ogtt = true;
    }
    if (weeks >= 32 && weeks < 35 && !done.thirdTrimester) {
      orders.push(ORDERS.obstetricUs);
      done.thirdTrimester = true;
    }
    const medications = first ? [MEDICATIONS.folicAcid, MEDICATIONS.ferrousSulfate] : [];
    const step = week < 28 ? 4 : week < 36 ? 2 : 1;
    const followUp = maybePlan(ctx, WEEKS(step), 0.15);
    const consultation = consult(
      ctx,
      {
        start: visit.start,
        minutes: 30,
        visitType: first ? 'Primera consulta prenatal' : 'Control prenatal',
        ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
        noteText: prenatalNote({
          rng,
          age: ageAt(ctx, visit.start),
          obstetric: plan.obstetric,
          firstVisit: first,
          weeks,
          dating: plan.dating,
          lmp: plan.lmp,
          edd,
          orders,
          medications,
          ...(review.ogtt ? { ogttReviewed: review.ogtt } : {}),
          ...(review.ultrasound ? { ultrasoundReviewed: true } : {}),
          ...(followUp ? { followUp } : {}),
        }),
        conditions: plan.coded ? [CONDITIONS.pregnancy] : [],
        medications,
        orders,
        ...(first && plan.dating === 'lmp' ? { dateFacts: [lmpFact(plan.lmp), eddFact(edd)] } : {}),
      },
      followUp !== undefined,
    );
    review = {};
    for (const [order, orderId] of consultation.orderIds) {
      if (order === ORDERS.ogtt) {
        const values = { fasting: rng.int(74, 88), twoHour: rng.int(98, 138) };
        if (
          timeline.result(rng, order, orderId, consultation.end, {
            abnormal: false,
            analyteValues: [values.fasting, values.twoHour],
          })
        )
          review.ogtt = values;
        continue;
      }
      // Every prenatal result comes back (the variants differ only in what the protocol checks);
      // the dating ultrasound carries the estimated delivery date.
      const dating = first && order === ORDERS.obstetricUs && plan.dating === 'ultrasound';
      const arrived = timeline.result(rng, order, orderId, consultation.end, {
        abnormal: false,
        ...(dating ? { dateFacts: [eddFact(edd)] } : {}),
      });
      if (arrived && order === ORDERS.obstetricUs) review.ultrasound = true;
    }
    first = false;
    week += step;
    const nextStart = visitTime(rng, lmpDay + week * 7);
    if (week > 40 || nextStart >= plan.until) break;
    const appointmentId = book(ctx, consultation.end, nextStart, 30, 'Control prenatal');
    if (plan.lastAttendedWeek !== undefined && week > plan.lastAttendedWeek) {
      cancelBooked(ctx, appointmentId, consultation.end, nextStart, 30, 'Control prenatal');
      break;
    }
    visit = { start: nextStart, appointmentId };
  }
}

function obstetricFormula(gravida: number, para: number, abortions = 0): string {
  if (gravida === 1 && para === 0 && abortions === 0) return 'Primigesta';
  return `G${String(gravida)}P${String(para)}${abortions > 0 ? `A${String(abortions)}` : ''}`;
}

/** `until` of a pregnancy still ongoing at the base date (its next control is booked). */
const ONGOING = plusDays(BASE_DATE, 365);

/** A pregnancy `weeks` (+ 0 to 6 days) along at the base date: its last menstrual period. */
function lmpForWeeks(ctx: Context, weeks: number): Date {
  return dayDate(-(weeks * 7 + ctx.rng.int(0, 6)));
}

interface OngoingVariant {
  readonly weeks: readonly [number, number];
  readonly dating: PregnancyDatingSource;
  readonly coded: boolean;
  readonly ogtt: boolean;
  readonly lastAttendedWeek?: number;
}

const ONGOING_VARIANTS: readonly [OngoingVariant, ...OngoingVariant[]] = [
  // Past week 28 and the OGTT was never ordered: the protocol's glucose tolerance item.
  { weeks: [29, 31], dating: 'lmp', coded: true, ogtt: false },
  // OGTT done at 24-27 weeks: nothing pending.
  { weeks: [30, 32], dating: 'lmp', coded: true, ogtt: true },
  // Enrolled by the dating ultrasound alone (no Z34 code), dated by its EDD.
  { weeks: [12, 14], dating: 'ultrasound', coded: false, ogtt: false },
  // Stopped coming after week 30: the 2-weekly prenatal visit is overdue.
  { weeks: [34, 35], dating: 'lmp', coded: true, ogtt: true, lastAttendedWeek: 30 },
  // Dated only by the note ("embarazo de 22 semanas por FUM"), no FUM/FPP fields.
  { weeks: [21, 23], dating: 'note', coded: true, ogtt: false },
];

function pregnancyOngoing(ctx: Context, ordinal: number): void {
  const variant = variantOf(ONGOING_VARIANTS, ordinal);
  const lmp = lmpForWeeks(ctx, ctx.rng.int(variant.weeks[0], variant.weeks[1]));
  prenatalCourse(ctx, {
    lmp,
    firstWeek: ctx.rng.int(7, 10),
    until: ONGOING,
    dating: variant.dating,
    coded: variant.coded,
    ogtt: variant.ogtt,
    ...(variant.lastAttendedWeek === undefined
      ? {}
      : { lastAttendedWeek: variant.lastAttendedWeek }),
    obstetric: obstetricFormula(ctx.gravida + 1, ctx.gravida),
  });
}

interface DeliveredVariant {
  readonly daysAgo: readonly [number, number];
  readonly mode: 'vaginal' | 'cesarean';
  /** At the puerperal visit, or onto the problem list from the hospital's report. */
  readonly reported: 'visit' | 'problem_list';
  /** The 6-week puerperal control is booked (in the future). */
  readonly booksControl?: boolean;
}

const DELIVERED_VARIANTS: readonly [DeliveredVariant, ...DeliveredVariant[]] = [
  // Puerperal visit at 7-12 days codes the delivery (O80) and the puerperium.
  { daysAgo: [150, 230], mode: 'vaginal', reported: 'visit' },
  // Cesarean reported by the hospital onto the problem list (O82), no puerperal visit since.
  { daysAgo: [62, 80], mode: 'cesarean', reported: 'problem_list' },
  // Delivered last week (O80 on the problem list); the 6-week control is booked.
  { daysAgo: [9, 14], mode: 'vaginal', reported: 'problem_list', booksControl: true },
];

function pregnancyDelivered(ctx: Context, ordinal: number): void {
  const { rng, timeline } = ctx;
  const variant = variantOf(DELIVERED_VARIANTS, ordinal);
  const deliveryDay = -rng.int(variant.daysAgo[0], variant.daysAgo[1]);
  const gestationDays = rng.int(38, 40) * 7 + rng.int(0, 6);
  const lmp = dayDate(deliveryDay - gestationDays);
  const deliveredAt = plusDays(dayDate(deliveryDay), rng.int(6, 22) / 24);
  const obstetric = obstetricFormula(ctx.gravida + 1, ctx.gravida);
  prenatalCourse(ctx, {
    lmp,
    firstWeek: rng.int(8, 11),
    until: plusDays(deliveredAt, -1),
    dating: 'lmp',
    coded: true,
    ogtt: true,
    obstetric,
  });
  const delivery =
    variant.mode === 'vaginal' ? CONDITIONS.vaginalDelivery : CONDITIONS.cesareanDelivery;
  if (variant.reported === 'problem_list') {
    const recordedAt = plusDays(deliveredAt, rng.int(1, 4) + rng.int(0, 120) / 1440);
    timeline.diagnosis(delivery, recordedAt, deliveredAt);
    if (variant.booksControl) {
      book(ctx, recordedAt, visitTime(rng, deliveryDay + rng.int(38, 41)), 30, 'Control puerperal');
    }
    return;
  }
  const start = visitTime(rng, deliveryDay + rng.int(7, 12));
  const days = Math.round(dayOf(start) - deliveryDay);
  const followUp = WEEKS(6);
  const consultation = consult(
    ctx,
    {
      start,
      minutes: 25,
      visitType: 'Control puerperal',
      noteText: deliveryVisitNote({
        rng,
        age: ageAt(ctx, start),
        obstetric: obstetricFormula(ctx.gravida + 1, ctx.gravida + 1),
        days,
        deliveredAt,
        gestationalWeeks: Math.floor(gestationDays / 7),
        mode: variant.mode,
        medications: [MEDICATIONS.ferrousSulfate],
        followUp,
      }),
      conditions: [delivery, CONDITIONS.postpartum],
      medications: [MEDICATIONS.ferrousSulfate],
      orders: [],
    },
    true,
  );
  const next = visitTime(rng, dayOf(consultation.end) + 42 + rng.int(-3, 4));
  const appointmentId = book(ctx, consultation.end, next, 30, 'Control puerperal');
  if (next > BASE_DATE) return;
  consult(
    ctx,
    {
      start: next,
      minutes: 25,
      visitType: 'Control puerperal',
      appointmentId,
      noteText: puerperalControlNote({
        rng,
        days: Math.round(dayOf(next) - deliveryDay),
        mode: variant.mode,
        medications: [MEDICATIONS.combinedPill],
      }),
      conditions: [CONDITIONS.contraception],
      medications: [MEDICATIONS.combinedPill],
      orders: [],
    },
    true,
  );
}

/**
 * A first-trimester miscarriage (O03.9) after one prenatal control: nothing
 * prenatal is expected after it. The second variant skips the post-loss
 * control and is pregnant again at the base date (a new episode).
 */
function pregnancyLoss(ctx: Context, ordinal: number): void {
  const { rng } = ctx;
  const again = ordinal % 2 === 1;
  const lossDay = again ? -rng.int(330, 380) : -rng.int(120, 300);
  const lossWeeks = rng.int(8, 10);
  const lmp = dayDate(lossDay - lossWeeks * 7 - rng.int(0, 6));
  const lossStart = visitTime(rng, lossDay);
  const gravida = ctx.gravida + 1;
  prenatalCourse(ctx, {
    lmp,
    firstWeek: rng.int(6, 7),
    until: lossStart,
    dating: 'lmp',
    coded: true,
    ogtt: false,
    obstetric: obstetricFormula(gravida, ctx.gravida),
  });
  const followUp = WEEKS(2);
  const loss = consult(
    ctx,
    {
      start: lossStart,
      minutes: 30,
      visitType: 'Consulta por morbilidad',
      reason: 'Sangrado transvaginal en primer trimestre',
      noteText: miscarriageNote({
        rng,
        age: ageAt(ctx, lossStart),
        obstetric: obstetricFormula(gravida, ctx.gravida),
        weeks: completedWeeks(lmp, lossStart),
        followUp,
      }),
      conditions: [CONDITIONS.miscarriage],
      medications: [],
      orders: [],
    },
    true,
  );
  const obstetricAfter = obstetricFormula(gravida, ctx.gravida, 1);
  if (!again) {
    const start = visitTime(rng, dayOf(loss.end) + rng.int(13, 16));
    const plan = MONTHS(12);
    consult(
      ctx,
      {
        start,
        minutes: 20,
        visitType: 'Consulta de control',
        noteText: postLossNote({
          rng,
          age: ageAt(ctx, start),
          obstetric: obstetricAfter,
          followUp: plan,
        }),
        conditions: [],
        medications: [],
        orders: [],
      },
      true,
    );
    return;
  }
  prenatalCourse(ctx, {
    lmp: lmpForWeeks(ctx, rng.int(15, 17)),
    firstWeek: rng.int(7, 9),
    until: ONGOING,
    dating: 'lmp',
    coded: true,
    ogtt: false,
    obstetric: obstetricFormula(gravida + 1, ctx.gravida, 1),
  });
}

// --- Antidepressant started by internal medicine, psychotherapy in psychology ---

interface AntidepressantVariant {
  readonly condition: ConditionDefinition;
  readonly start: MedicationDefinition;
  /** The dose it is raised to at the 4-week control. */
  readonly increase?: MedicationDefinition;
  /** First psychotherapy session, days before the base date. */
  readonly firstSessionDaysAgo: readonly [number, number];
  /** After the dose change: keeps coming, stops coming, or the change is too recent to tell. */
  readonly afterChange?: 'attends' | 'stops' | 'recent';
}

const SSRI_STABLE: readonly [AntidepressantVariant, ...AntidepressantVariant[]] = [
  {
    condition: CONDITIONS.depressionModerate,
    start: MEDICATIONS.sertraline,
    firstSessionDaysAgo: [400, 520],
  },
  {
    condition: CONDITIONS.anxiety,
    start: MEDICATIONS.escitalopram10,
    firstSessionDaysAgo: [400, 520],
  },
];

const SSRI_DOSE_CHANGE: readonly [AntidepressantVariant, ...AntidepressantVariant[]] = [
  {
    condition: CONDITIONS.depressionModerate,
    start: MEDICATIONS.sertraline,
    increase: MEDICATIONS.sertraline100,
    firstSessionDaysAgo: [280, 340],
    afterChange: 'attends',
  },
  {
    condition: CONDITIONS.depressionModerate,
    start: MEDICATIONS.sertraline,
    increase: MEDICATIONS.sertraline100,
    firstSessionDaysAgo: [135, 165],
    afterChange: 'stops',
  },
  {
    condition: CONDITIONS.anxiety,
    start: MEDICATIONS.escitalopram10,
    increase: MEDICATIONS.escitalopram20,
    firstSessionDaysAgo: [45, 52],
    afterChange: 'recent',
  },
];

/**
 * Biweekly psychotherapy (the patient's specialty) plus an internist who
 * starts an SSRI and controls it: monthly until three controls without a
 * change, then every 3 months. With a dose change at the 4-week control,
 * "Se aumenta sertralina a 100 mg/día. Control en 3 semanas".
 */
function antidepressantCourse(ctx: Context, variant: AntidepressantVariant, ordinal: number): void {
  const { rng } = ctx;
  const internist: Provider = {
    practitionerId: INTERNISTS[ordinal % INTERNISTS.length] ?? INTERNISTS[0],
    specialty: 'internal_medicine',
  };
  const firstSession = -rng.int(variant.firstSessionDaysAgo[0], variant.firstSessionDaysAgo[1]);
  const startDay = firstSession + rng.int(5, 10);
  const changeDay = startDay + rng.int(26, 30);
  const sessions = variant.increase === undefined ? rng.int(10, 14) : 99;

  // Psychotherapy sessions first: the first one is the patient's first visit.
  let session: Visit | undefined = { start: visitTime(rng, firstSession) };
  for (let number = 1; session; number++) {
    const discharge = number === sessions;
    const followUp = discharge ? undefined : maybePlan(ctx, BIWEEKLY, 0.3);
    const consultation = consult(
      ctx,
      {
        start: session.start,
        minutes: 50,
        visitType: number === 1 ? 'Primera sesión' : 'Sesión de psicoterapia',
        ...(session.appointmentId ? { appointmentId: session.appointmentId } : {}),
        noteText: psychologyNote({
          rng,
          sex: ctx.sex,
          age: ageAt(ctx, session.start),
          sessionNumber: number,
          condition: variant.condition,
          ...(followUp ? { followUp } : {}),
          ...(discharge ? { discharge } : {}),
        }),
        conditions: number === 1 ? [variant.condition] : [],
        medications: [],
        orders: [],
      },
      followUp !== undefined || discharge,
    );
    if (discharge) break;
    const next = visitTime(rng, dayOf(consultation.end) + 14 + rng.int(-1, 2));
    const appointmentId = book(ctx, consultation.end, next, 50, 'Sesión de psicoterapia');
    if (variant.afterChange === 'stops' && dayOf(next) >= changeDay - 1) {
      cancelBooked(ctx, appointmentId, consultation.end, next, 50, 'Sesión de psicoterapia');
      break;
    }
    session = next <= BASE_DATE ? { start: next, appointmentId } : undefined;
  }

  // The internist: start, controls, and the dose change.
  const description = 'Control de medicina interna';
  let visit: Visit | undefined = { start: visitTime(rng, startDay) };
  let medication = variant.start;
  let controlsWithoutChange = 0;
  let lastChange = startDay;
  for (let index = 0; visit; index++) {
    const increase = index === 1 ? variant.increase : undefined;
    const changes = increase !== undefined;
    const previous = medication;
    if (increase) medication = increase;
    const kind =
      index === 0
        ? 'start'
        : changes
          ? 'increase'
          : controlsWithoutChange < 3
            ? 'control'
            : 'maintenance';
    // The 4-week control, 3 weeks after a dose change, monthly until three
    // controls without a change, then every 3 months.
    const interval =
      kind === 'start' ? 28 : kind === 'increase' ? 21 : controlsWithoutChange < 2 ? 30 : 90;
    const followUp =
      kind === 'maintenance'
        ? maybePlan(ctx, MONTHS(3))
        : interval === 21
          ? WEEKS(3)
          : interval === 28
            ? WEEKS(4)
            : interval === 30
              ? MONTHS(1)
              : MONTHS(3);
    const consultation = consult(
      ctx,
      {
        start: visit.start,
        minutes: 30,
        visitType: index === 0 ? 'Primera consulta' : 'Consulta de control',
        reason: 'Seguimiento de tratamiento',
        provider: internist,
        ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
        noteText: antidepressantNote({
          rng,
          sex: ctx.sex,
          age: ageAt(ctx, visit.start),
          kind,
          condition: variant.condition,
          medication,
          ...(changes ? { previous } : {}),
          weeksOnTreatment: Math.max(1, Math.round((dayOf(visit.start) - lastChange) / 7)),
          ...(followUp ? { followUp } : {}),
        }),
        conditions: index === 0 ? [variant.condition] : [],
        medications: [medication],
        orders: [],
      },
      followUp !== undefined,
    );
    if (changes) {
      lastChange = dayOf(consultation.end);
      controlsWithoutChange = 0;
    } else if (index > 0) {
      controlsWithoutChange += 1;
    }
    const next = visitTime(
      rng,
      index === 0 ? changeDay : dayOf(consultation.end) + interval + rng.int(-2, 5),
    );
    const appointmentId = book(ctx, consultation.end, next, 30, description, internist);
    if (changes && variant.afterChange === 'stops') {
      cancelBooked(ctx, appointmentId, consultation.end, next, 30, description, internist);
      break;
    }
    visit = next <= BASE_DATE ? { start: next, appointmentId } : undefined;
  }
}

// --- Hypothyroidism ----------------------------------------------------------

const tshHigh = (ctx: Context): number => ctx.rng.around(7.4, 1.4, 2);
const tshNormal = (ctx: Context): number => ctx.rng.around(2.2, 1, 2);

/** A thyroid visit with the TSH the patient brings (taken 3 to 6 days before). */
function thyroidVisit(
  ctx: Context,
  start: Date,
  options: {
    readonly kind: 'workup' | 'start' | 'adjust' | 'control';
    readonly tsh?: number;
    /** The TSH came from an outside lab before the visit (otherwise it is already in the record). */
    readonly bringsTsh?: boolean;
    readonly medication?: MedicationDefinition;
    readonly previous?: MedicationDefinition;
    readonly orders?: readonly OrderDefinition[];
    readonly tshIn?: string;
    readonly followUp?: FollowUp;
    readonly yearsSinceDiagnosis?: number;
    readonly appointmentId?: string;
  },
): ConsultationRecord {
  if (options.bringsTsh && options.tsh !== undefined) {
    outsideLab(ctx, ORDERS.tsh, start, [options.tsh]);
  }
  const orders = options.orders ?? [];
  return consult(
    ctx,
    {
      start,
      minutes: 25,
      visitType: options.kind === 'workup' ? 'Primera consulta' : 'Consulta de control',
      reason: options.kind === 'workup' ? 'Astenia' : 'Control de tiroides',
      ...(options.appointmentId ? { appointmentId: options.appointmentId } : {}),
      noteText: thyroidNote({
        rng: ctx.rng,
        sex: ctx.sex,
        age: ageAt(ctx, start),
        kind: options.kind,
        ...(options.medication ? { medication: options.medication } : {}),
        ...(options.previous ? { previous: options.previous } : {}),
        ...(options.tsh === undefined ? {} : { tsh: options.tsh }),
        ...(options.yearsSinceDiagnosis
          ? { yearsSinceDiagnosis: options.yearsSinceDiagnosis }
          : {}),
        orders,
        ...(options.tshIn ? { tshIn: options.tshIn } : {}),
        ...(options.followUp ? { followUp: options.followUp } : {}),
      }),
      conditions: options.kind === 'workup' ? [CONDITIONS.fatigue] : [CONDITIONS.hypothyroidism],
      medications: options.medication ? [options.medication] : [],
      orders,
    },
    options.followUp !== undefined,
  );
}

/**
 * Levothyroxine started or changed, and the TSH 6 to 8 weeks later:
 * done; missing; taken too soon (3 weeks, does not count); or a stable
 * patient whose yearly control and TSH are overdue.
 */
function hypothyroidism(ctx: Context, ordinal: number): void {
  const { rng } = ctx;
  const years = rng.int(2, 12);
  const levo50 = MEDICATIONS.levothyroxine;
  const levo75 = MEDICATIONS.levothyroxine75;
  switch (ordinal % 4) {
    case 0: {
      // Diagnosed here: start 50 mcg, TSH still high at 8 weeks, 75 mcg, TSH normal at 7 weeks, yearly since.
      const workupStart = visitTime(rng, -rng.int(600, 650));
      const workup = thyroidVisit(ctx, workupStart, {
        kind: 'workup',
        orders: [ORDERS.tsh],
        followUp: WEEKS(2),
      });
      const firstTsh = rng.around(9.6, 1.5, 2);
      for (const [order, orderId] of workup.orderIds) {
        ctx.timeline.result(rng, order, orderId, workup.end, {
          abnormal: false,
          analyteValues: [firstTsh],
        });
      }
      const start = thyroidVisit(ctx, visitTime(rng, dayOf(workup.end) + rng.int(12, 16)), {
        kind: 'start',
        tsh: firstTsh,
        medication: levo50,
        tshIn: 'TSH control en 8 semanas',
        followUp: MONTHS(2),
      });
      const secondTsh = tshHigh(ctx);
      const secondAt = outsideLab(
        ctx,
        ORDERS.tsh,
        plusDays(start.end, rng.int(55, 60)),
        [secondTsh],
        1,
      );
      const adjust = thyroidVisit(
        ctx,
        visitTime(rng, dayOf(secondAt ?? start.end) + rng.int(2, 5)),
        {
          kind: 'adjust',
          tsh: secondTsh,
          medication: levo75,
          previous: levo50,
          tshIn: 'TSH control en 6 semanas',
          followUp: MONTHS(2),
        },
      );
      const thirdTsh = tshNormal(ctx);
      const thirdAt = outsideLab(
        ctx,
        ORDERS.tsh,
        plusDays(adjust.end, rng.int(46, 53)),
        [thirdTsh],
        1,
      );
      let control = thyroidVisit(
        ctx,
        visitTime(rng, dayOf(thirdAt ?? adjust.end) + rng.int(2, 6)),
        {
          kind: 'control',
          tsh: thirdTsh,
          medication: levo75,
          followUp: MONTHS(12),
          tshIn: 'TSH anual',
        },
      );
      for (;;) {
        const next = visitTime(rng, dayOf(control.end) + rng.int(350, 375));
        const appointmentId = book(ctx, control.end, next, 25, 'Control de tiroides');
        if (next > BASE_DATE) break;
        const plan = maybePlan(ctx, MONTHS(12));
        control = thyroidVisit(ctx, next, {
          kind: 'control',
          tsh: tshNormal(ctx),
          bringsTsh: true,
          medication: levo75,
          appointmentId,
          ...(plan ? { followUp: plan, tshIn: 'TSH anual' } : {}),
        });
      }
      return;
    }
    case 1: {
      // Long-standing on 50 mcg; raised to 75 mcg about 4 months ago and no TSH since.
      for (const daysAgo of [rng.int(640, 690), rng.int(290, 320)]) {
        thyroidVisit(ctx, visitTime(rng, -daysAgo), {
          kind: 'control',
          tsh: tshNormal(ctx),
          bringsTsh: true,
          medication: levo50,
          yearsSinceDiagnosis: years,
          followUp: MONTHS(12),
          tshIn: 'TSH anual',
        });
      }
      thyroidVisit(ctx, visitTime(rng, -rng.int(105, 120)), {
        kind: 'adjust',
        tsh: tshHigh(ctx),
        bringsTsh: true,
        medication: levo75,
        previous: levo50,
        yearsSinceDiagnosis: years,
        followUp: MONTHS(2),
        tshIn: 'TSH en 6 a 8 semanas',
      });
      return;
    }
    case 2: {
      // Raised to 75 mcg; the patient took the control TSH at 3 weeks (too soon to count).
      thyroidVisit(ctx, visitTime(rng, -rng.int(500, 560)), {
        kind: 'control',
        tsh: tshNormal(ctx),
        bringsTsh: true,
        medication: levo50,
        yearsSinceDiagnosis: years,
        followUp: MONTHS(12),
        tshIn: 'TSH anual',
      });
      const adjust = thyroidVisit(ctx, visitTime(rng, -rng.int(80, 90)), {
        kind: 'adjust',
        tsh: tshHigh(ctx),
        bringsTsh: true,
        medication: levo75,
        previous: levo50,
        yearsSinceDiagnosis: years,
        followUp: MONTHS(2),
        tshIn: 'TSH control en 6 semanas',
      });
      outsideLab(ctx, ORDERS.tsh, plusDays(adjust.end, rng.int(19, 23)), [tshNormal(ctx)], 1);
      return;
    }
    default: {
      // Stable on 50 mcg, last control and TSH over a year ago.
      const first = visitTime(rng, -rng.int(690, 715));
      thyroidVisit(ctx, first, {
        kind: 'control',
        tsh: tshNormal(ctx),
        bringsTsh: true,
        medication: levo50,
        yearsSinceDiagnosis: years,
        followUp: MONTHS(12),
        tshIn: 'TSH anual',
      });
      thyroidVisit(ctx, visitTime(rng, dayOf(first) + rng.int(270, 300)), {
        kind: 'control',
        tsh: tshNormal(ctx),
        bringsTsh: true,
        medication: levo50,
        yearsSinceDiagnosis: years + 1,
        followUp: MONTHS(12),
        tshIn: 'TSH anual',
      });
    }
  }
}

// --- Dyslipidemia ------------------------------------------------------------

function lipidValues(ctx: Context, level: 'high' | 'partial' | 'target'): LipidValues {
  const { rng } = ctx;
  switch (level) {
    case 'high':
      return {
        total: rng.int(245, 290),
        triglycerides: rng.int(160, 230),
        hdl: rng.int(34, 44),
        ldl: rng.int(160, 195),
      };
    case 'partial':
      return {
        total: rng.int(212, 236),
        triglycerides: rng.int(130, 170),
        hdl: rng.int(40, 46),
        ldl: rng.int(134, 150),
      };
    case 'target':
      return {
        total: rng.int(158, 186),
        triglycerides: rng.int(98, 140),
        hdl: rng.int(45, 56),
        ldl: rng.int(78, 99),
      };
  }
}

const panelArray = (panel: LipidValues): number[] => [
  panel.total,
  panel.triglycerides,
  panel.hdl,
  panel.ldl,
];

function lipidVisit(
  ctx: Context,
  start: Date,
  options: {
    readonly kind: 'start' | 'increase' | 'control';
    readonly condition: ConditionDefinition;
    readonly medication: MedicationDefinition;
    readonly previous?: MedicationDefinition;
    readonly panel: LipidValues;
    /** The panel came from an outside lab before the visit (otherwise it is already in the record). */
    readonly bringsPanel?: boolean;
    readonly weeksOnTreatment?: number;
    readonly panelIn?: string;
    readonly followUp?: FollowUp;
    readonly appointmentId?: string;
  },
): ConsultationRecord {
  if (options.bringsPanel) outsideLab(ctx, ORDERS.lipidPanel, start, panelArray(options.panel));
  return consult(
    ctx,
    {
      start,
      minutes: 25,
      visitType: options.kind === 'start' ? 'Primera consulta' : 'Consulta de control',
      reason: 'Dislipidemia',
      ...(options.appointmentId ? { appointmentId: options.appointmentId } : {}),
      noteText: lipidNote({
        rng: ctx.rng,
        sex: ctx.sex,
        age: ageAt(ctx, start),
        kind: options.kind,
        condition: options.condition,
        medication: options.medication,
        ...(options.previous ? { previous: options.previous } : {}),
        panel: options.panel,
        ...(options.weeksOnTreatment ? { weeksOnTreatment: options.weeksOnTreatment } : {}),
        ...(options.panelIn ? { panelIn: options.panelIn } : {}),
        ...(options.followUp ? { followUp: options.followUp } : {}),
      }),
      conditions: [options.condition],
      medications: [options.medication],
      orders: [],
    },
    options.followUp !== undefined,
  );
}

/**
 * A statin started (or its dose raised) and the lipid panel 4 to 12 weeks
 * later: done then yearly; missing; raised from 20 to 40 mg with a
 * control panel after the change.
 */
function dyslipidemiaStatin(ctx: Context, ordinal: number): void {
  const { rng } = ctx;
  const atorva20 = MEDICATIONS.atorvastatin;
  switch (ordinal % 3) {
    case 0: {
      const condition = CONDITIONS.hypercholesterolemia;
      const start = lipidVisit(ctx, visitTime(rng, -rng.int(430, 480)), {
        kind: 'start',
        condition,
        medication: atorva20,
        panel: lipidValues(ctx, 'high'),
        bringsPanel: true,
        panelIn: 'Perfil lipídico control en 8 semanas',
        followUp: MONTHS(2),
      });
      const panel = lipidValues(ctx, 'target');
      const at = outsideLab(
        ctx,
        ORDERS.lipidPanel,
        plusDays(start.end, rng.int(53, 60)),
        panelArray(panel),
        1,
      );
      let control = lipidVisit(ctx, visitTime(rng, dayOf(at ?? start.end) + rng.int(2, 6)), {
        kind: 'control',
        condition,
        medication: atorva20,
        panel,
        weeksOnTreatment: 8,
        panelIn: 'perfil lipídico anual',
        followUp: MONTHS(12),
      });
      for (;;) {
        const next = visitTime(rng, dayOf(control.end) + rng.int(355, 375));
        const appointmentId = book(ctx, control.end, next, 25, 'Control de dislipidemia');
        if (next > BASE_DATE) break;
        control = lipidVisit(ctx, next, {
          kind: 'control',
          condition,
          medication: atorva20,
          panel: lipidValues(ctx, 'target'),
          bringsPanel: true,
          appointmentId,
          panelIn: 'perfil lipídico anual',
          followUp: MONTHS(12),
        });
      }
      return;
    }
    case 1: {
      lipidVisit(ctx, visitTime(rng, -rng.int(120, 140)), {
        kind: 'start',
        condition: CONDITIONS.dyslipidemia,
        medication: MEDICATIONS.rosuvastatin10,
        panel: lipidValues(ctx, 'high'),
        bringsPanel: true,
        panelIn: 'Perfil lipídico en 8 semanas',
        followUp: MONTHS(2),
      });
      return;
    }
    default: {
      const condition = CONDITIONS.dyslipidemia;
      const start = lipidVisit(ctx, visitTime(rng, -rng.int(330, 360)), {
        kind: 'start',
        condition,
        medication: atorva20,
        panel: lipidValues(ctx, 'high'),
        bringsPanel: true,
        panelIn: 'Perfil lipídico control en 8 semanas',
        followUp: MONTHS(2),
      });
      const partial = lipidValues(ctx, 'partial');
      const partialAt = outsideLab(
        ctx,
        ORDERS.lipidPanel,
        plusDays(start.end, rng.int(47, 54)),
        panelArray(partial),
        1,
      );
      const increase = lipidVisit(
        ctx,
        visitTime(rng, dayOf(partialAt ?? start.end) + rng.int(2, 5)),
        {
          kind: 'increase',
          condition,
          medication: MEDICATIONS.atorvastatin40,
          previous: atorva20,
          panel: partial,
          weeksOnTreatment: 7,
          panelIn: 'Perfil lipídico en 10 semanas',
          followUp: MONTHS(3),
        },
      );
      const target = lipidValues(ctx, 'target');
      const targetAt = outsideLab(
        ctx,
        ORDERS.lipidPanel,
        plusDays(increase.end, rng.int(67, 76)),
        panelArray(target),
        1,
      );
      lipidVisit(ctx, visitTime(rng, dayOf(targetAt ?? increase.end) + rng.int(2, 6)), {
        kind: 'control',
        condition,
        medication: MEDICATIONS.atorvastatin40,
        panel: target,
        weeksOnTreatment: 10,
        panelIn: 'perfil lipídico anual',
        followUp: MONTHS(12),
      });
    }
  }
}

// --- Chronic kidney disease --------------------------------------------------

/** CKD-EPI 2021 (race-free) eGFR from serum creatinine, mL/min/1.73 m². */
function ckdEpi(creatinine: number, age: number, sex: 'female' | 'male'): number {
  const kappa = sex === 'female' ? 0.7 : 0.9;
  const alpha = sex === 'female' ? -0.241 : -0.302;
  const ratio = creatinine / kappa;
  return (
    142 *
    Math.min(ratio, 1) ** alpha *
    Math.max(ratio, 1) ** -1.2 *
    0.9938 ** age *
    (sex === 'female' ? 1.012 : 1)
  );
}

/** A creatinine (2 decimals) and its eGFR (whole) close to `target`. */
function renalFunction(
  target: number,
  age: number,
  sex: 'female' | 'male',
): { creatinine: number; egfr: number } {
  let low = 0.3;
  let high = 12;
  for (let step = 0; step < 50; step++) {
    const mid = (low + high) / 2;
    if (ckdEpi(mid, age, sex) > target) low = mid;
    else high = mid;
  }
  const creatinine = Math.round(((low + high) / 2) * 100) / 100;
  return { creatinine, egfr: Math.round(ckdEpi(creatinine, age, sex)) };
}

interface KidneyPlan {
  readonly firstDaysAgo: readonly [number, number];
  readonly everyDays: number;
  /** No visit after this many days before the base date (the next booked one is cancelled). */
  readonly stopsDaysAgo?: number;
  /** The CKD diagnosis coded and written; absent: the record never names it. */
  readonly ckd?: ConditionDefinition;
  /** Target eGFR at the n-th visit. */
  readonly egfr: (visit: number) => number;
  /** Target urine albumin/creatinine ratio at the n-th visit; absent: never measured. */
  readonly uacr?: (visit: number) => number;
}

/**
 * Hypertensive patients with kidney disease, seen every `everyDays` with
 * the creatinine/eGFR (and UACR) they bring from the lab a few days before
 * each visit.
 */
function kidneyCourse(ctx: Context, plan: KidneyPlan): void {
  const { rng } = ctx;
  const medications = [MEDICATIONS.losartan, ...(rng.chance(0.5) ? [MEDICATIONS.amlodipine] : [])];
  const yearsOfHypertension = rng.int(6, 20);
  const conditions = [CONDITIONS.hypertension, ...(plan.ckd ? [plan.ckd] : [])];
  const months = Math.round(plan.everyDays / 30);
  let visit: Visit | undefined = {
    start: visitTime(rng, -rng.int(plan.firstDaysAgo[0], plan.firstDaysAgo[1])),
  };
  for (let index = 0; visit; index++) {
    const age = ageAt(ctx, visit.start);
    const renal = renalFunction(plan.egfr(index) + rng.int(-1, 1), age, ctx.sex);
    const uacr = plan.uacr ? Math.max(5, plan.uacr(index) + rng.int(-6, 6)) : undefined;
    const sampled = rng.int(3, 6);
    outsideLab(ctx, ORDERS.creatinineEgfr, visit.start, [renal.creatinine, renal.egfr], sampled);
    if (uacr !== undefined) outsideLab(ctx, ORDERS.uacr, visit.start, [uacr], sampled);
    const followUp = maybePlan(ctx, MONTHS(months), 0.15);
    const consultation = consult(
      ctx,
      {
        start: visit.start,
        minutes: 30,
        visitType: index === 0 ? 'Primera consulta' : 'Consulta de control',
        reason: plan.ckd
          ? 'Control de enfermedad renal crónica'
          : 'Control de hipertensión arterial',
        ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
        noteText: kidneyNote({
          rng,
          sex: ctx.sex,
          age,
          firstVisit: index === 0,
          yearsOfHypertension,
          ...(plan.ckd ? { ckd: plan.ckd } : {}),
          creatinine: renal.creatinine,
          egfr: renal.egfr,
          ...(uacr === undefined ? {} : { uacr }),
          medications,
          ...(followUp ? { followUp } : {}),
        }),
        conditions,
        medications,
        orders: [],
      },
      followUp !== undefined,
    );
    const next = visitTime(rng, dayOf(consultation.end) + plan.everyDays + rng.int(-5, 8));
    const appointmentId = book(ctx, consultation.end, next, 30, 'Control renal');
    if (plan.stopsDaysAgo !== undefined && dayOf(next) > -plan.stopsDaysAgo) {
      cancelBooked(ctx, appointmentId, consultation.end, next, 30, 'Control renal');
      break;
    }
    visit = next <= BASE_DATE ? { start: next, appointmentId } : undefined;
  }
}

/** A target that drifts down by `perVisit` from `start`. */
const declining =
  (start: number, perVisit: number) =>
  (visit: number): number =>
    Math.round(start - perVisit * visit);

const KIDNEY_PLANS: Record<'ckd_g3' | 'ckd_g4' | 'ckd_uncoded', readonly KidneyPlan[]> = {
  ckd_g3: [
    // G3a A2, every 6 months, on track.
    {
      firstDaysAgo: [650, 690],
      everyDays: 182,
      ckd: CONDITIONS.ckd3,
      egfr: declining(55, 1.5),
      uacr: declining(110, 8),
    },
    // G3b A2, every 4 months; stopped coming: labs and visit overdue.
    {
      firstDaysAgo: [560, 600],
      everyDays: 121,
      stopsDaysAgo: 150,
      ckd: CONDITIONS.ckd3,
      egfr: declining(41, 1),
      uacr: declining(170, -10),
    },
  ],
  ckd_g4: [
    // G4 A3, every 3 months, on track.
    {
      firstDaysAgo: [640, 680],
      everyDays: 91,
      ckd: CONDITIONS.ckd4,
      egfr: declining(27, 0.6),
      uacr: declining(420, -15),
    },
    // G4 A2, every 3 months; stopped coming about 5 months ago.
    {
      firstDaysAgo: [500, 540],
      everyDays: 91,
      stopsDaysAgo: 120,
      ckd: CONDITIONS.ckd4,
      egfr: declining(25, 0.8),
      uacr: declining(180, -12),
    },
  ],
  ckd_uncoded: [
    // eGFR below 60 on consecutive 6-monthly labs, never coded N18: enrolled by the results.
    {
      firstDaysAgo: [660, 700],
      everyDays: 182,
      egfr: (visit) => (visit === 0 ? 64 : 58 - 2 * visit),
    },
    // Normal eGFR, urine albumin/creatinine 30 or more twice: enrolled by albuminuria.
    {
      firstDaysAgo: [600, 640],
      everyDays: 182,
      egfr: declining(82, 1),
      uacr: (visit) => (visit === 0 ? 22 : 38 + 9 * visit),
    },
  ],
};

function kidney(ctx: Context, pattern: 'ckd_g3' | 'ckd_g4' | 'ckd_uncoded', ordinal: number): void {
  const plans = KIDNEY_PLANS[pattern];
  const plan = plans[ordinal % plans.length];
  if (plan) kidneyCourse(ctx, plan);
}

// --- Dispatch ----------------------------------------------------------------

/** Generates the history of a patient of one of the {@link PROTOCOL_PATTERNS}. */
export function protocolPatient(ctx: Context, pattern: ProtocolPattern, ordinal: number): void {
  switch (pattern) {
    case 'pregnancy_ongoing':
      pregnancyOngoing(ctx, ordinal);
      return;
    case 'pregnancy_delivered':
      pregnancyDelivered(ctx, ordinal);
      return;
    case 'pregnancy_loss':
      pregnancyLoss(ctx, ordinal);
      return;
    case 'ssri_stable':
      antidepressantCourse(ctx, variantOf(SSRI_STABLE, ordinal), ordinal);
      return;
    case 'ssri_dose_change':
      antidepressantCourse(ctx, variantOf(SSRI_DOSE_CHANGE, ordinal), ordinal);
      return;
    case 'hypothyroidism':
      hypothyroidism(ctx, ordinal);
      return;
    case 'dyslipidemia_statin':
      dyslipidemiaStatin(ctx, ordinal);
      return;
    case 'ckd_g3':
    case 'ckd_g4':
    case 'ckd_uncoded':
      kidney(ctx, pattern, ordinal);
      return;
  }
}
