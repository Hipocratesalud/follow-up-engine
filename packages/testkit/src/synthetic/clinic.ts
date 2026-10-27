import { BASE_DATE, DEMO_CLINIC_ID, DEMO_CLINIC_NAME, type Specialty } from '../constants.ts';
import {
  CONDITIONS,
  type ConditionDefinition,
  MEDICATIONS,
  type MedicationDefinition,
  type OrderDefinition,
  ORDERS,
} from './catalog.ts';
import {
  type FhirResource,
  isoDate,
  organizationResource,
  type PatientInput,
  type PractitionerInput,
  practitionerResource,
  practitionerRoleResource,
} from './fhir-builders.ts';
import { nameKey, personName } from './names.ts';
import {
  acuteNote,
  diabetesNote,
  type FollowUp,
  followUpDays,
  gynecologyNote,
  hypertensionNote,
  psychologyNote,
} from './notes.ts';
import { Prng } from './prng.ts';
import { PatientTimeline, type TimelineEntry } from './timeline.ts';

/** Seed of the committed fixtures. Changing it changes every generated file. */
export const DEFAULT_SEED = 20_260_105;

/** History starts two years before the base date. */
const HISTORY_DAYS = 730;
const MS_PER_DAY = 86_400_000;

export const PATIENT_PATTERNS = {
  diabetology: ['adherent', 'dropout', 'unresulted_labs', 'new_patient', 'no_plan_notes'],
  internal_medicine: [
    'hypertension_adherent',
    'hypertension_dropout',
    'short_treatment',
    'abnormal_result',
  ],
  psychology: [
    'weekly_discharged',
    'weekly_dropout',
    'monthly_ongoing',
    'monthly_dropout',
    'biweekly_dropout',
  ],
  gynecology: [
    'annual_control',
    'pregnancy_postpartum',
    'pregnancy_missed_postpartum',
    'acute_or_short',
  ],
} as const satisfies Record<Specialty, readonly string[]>;

export type PatientPattern = (typeof PATIENT_PATTERNS)[Specialty][number];

/** One synthetic patient: their whole history as the host pushed it, oldest first. */
export interface SyntheticPatient {
  readonly clinicId: string;
  readonly patientId: string;
  readonly name: string;
  readonly gender: 'female' | 'male';
  readonly birthDate: string;
  readonly specialty: Specialty;
  /** Behavior the history was generated with (for demos and debugging, not for the engine). */
  readonly pattern: PatientPattern;
  readonly entries: readonly TimelineEntry[];
}

export interface SyntheticClinicStats {
  readonly patients: number;
  readonly patientsBySpecialty: Record<Specialty, number>;
  readonly patientsByPattern: Record<string, number>;
  readonly bundles: number;
  readonly bundlesByKind: Record<string, number>;
  readonly consultations: number;
  readonly notesWithoutPlan: number;
}

export interface SyntheticClinicDirectory {
  readonly clinicId: string;
  readonly name: string;
  readonly baseDate: string;
  readonly seed: number;
  readonly synthetic: true;
  readonly organization: FhirResource;
  readonly practitioners: readonly FhirResource[];
  readonly practitionerRoles: readonly FhirResource[];
  readonly stats: SyntheticClinicStats;
}

export interface SyntheticClinic {
  readonly clinic: SyntheticClinicDirectory;
  readonly patients: readonly SyntheticPatient[];
}

const PRACTITIONERS: readonly PractitionerInput[] = [
  {
    id: 'prac-diab-01',
    prefix: 'Dra.',
    name: { given: ['Mariela'], family: ['Castellanos', 'Urdaneta'] },
    gender: 'female',
    specialty: 'diabetology',
  },
  {
    id: 'prac-diab-02',
    prefix: 'Dr.',
    name: { given: ['Andrés', 'Felipe'], family: ['Quintero', 'Lozada'] },
    gender: 'male',
    specialty: 'diabetology',
  },
  {
    id: 'prac-im-01',
    prefix: 'Dr.',
    name: { given: ['Rafael', 'Ignacio'], family: ['Méndez', 'Arocha'] },
    gender: 'male',
    specialty: 'internal_medicine',
  },
  {
    id: 'prac-im-02',
    prefix: 'Dra.',
    name: { given: ['Carolina'], family: ['Paz', 'Benavides'] },
    gender: 'female',
    specialty: 'internal_medicine',
  },
  {
    id: 'prac-psy-01',
    prefix: 'Psic.',
    name: { given: ['Valeria'], family: ['Montiel', 'Suárez'] },
    gender: 'female',
    specialty: 'psychology',
  },
  {
    id: 'prac-psy-02',
    prefix: 'Psic.',
    name: { given: ['Tomás'], family: ['Aguirre', 'Leal'] },
    gender: 'male',
    specialty: 'psychology',
  },
  {
    id: 'prac-gyn-01',
    prefix: 'Dra.',
    name: { given: ['Luisa', 'Fernanda'], family: ['Ochoa', 'Vielma'] },
    gender: 'female',
    specialty: 'gynecology',
  },
  {
    id: 'prac-gyn-02',
    prefix: 'Dr.',
    name: { given: ['Gustavo'], family: ['Herrera', 'Sanabria'] },
    gender: 'male',
    specialty: 'gynecology',
  },
];

/** How many patients of each pattern the clinic has (35 / 30 / 30 / 25). */
const PATTERN_COUNTS: readonly (readonly [Specialty, PatientPattern, number])[] = [
  ['diabetology', 'adherent', 14],
  ['diabetology', 'dropout', 9],
  ['diabetology', 'unresulted_labs', 5],
  ['diabetology', 'new_patient', 4],
  ['diabetology', 'no_plan_notes', 3],
  ['internal_medicine', 'hypertension_adherent', 10],
  ['internal_medicine', 'hypertension_dropout', 6],
  ['internal_medicine', 'short_treatment', 10],
  ['internal_medicine', 'abnormal_result', 4],
  ['psychology', 'weekly_discharged', 8],
  ['psychology', 'weekly_dropout', 7],
  ['psychology', 'monthly_ongoing', 6],
  ['psychology', 'monthly_dropout', 5],
  ['psychology', 'biweekly_dropout', 4],
  ['gynecology', 'annual_control', 9],
  ['gynecology', 'pregnancy_postpartum', 6],
  ['gynecology', 'pregnancy_missed_postpartum', 4],
  ['gynecology', 'acute_or_short', 6],
];

/** Probability that a routine note has no plan section. */
const NO_PLAN_RATE = 0.22;

interface Context {
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
function ageAt(ctx: Context, date: Date): number {
  const birth = ctx.birthDate;
  let age = date.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    date.getUTCMonth() < birth.getUTCMonth() ||
    (date.getUTCMonth() === birth.getUTCMonth() && date.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** A weekday office-hours instant `day` days after the base date (local UTC-4, 08:00 to 16:45). */
function visitTime(rng: Prng, day: number): Date {
  let date = new Date(BASE_DATE.getTime() + Math.round(day) * MS_PER_DAY);
  const weekday = date.getUTCDay();
  if (weekday === 6) date = new Date(date.getTime() + 2 * MS_PER_DAY);
  if (weekday === 0) date = new Date(date.getTime() + MS_PER_DAY);
  date.setUTCHours(rng.int(12, 20), rng.pick([0, 15, 30, 45]), 0, 0);
  return date;
}

const dayOf = (date: Date): number => (date.getTime() - BASE_DATE.getTime()) / MS_PER_DAY;
const plusDays = (date: Date, days: number): Date => new Date(date.getTime() + days * MS_PER_DAY);

function maybePlan(
  ctx: Context,
  followUp: FollowUp,
  noPlanRate = NO_PLAN_RATE,
): FollowUp | undefined {
  return ctx.rng.chance(noPlanRate) ? undefined : followUp;
}

/** Counts a consultation; `hasPlan` is false when its note has no follow-up plan. */
function record(ctx: Context, hasPlan: boolean): void {
  ctx.stats.consultations += 1;
  if (!hasPlan) ctx.stats.withoutPlan += 1;
}

interface Visit {
  readonly start: Date;
  readonly appointmentId?: string;
}

/**
 * Books the next visit at the end of a consultation (when the patient
 * leaves with a plan) and, when the patient will not show up, sometimes
 * cancels it. Returns the next visit, or undefined when it will not happen.
 */
function scheduleNext(
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

function hba1cValue(rng: Prng, controlled: boolean): number {
  return controlled ? rng.around(6.5, 0.4, 1) : rng.around(8.6, 1.2, 1);
}

function diabetes(ctx: Context, pattern: PatientPattern): void {
  const { rng, timeline } = ctx;
  const conditions: ConditionDefinition[] = [CONDITIONS.dm2];
  if (rng.chance(0.5)) conditions.push(CONDITIONS.dyslipidemia);
  if (rng.chance(0.35)) conditions.push(CONDITIONS.obesity);
  if (rng.chance(0.3)) conditions.push(CONDITIONS.hypertension);
  const medications: MedicationDefinition[] = [
    rng.chance(0.6) ? MEDICATIONS.metformin850 : MEDICATIONS.metformin1000,
  ];
  if (conditions.includes(CONDITIONS.dyslipidemia)) medications.push(MEDICATIONS.atorvastatin);
  if (conditions.includes(CONDITIONS.hypertension)) medications.push(MEDICATIONS.losartan);
  const addOns = [
    MEDICATIONS.sitagliptin,
    MEDICATIONS.empagliflozin,
    MEDICATIONS.glibenclamide,
    MEDICATIONS.glargine,
  ];
  let controlled = rng.chance(0.5);
  const diagnosisYear = BASE_DATE.getUTCFullYear() - rng.int(3, 16);

  const visitsPlanned =
    pattern === 'dropout' ? rng.int(2, 4) : pattern === 'new_patient' ? rng.int(1, 2) : 99;
  let day =
    pattern === 'new_patient'
      ? -rng.int(20, 100)
      : pattern === 'dropout'
        ? -HISTORY_DAYS + rng.int(0, 200)
        : -HISTORY_DAYS + rng.int(0, 120);
  let visit: Visit | undefined = { start: visitTime(rng, day) };
  let lastHba1c: number | undefined;
  let lastAnnualLabs = -Infinity;
  let pending: OrderDefinition[] = [];
  let index = 0;

  while (visit) {
    const annual = dayOf(visit.start) - lastAnnualLabs >= 330;
    const orders = new Set<OrderDefinition>(pending);
    if (rng.chance(0.85)) orders.add(ORDERS.hba1c);
    if (annual) {
      orders.add(ORDERS.lipidPanel).add(ORDERS.creatinine).add(ORDERS.microalbumin);
      lastAnnualLabs = dayOf(visit.start);
    }
    if (!controlled && index > 0 && rng.chance(0.5)) {
      const next = addOns.find((med) => !medications.includes(med));
      if (next) medications.push(next);
    }
    const noPlanRate = pattern === 'no_plan_notes' ? 0.8 : NO_PLAN_RATE;
    const months = controlled ? 3 : rng.pick([2, 3]);
    const followUp = maybePlan(ctx, { amount: months, unit: 'meses' }, noPlanRate);
    record(ctx, followUp !== undefined);
    const consultation = timeline.consultation({
      start: visit.start,
      minutes: rng.int(20, 35),
      visitType: index === 0 ? 'Primera consulta' : 'Consulta de control',
      reason: 'Control de diabetes',
      ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
      noteText: diabetesNote({
        rng,
        sex: ctx.sex,
        age: ageAt(ctx, visit.start),
        weightKg: ctx.weightKg,
        firstVisit: index === 0,
        yearsSinceDiagnosis: visit.start.getUTCFullYear() - diagnosisYear,
        conditions,
        medications,
        orders: [...orders],
        reorders: pending,
        controlled,
        ...(lastHba1c === undefined ? {} : { lastHba1c }),
        ...(followUp ? { followUp } : {}),
      }),
      conditions,
      medications,
      orders: [...orders],
    });
    pending = [];
    for (const [order, orderId] of consultation.orderIds) {
      const resultRate = pattern === 'unresulted_labs' ? 0.15 : 0.9;
      if (!rng.chance(resultRate)) {
        if (order === ORDERS.hba1c || rng.chance(0.5)) pending.push(order);
        continue;
      }
      const value = order === ORDERS.hba1c ? hba1cValue(rng, controlled) : undefined;
      const arrived = timeline.result(rng, order, orderId, consultation.end, {
        abnormal: false,
        ...(value === undefined ? {} : { analyteValues: [value] }),
      });
      if (arrived && value !== undefined) lastHba1c = value;
    }
    index += 1;
    if (!controlled && rng.chance(0.3)) controlled = true;
    const interval = followUp ? followUpDays(followUp) + rng.int(-6, 14) : rng.int(100, 180);
    const attends = index < visitsPlanned;
    visit = scheduleNext(ctx, consultation.end, dayOf(consultation.end) + interval, {
      booked: followUp !== undefined && rng.chance(0.85),
      attends,
      minutes: 30,
      description: 'Control de diabetes',
    });
    day += interval;
  }
}

function hypertension(ctx: Context, pattern: PatientPattern): void {
  const { rng, timeline } = ctx;
  const conditions: ConditionDefinition[] = [CONDITIONS.hypertension];
  if (rng.chance(0.4)) conditions.push(CONDITIONS.dyslipidemia);
  if (pattern === 'abnormal_result' && rng.chance(0.5)) conditions.push(CONDITIONS.ckd3);
  const medications: MedicationDefinition[] = [
    rng.pick([MEDICATIONS.losartan, MEDICATIONS.enalapril, MEDICATIONS.amlodipine]),
  ];
  if (conditions.includes(CONDITIONS.dyslipidemia)) medications.push(MEDICATIONS.atorvastatin);
  let controlled = rng.chance(0.55);
  const diagnosisYear = BASE_DATE.getUTCFullYear() - rng.int(3, 20);
  const visitsPlanned = pattern === 'hypertension_dropout' ? rng.int(2, 3) : 99;
  let visit: Visit | undefined = {
    start: visitTime(rng, -HISTORY_DAYS + rng.int(0, pattern === 'abnormal_result' ? 300 : 150)),
  };
  let lastLabs = -Infinity;
  let abnormalDone = false;
  let index = 0;

  while (visit) {
    const orders: OrderDefinition[] = [];
    if (dayOf(visit.start) - lastLabs >= 170) {
      orders.push(ORDERS.creatinine, ORDERS.potassium);
      if (index % 2 === 0) orders.push(ORDERS.lipidPanel);
      lastLabs = dayOf(visit.start);
    }
    if (index === 0 && rng.chance(0.6)) orders.push(ORDERS.ecg);
    if (!controlled && index > 0 && medications.length < 3) {
      const next = [MEDICATIONS.amlodipine, MEDICATIONS.hydrochlorothiazide].find(
        (med) => !medications.includes(med),
      );
      if (next) medications.push(next);
    }
    const followUp = maybePlan(ctx, { amount: controlled ? rng.pick([4, 6]) : 2, unit: 'meses' });
    record(ctx, followUp !== undefined);
    const consultation = timeline.consultation({
      start: visit.start,
      minutes: rng.int(20, 30),
      visitType: index === 0 ? 'Primera consulta' : 'Consulta de control',
      reason: 'Control de hipertensión arterial',
      ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
      noteText: hypertensionNote({
        rng,
        sex: ctx.sex,
        age: ageAt(ctx, visit.start),
        weightKg: ctx.weightKg,
        firstVisit: index === 0,
        yearsSinceDiagnosis: visit.start.getUTCFullYear() - diagnosisYear,
        conditions,
        medications,
        orders,
        reorders: [],
        controlled,
        ...(followUp ? { followUp } : {}),
      }),
      conditions,
      medications,
      orders,
    });
    let recall: Date | undefined;
    for (const [order, orderId] of consultation.orderIds) {
      if (!rng.chance(0.88)) continue;
      const abnormal =
        pattern === 'abnormal_result' &&
        !abnormalDone &&
        (order === ORDERS.creatinine || order === ORDERS.potassium);
      const analyteValues = abnormal
        ? [order === ORDERS.creatinine ? rng.around(1.8, 0.2, 2) : rng.around(5.7, 0.2, 1)]
        : undefined;
      const arrived = timeline.result(rng, order, orderId, consultation.end, {
        abnormal: false,
        ...(analyteValues ? { analyteValues } : {}),
      });
      if (arrived && abnormal) {
        abnormalDone = true;
        // Half of them are recalled within a week of the abnormal result.
        if (rng.chance(0.5)) recall = plusDays(consultation.end, rng.int(8, 13));
      }
    }
    index += 1;
    if (rng.chance(0.4)) controlled = true;
    const interval = followUp ? followUpDays(followUp) + rng.int(-7, 15) : rng.int(120, 200);
    if (recall && recall < BASE_DATE) {
      visit = { start: visitTime(rng, dayOf(recall)) };
      continue;
    }
    visit = scheduleNext(ctx, consultation.end, dayOf(consultation.end) + interval, {
      booked: followUp !== undefined && rng.chance(0.8),
      attends: index < visitsPlanned,
      minutes: 30,
      description: 'Control de HTA',
    });
  }
}

const ACUTE_EPISODES: readonly {
  readonly condition: ConditionDefinition;
  readonly medications: readonly MedicationDefinition[];
  readonly orders: readonly OrderDefinition[];
}[] = [
  {
    condition: CONDITIONS.uti,
    medications: [MEDICATIONS.nitrofurantoin],
    orders: [ORDERS.urinalysis],
  },
  { condition: CONDITIONS.uti, medications: [MEDICATIONS.nitrofurantoin], orders: [] },
  {
    condition: CONDITIONS.pharyngitis,
    medications: [MEDICATIONS.amoxicillin, MEDICATIONS.ibuprofen],
    orders: [],
  },
  { condition: CONDITIONS.uri, medications: [MEDICATIONS.azithromycin], orders: [ORDERS.cbc] },
  { condition: CONDITIONS.gastritis, medications: [MEDICATIONS.omeprazole], orders: [] },
  { condition: CONDITIONS.lowBackPain, medications: [MEDICATIONS.ibuprofen], orders: [] },
];

function shortTreatment(ctx: Context): void {
  const { rng, timeline } = ctx;
  const episodes = rng.chance(0.3) ? 2 : 1;
  let day = -rng.int(30, HISTORY_DAYS - 30);
  for (let episode = 0; episode < episodes; episode++) {
    const { condition, medications, orders } = rng.pick(ACUTE_EPISODES);
    const followUp = rng.chance(0.4)
      ? { amount: rng.pick([7, 10]), unit: 'días' as const }
      : undefined;
    record(ctx, followUp !== undefined);
    const start = visitTime(rng, day);
    const consultation = timeline.consultation({
      start,
      minutes: rng.int(15, 25),
      visitType: 'Consulta por morbilidad',
      reason: condition.noteName,
      noteText: acuteNote({
        rng,
        sex: ctx.sex,
        age: ageAt(ctx, start),
        condition,
        medications,
        orders,
        ...(followUp ? { followUp } : {}),
      }),
      conditions: [condition],
      medications,
      orders,
    });
    for (const [order, orderId] of consultation.orderIds) {
      if (rng.chance(0.7))
        timeline.result(rng, order, orderId, consultation.end, { abnormal: false });
    }
    const longest = Math.max(...medications.map((med) => med.durationDays ?? 0));
    if (rng.chance(0.45)) {
      const controlDay =
        dayOf(consultation.end) + (followUp ? followUpDays(followUp) : longest + rng.int(1, 3));
      const controlStart = visitTime(rng, controlDay);
      if (controlStart <= BASE_DATE) {
        record(ctx, true); // discharge note: an explicit decision, no follow-up needed
        timeline.consultation({
          start: controlStart,
          minutes: 15,
          visitType: 'Consulta de control',
          reason: `Control post tratamiento: ${condition.noteName}`,
          noteText: rng.pick([
            `Pcte acude a control post tto por ${condition.noteName}. Completó tratamiento. ${ctx.sex === 'female' ? 'Asintomática' : 'Asintomático'}. Se da de alta.`,
            `Control. Cumplió ${medications[0]?.text.toLowerCase() ?? 'tto'} completo, mejoría clínica total. Alta.`,
          ]),
          conditions: [],
          medications: [],
          orders: [],
        });
      }
    }
    day = Math.min(-5, day + rng.int(90, 300));
  }
}

function psychology(ctx: Context, pattern: PatientPattern): void {
  const { rng, timeline } = ctx;
  const condition = rng.pick([
    CONDITIONS.anxiety,
    CONDITIONS.adjustment,
    CONDITIONS.depression,
    CONDITIONS.insomnia,
    CONDITIONS.panic,
  ]);
  const cadence: FollowUp = pattern.startsWith('weekly')
    ? { amount: 1, unit: 'semanas' }
    : pattern.startsWith('biweekly')
      ? { amount: 15, unit: 'días' }
      : { amount: 1, unit: 'meses' };
  const sessions =
    pattern === 'weekly_discharged'
      ? rng.int(8, 14)
      : pattern === 'weekly_dropout'
        ? rng.int(3, 8)
        : pattern === 'monthly_dropout'
          ? rng.int(3, 6)
          : pattern === 'biweekly_dropout'
            ? rng.int(3, 6)
            : 99;
  const span = followUpDays(cadence) * Math.min(sessions, 20);
  const startDay =
    pattern === 'monthly_ongoing' ? -rng.int(150, 400) : -rng.int(span + 60, HISTORY_DAYS);
  let visit: Visit | undefined = { start: visitTime(rng, startDay) };
  let number = 1;
  const virtual = rng.chance(0.3);
  while (visit) {
    const discharge = pattern === 'weekly_discharged' && number === sessions;
    const followUp = discharge ? undefined : maybePlan(ctx, cadence, 0.3);
    record(ctx, followUp !== undefined || discharge);
    const consultation = timeline.consultation({
      start: visit.start,
      minutes: 50,
      visitType: number === 1 ? 'Primera sesión' : 'Sesión de psicoterapia',
      ...(virtual && number > 1 ? { virtual: true } : {}),
      ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
      noteText: psychologyNote({
        rng,
        sex: ctx.sex,
        age: ageAt(ctx, visit.start),
        sessionNumber: number,
        condition,
        ...(followUp ? { followUp } : {}),
        ...(discharge ? { discharge } : {}),
      }),
      conditions: number === 1 ? [condition] : [],
      medications: [],
      orders: [],
    });
    if (discharge) break;
    number += 1;
    visit = scheduleNext(
      ctx,
      consultation.end,
      dayOf(consultation.end) + followUpDays(cadence) + rng.int(-1, 2),
      {
        booked: rng.chance(0.85),
        attends: number <= sessions,
        minutes: 50,
        description: 'Sesión de psicoterapia',
      },
    );
  }
}

function annualControl(ctx: Context): void {
  const { rng, timeline } = ctx;
  let visit: Visit | undefined = { start: visitTime(rng, -HISTORY_DAYS + rng.int(0, 300)) };
  const visits = rng.int(1, 2);
  let index = 0;
  while (visit) {
    const age = ageAt(ctx, visit.start);
    const orders: OrderDefinition[] = [ORDERS.pap];
    if (age >= 40) orders.push(ORDERS.mammography);
    // Either "come back with the results in a month" or "see you next year".
    const withResults = rng.chance(0.6);
    const followUp = maybePlan(
      ctx,
      withResults ? { amount: 1, unit: 'meses' } : { amount: 12, unit: 'meses' },
    );
    record(ctx, followUp !== undefined);
    const condition = age >= 48 ? CONDITIONS.menopause : CONDITIONS.gynExam;
    const consultation = timeline.consultation({
      start: visit.start,
      minutes: 25,
      visitType: 'Control ginecológico',
      ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
      noteText: gynecologyNote({
        rng,
        age,
        kind: 'annual',
        condition,
        medications: [],
        orders,
        gravida: ctx.gravida,
        ...(followUp ? { followUp } : {}),
      }),
      conditions: [condition],
      medications: [],
      orders,
    });
    for (const [order, orderId] of consultation.orderIds) {
      const rate = order === ORDERS.mammography ? 0.7 : 0.9;
      if (rng.chance(rate))
        timeline.result(rng, order, orderId, consultation.end, { abnormal: rng.chance(0.12) });
    }
    if (withResults && followUp && rng.chance(0.6)) {
      const resultsVisit = scheduleNext(
        ctx,
        consultation.end,
        dayOf(consultation.end) + rng.int(28, 40),
        {
          booked: rng.chance(0.5),
          attends: true,
          minutes: 15,
          description: 'Revisión de resultados',
        },
      );
      if (resultsVisit) {
        const annual: FollowUp = { amount: 1, unit: 'meses' };
        const plan = maybePlan(ctx, { ...annual, amount: 12 });
        record(ctx, plan !== undefined);
        timeline.consultation({
          start: resultsVisit.start,
          minutes: 15,
          visitType: 'Revisión de resultados',
          ...(resultsVisit.appointmentId ? { appointmentId: resultsVisit.appointmentId } : {}),
          noteText: gynecologyNote({
            rng,
            age,
            kind: 'results',
            condition,
            medications: [],
            orders: [],
            gravida: ctx.gravida,
            ...(plan ? { followUp: plan } : {}),
          }),
          conditions: [],
          medications: [],
          orders: [],
        });
      }
    }
    index += 1;
    visit = scheduleNext(ctx, consultation.end, dayOf(consultation.end) + rng.int(340, 400), {
      booked: false,
      attends: index < visits,
      minutes: 30,
      description: 'Control ginecológico anual',
    });
  }
}

function pregnancy(ctx: Context, missesPostpartum: boolean): void {
  const { rng, timeline } = ctx;
  // Delivery day relative to the base date; ongoing pregnancies are allowed when the postpartum visit is not the point.
  const deliveryDay = missesPostpartum ? -rng.int(80, 500) : -rng.int(-40, 500);
  const firstWeek = rng.int(8, 12);
  const lmpDay = deliveryDay - 7 * rng.int(38, 40);
  const gravida = ctx.gravida + 1;
  let week = firstWeek;
  let appointmentId: string | undefined;
  while (week <= 38) {
    const start = visitTime(rng, lmpDay + week * 7);
    if (start > BASE_DATE) break;
    const orders: OrderDefinition[] = [];
    if (week === firstWeek)
      orders.push(ORDERS.cbc, ORDERS.glucose, ORDERS.urinalysis, ORDERS.obstetricUs);
    if (week >= 20 && week < 24) orders.push(ORDERS.obstetricUs);
    if (week >= 32 && week < 34) orders.push(ORDERS.obstetricUs);
    const medications =
      week === firstWeek ? [MEDICATIONS.folicAcid, MEDICATIONS.ferrousSulfate] : [];
    const step = week < 28 ? 4 : 2;
    const followUp = maybePlan(ctx, { amount: step, unit: 'semanas' }, 0.15);
    record(ctx, followUp !== undefined);
    const consultation = timeline.consultation({
      start,
      minutes: 30,
      visitType: 'Control prenatal',
      ...(appointmentId ? { appointmentId } : {}),
      noteText: gynecologyNote({
        rng,
        age: ageAt(ctx, start),
        kind: 'prenatal',
        condition: CONDITIONS.pregnancy,
        medications,
        orders,
        gestationalWeeks: week,
        gravida,
        ...(followUp ? { followUp } : {}),
      }),
      conditions: [CONDITIONS.pregnancy],
      medications,
      orders,
    });
    for (const [order, orderId] of consultation.orderIds) {
      if (rng.chance(0.85))
        timeline.result(rng, order, orderId, consultation.end, { abnormal: rng.chance(0.08) });
    }
    week += step;
    const nextStart = visitTime(rng, lmpDay + week * 7);
    appointmentId =
      week <= 38
        ? timeline.book(plusDays(consultation.end, 10 / 1440), nextStart, 30, 'Control prenatal')
        : undefined;
  }
  // Delivery happens at a hospital (no record here); the puerperal visit comes 7 to 12 days later.
  const postpartumStart = visitTime(rng, deliveryDay + rng.int(7, 12));
  if (postpartumStart > BASE_DATE) return;
  const postpartumDays = Math.round(dayOf(postpartumStart) - deliveryDay);
  const followUp: FollowUp = { amount: 6, unit: 'semanas' };
  record(ctx, true);
  const consultation = timeline.consultation({
    start: postpartumStart,
    minutes: 25,
    visitType: 'Control puerperal',
    noteText: gynecologyNote({
      rng,
      age: ageAt(ctx, postpartumStart),
      kind: 'postpartum',
      condition: CONDITIONS.postpartum,
      medications: [],
      orders: [],
      postpartumDays,
      gravida,
      followUp,
    }),
    conditions: [CONDITIONS.postpartum],
    medications: [],
    orders: [],
  });
  const next = scheduleNext(ctx, consultation.end, dayOf(consultation.end) + 42 + rng.int(-3, 4), {
    booked: rng.chance(0.7),
    attends: !missesPostpartum,
    minutes: 30,
    description: 'Control puerperal',
  });
  if (!next) return;
  record(ctx, false);
  timeline.consultation({
    start: next.start,
    minutes: 25,
    visitType: 'Control puerperal',
    ...(next.appointmentId ? { appointmentId: next.appointmentId } : {}),
    noteText: gynecologyNote({
      rng,
      age: ageAt(ctx, next.start),
      kind: 'postpartum',
      condition: CONDITIONS.postpartum,
      medications: [MEDICATIONS.combinedPill],
      orders: [],
      postpartumDays: postpartumDays + 42,
      gravida,
    }),
    conditions: [CONDITIONS.postpartum, CONDITIONS.contraception],
    medications: [MEDICATIONS.combinedPill],
    orders: [],
  });
}

function gynecologyAcute(ctx: Context): void {
  const { rng, timeline } = ctx;
  if (rng.chance(0.67)) {
    const candidiasis = rng.chance(0.5);
    const condition = candidiasis ? CONDITIONS.candidiasis : CONDITIONS.vaginitis;
    const medications = [candidiasis ? MEDICATIONS.fluconazole : MEDICATIONS.metronidazole];
    const followUp = rng.chance(0.3) ? { amount: 15, unit: 'días' as const } : undefined;
    record(ctx, followUp !== undefined);
    const start = visitTime(rng, -rng.int(20, HISTORY_DAYS - 10));
    timeline.consultation({
      start,
      minutes: 20,
      visitType: 'Consulta por morbilidad',
      reason: condition.noteName,
      noteText: gynecologyNote({
        rng,
        age: ageAt(ctx, start),
        kind: 'acute',
        condition,
        medications,
        orders: [],
        gravida: ctx.gravida,
        ...(followUp ? { followUp } : {}),
      }),
      conditions: [condition],
      medications,
      orders: [],
    });
    return;
  }
  // Polycystic ovary syndrome on combined pills, controlled every 3 to 6 months.
  let visit: Visit | undefined = { start: visitTime(rng, -rng.int(300, HISTORY_DAYS - 30)) };
  let index = 0;
  const visits = rng.int(2, 4);
  while (visit) {
    const orders = index === 0 ? [ORDERS.glucose, ORDERS.tsh] : [];
    const followUp = maybePlan(ctx, { amount: rng.pick([3, 6]), unit: 'meses' });
    record(ctx, followUp !== undefined);
    const consultation = timeline.consultation({
      start: visit.start,
      minutes: 25,
      visitType: index === 0 ? 'Primera consulta' : 'Consulta de control',
      ...(visit.appointmentId ? { appointmentId: visit.appointmentId } : {}),
      noteText: gynecologyNote({
        rng,
        age: ageAt(ctx, visit.start),
        kind: 'pcos',
        condition: CONDITIONS.pcos,
        medications: [MEDICATIONS.combinedPill],
        orders,
        gravida: ctx.gravida,
        ...(followUp ? { followUp } : {}),
      }),
      conditions: [CONDITIONS.pcos],
      medications: [MEDICATIONS.combinedPill],
      orders,
    });
    for (const [order, orderId] of consultation.orderIds) {
      if (rng.chance(0.85))
        timeline.result(rng, order, orderId, consultation.end, { abnormal: false });
    }
    index += 1;
    visit = scheduleNext(
      ctx,
      consultation.end,
      dayOf(consultation.end) + (followUp ? followUpDays(followUp) : 150) + rng.int(-5, 15),
      {
        booked: followUp !== undefined,
        attends: index < visits,
        minutes: 25,
        description: 'Control SOP',
      },
    );
  }
}

function ageFor(rng: Prng, specialty: Specialty, pattern: PatientPattern): number {
  switch (specialty) {
    case 'diabetology':
      return rng.int(38, 78);
    case 'internal_medicine':
      return pattern === 'short_treatment' ? rng.int(19, 70) : rng.int(42, 82);
    case 'psychology':
      return rng.int(19, 58);
    case 'gynecology':
      return pattern.startsWith('pregnancy')
        ? rng.int(19, 39)
        : pattern === 'annual_control'
          ? rng.int(25, 62)
          : rng.int(18, 45);
  }
}

function generatePatient(
  rng: Prng,
  index: number,
  specialty: Specialty,
  pattern: PatientPattern,
  usedNames: Set<string>,
  stats: { consultations: number; withoutPlan: number },
): SyntheticPatient {
  const patientId = `pat-${String(index).padStart(4, '0')}`;
  const sex: 'female' | 'male' =
    specialty === 'gynecology'
      ? 'female'
      : rng.chance(specialty === 'psychology' ? 0.62 : 0.52)
        ? 'female'
        : 'male';
  let name = personName(rng, sex);
  while (usedNames.has(nameKey(name))) name = personName(rng, sex);
  usedNames.add(nameKey(name));
  const age = ageFor(rng, specialty, pattern);
  const birth = new Date(
    Date.UTC(BASE_DATE.getUTCFullYear() - age, rng.int(0, 11), rng.int(1, 28)),
  );
  if (birth > plusDays(BASE_DATE, -age * 365.25)) birth.setUTCFullYear(birth.getUTCFullYear() - 1);
  const patient: PatientInput = {
    id: patientId,
    mrn: `HC-${String(10_000 + index * 37)}`,
    name,
    gender: sex,
    birthDate: isoDate(birth),
  };
  const practitioners = PRACTITIONERS.filter(
    (practitioner) => practitioner.specialty === specialty,
  );
  const practitioner = practitioners[index % practitioners.length] ?? PRACTITIONERS[0];
  if (!practitioner) throw new Error('no practitioners');
  const timeline = new PatientTimeline(patient, specialty, practitioner.id);
  const ctx: Context = {
    rng,
    timeline,
    sex,
    birthDate: birth,
    weightKg: sex === 'female' ? rng.int(54, 92) : rng.int(64, 104),
    gravida: sex === 'female' && age > 22 ? rng.int(0, 3) : 0,
    stats,
  };

  switch (pattern) {
    case 'adherent':
    case 'dropout':
    case 'unresulted_labs':
    case 'new_patient':
    case 'no_plan_notes':
      diabetes(ctx, pattern);
      break;
    case 'hypertension_adherent':
    case 'hypertension_dropout':
    case 'abnormal_result':
      hypertension(ctx, pattern);
      break;
    case 'short_treatment':
      shortTreatment(ctx);
      break;
    case 'weekly_discharged':
    case 'weekly_dropout':
    case 'monthly_ongoing':
    case 'monthly_dropout':
    case 'biweekly_dropout':
      psychology(ctx, pattern);
      break;
    case 'annual_control':
      annualControl(ctx);
      break;
    case 'pregnancy_postpartum':
      pregnancy(ctx, false);
      break;
    case 'pregnancy_missed_postpartum':
      pregnancy(ctx, true);
      break;
    case 'acute_or_short':
      gynecologyAcute(ctx);
      break;
  }

  return {
    clinicId: DEMO_CLINIC_ID,
    patientId,
    name: `${name.given.join(' ')} ${name.family.join(' ')}`,
    gender: sex,
    birthDate: patient.birthDate,
    specialty,
    pattern,
    entries: timeline.sorted(),
  };
}

/**
 * Generates the synthetic demo clinic: about 120 fictional patients across
 * four specialties with two years of history ending at {@link BASE_DATE}.
 * Pure and deterministic: same seed, same output, no network.
 */
export function generateSyntheticClinic(seed: number = DEFAULT_SEED): SyntheticClinic {
  const root = new Prng(seed);
  const usedNames = new Set<string>();
  const counters = { consultations: 0, withoutPlan: 0 };
  const patients: SyntheticPatient[] = [];
  let index = 1;
  for (const [specialty, pattern, count] of PATTERN_COUNTS) {
    for (let n = 0; n < count; n++) {
      patients.push(
        generatePatient(
          root.fork(`patient-${String(index)}`),
          index,
          specialty,
          pattern,
          usedNames,
          counters,
        ),
      );
      index += 1;
    }
  }

  const bundlesByKind: Record<string, number> = {};
  const patientsByPattern: Record<string, number> = {};
  const patientsBySpecialty: Record<Specialty, number> = {
    diabetology: 0,
    internal_medicine: 0,
    psychology: 0,
    gynecology: 0,
  };
  for (const patient of patients) {
    patientsBySpecialty[patient.specialty] += 1;
    patientsByPattern[patient.pattern] = (patientsByPattern[patient.pattern] ?? 0) + 1;
    for (const entry of patient.entries)
      bundlesByKind[entry.kind] = (bundlesByKind[entry.kind] ?? 0) + 1;
  }

  return {
    clinic: {
      clinicId: DEMO_CLINIC_ID,
      name: DEMO_CLINIC_NAME,
      baseDate: BASE_DATE.toISOString(),
      seed,
      synthetic: true,
      organization: organizationResource(),
      practitioners: PRACTITIONERS.map(practitionerResource),
      practitionerRoles: PRACTITIONERS.map(practitionerRoleResource),
      stats: {
        patients: patients.length,
        patientsBySpecialty,
        patientsByPattern,
        bundles: Object.values(bundlesByKind).reduce((sum, count) => sum + count, 0),
        bundlesByKind,
        consultations: counters.consultations,
        notesWithoutPlan: counters.withoutPlan,
      },
    },
    patients,
  };
}
