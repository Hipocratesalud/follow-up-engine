import {
  DEFAULT_BOOKING_TOLERANCE_DAYS,
  DEFAULT_BOOKING_TOLERANCE_FRACTION,
} from '../../config/common.ts';
import {
  itemSchedule,
  type Protocol,
  type ProtocolItem,
  type ProtocolSchedule,
  type ProtocolStatus,
} from '../../config/protocol.ts';
import { DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS } from '../../config/rule.ts';
import type {
  ClinicalEvent,
  ClinicalEventType,
  EncounterFinishedEvent,
  MedicationPrescribedEvent,
  NoteReceivedEvent,
  PlanItem,
  PlanItemKind,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { Coding } from '../../domain/resource.ts';
import { type EnrollmentResult, icd10Matches, meetsThreshold } from '../annotator/conditions.ts';
import {
  dischargedEncounters,
  patternVisits,
  usualIntervalDays,
} from '../annotator/layers/cadence.ts';
import { equivalentMatchKeys } from '../annotator/layers/protocol.ts';
import type { Catalog, ExpectationDefinition } from '../catalog.ts';
import { codeOfEvent, matchesShape } from '../matching/correlation.ts';
import { kindOfMatchKey, parseCodeMatchKey } from '../matching/match-key.ts';
import { type EpisodeEnd, protocolEpisode } from '../protocols/episodes.ts';
import { gestationalAgeAt } from '../protocols/gestational-age.ts';
import { type CkdStage, ckdStage } from '../protocols/kidney.ts';
import { medicationMatches, treatmentChanges } from '../protocols/treatment-changes.ts';
import { addDays } from '../support/time.ts';
import { equivalentCodes } from '../terminology/loinc.ts';
import { encounterOf, eventInstant, PatientTimeline, refKey } from '../timeline.ts';

const MS_PER_DAY = 86_400_000;

/**
 * Why an expectation exists, recomputed from the stored record and the
 * clinic's catalog with the same functions the annotator uses (HIP-142):
 * what it counts from, how its due date was computed, what enrolled the
 * patient in its protocol, the visit pattern behind a cadence break, and
 * what would fulfill it. Nothing in it is invented: every event is one of
 * the patient's own, every number comes from the record or the config.
 * Machine data only; the API words it in the reader's language.
 */
export interface ExpectationExplanation {
  readonly expectationId: Expectation['id'];
  readonly layer: Expectation['layer'];
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly due: DueExplanation;
  readonly fulfilledBy: FulfillmentExplanation;
  /** The event that closed it (the result, the visit, the booking), when it is still in the record. */
  readonly closedBy?: ClinicalEvent;
  /** `doctor_plan`: the note and the plan item read from it. */
  readonly plan?: PlanExplanation;
  /** `protocol`: the protocol, its schedule and what enrolled the patient. */
  readonly protocol?: ProtocolExplanation;
  /** `cadence`: the visits that make the patient's pattern. */
  readonly cadence?: CadenceExplanation;
}

/** How the due date was computed. */
export const DUE_BASES = [
  /** `universal`: the trigger plus the rule's `dueInDays`. */
  'rule_days',
  /** `universal`, a panic result: the result plus `criticalDueInDays`. */
  'critical_result',
  /** `universal`: the end of a short treatment plus the rule's `dueInDays`. */
  'treatment_end',
  /** `doctor_plan`: the date the doctor gave in the note. */
  'plan_date',
  /** `cadence`: the latest visit plus `multiplier` times the usual interval. */
  'cadence',
  /** `protocol`: `everyDays` after the last time it happened, else after enrollment. */
  'protocol_interval',
  /** `protocol`: a control after a treatment change, then a titration or a yearly interval. */
  'protocol_treatment_change',
  /** `protocol`: the prenatal interval for the gestational age at the last visit. */
  'protocol_gestational_age',
  /** `protocol`: the end of a gestational window (the OGTT at 24-28 weeks). */
  'protocol_gestational_window',
  /** `protocol`: within days of an episode's outcome (the postpartum visit). */
  'protocol_after_outcome',
  /** `protocol`: the interval of the patient's CKD stage (KDIGO). */
  'protocol_ckd_stage',
] as const;
export type DueBasis = (typeof DUE_BASES)[number];

/** What the anchor of the due date is to the expectation. */
export const ANCHOR_ROLES = [
  /** The order, prescription, result or visit that triggered a rule. */
  'trigger',
  /** The note whose plan asked for it. */
  'note',
  /** The latest visit of the specialty (cadence). */
  'last_visit',
  /** The last time the protocol item happened (the last HbA1c). */
  'last_done',
  /** The record that enrolled the patient (the item never happened). */
  'enrollment',
  /** The prescription that started or changed the treatment. */
  'treatment_change',
  /** What ended the episode (the delivery). */
  'episode_end',
  /** The first record once a gestational window opened. */
  'window_open',
  /** The anchor is no longer in the record. */
  'unknown',
] as const;
export type AnchorRole = (typeof ANCHOR_ROLES)[number];

export interface DueExplanation {
  readonly basis: DueBasis;
  readonly anchorRole: AnchorRole;
  /** The event the due date counts from, when still in the record. */
  readonly anchor?: ClinicalEvent;
  /** When the anchor happened (a booking: its scheduled date). */
  readonly anchorAt?: Date;
  /** Days from `anchorAt` to `dueAt`, the interval the engine really applied (rounded). */
  readonly days?: number;
  /** The interval the config states, when it is one number (`dueInDays`, `everyDays`). */
  readonly configuredDays?: number;
  /** `treatment_end`: days the treatment covers, counted from its start. */
  readonly treatmentDays?: number;
  readonly dueAt: Date;
  /**
   * `treatment_change`: what was done too soon after the change to count as
   * its control (a TSH a week after a new dose); the control stays due.
   */
  readonly tooEarly?: ClinicalEvent;
  /**
   * A booking up to this many days after `dueAt` still fulfills it
   * (`toleranceDays` / `toleranceFraction`), when a booking can fulfill it.
   */
  readonly bookingToleranceDays?: number;
}

export interface FulfillmentExplanation {
  /** What is expected: a visit, a lab, imaging, a session. */
  readonly expects: PlanItemKind;
  /** The test it asks for, when coded. */
  readonly code?: Coding;
  /** Other codes of the same measurement that count (equivalent LOINC, the item's group). */
  readonly equivalentCodes: readonly string[];
  /** It waits for the result of this order (`ServiceRequest` id). */
  readonly orderId?: string;
  /** Event types that fulfill it (`result.received`, `encounter.finished`, `appointment.booked`). */
  readonly events: readonly ClinicalEventType[];
  /** Visits must be of one of these specialties. */
  readonly specialties: readonly string[];
}

export interface PlanExplanation {
  readonly documentId: string;
  readonly quote: string;
  /** The note, when still in the record (its full text). */
  readonly note?: NoteReceivedEvent;
  /** The plan item read from the note with this quote. */
  readonly item?: PlanItem;
  readonly specialty?: string;
  readonly practitionerId?: string;
}

/** What enrolled the patient in a protocol. */
export const ENROLLMENT_BASES = ['diagnosis', 'note', 'medication', 'results', 'record'] as const;
export type EnrollmentBasis = (typeof ENROLLMENT_BASES)[number];

export interface EnrollmentExplanation {
  /** `not_enrolled`: the record no longer enrolls the patient (the expectation came from before). */
  readonly episode: 'active' | 'ended' | 'not_enrolled';
  readonly condition?: PatientCondition;
  readonly basis?: EnrollmentBasis;
  /**
   * The patient's records that enroll them, oldest first: the coded
   * diagnosis, the note that states it, the prescription, or every result
   * past the threshold.
   */
  readonly evidence: readonly ClinicalEvent[];
  /** `results`: the threshold those results crossed. */
  readonly threshold?: {
    readonly code: Coding;
    readonly gte?: number;
    readonly lt?: number;
    readonly confirm?: { readonly count: number; readonly minDaysApart: number };
  };
  /** A treatment protocol: the active prescription that keeps the patient in it. */
  readonly activeTreatment?: MedicationPrescribedEvent;
  /** An ended episode: what ended it and how. */
  readonly endedBy?: ClinicalEvent;
  readonly outcome?: EpisodeEnd;
}

export interface ProtocolExplanation {
  readonly protocolId: string;
  /** The version that created the expectation. */
  readonly version: string;
  /** The version the clinic runs today, with its validation status; absent when no longer enabled. */
  readonly currentVersion?: string;
  readonly status?: ProtocolStatus;
  readonly itemKey?: string;
  readonly schedule?: ProtocolSchedule;
  readonly enrollment: EnrollmentExplanation;
  /** `ckd_stage`: the stage the interval was chosen by. */
  readonly ckdStage?: CkdStage;
  /** `gestational_age`: weeks of gestation at the anchor. */
  readonly gestationalWeeks?: number;
}

export interface CadenceExplanation {
  readonly specialty?: string;
  /** Every visit of the specialty up to the anchor, oldest first. */
  readonly visits: readonly EncounterFinishedEvent[];
  /** Encounter ids of the visits that make the pattern (closed episodes left out). */
  readonly patternVisitIds: readonly string[];
  /** The median interval between pattern visits, in days. */
  readonly usualIntervalDays?: number;
  readonly multiplier?: number;
  readonly minPreviousVisits?: number;
}

export interface ExplainInput {
  readonly catalog: Catalog;
  /** The patient's conditions as stored. */
  readonly conditions: readonly PatientCondition[];
  /** The patient's events as stored (any order). */
  readonly events: readonly ClinicalEvent[];
  readonly now: Date;
}

function daysFrom(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function encounterIdOf(encounter: EncounterFinishedEvent): string {
  return encounterOf(encounter) ?? encounter.source.id;
}

/**
 * Explains a patient's expectations over one reading of their record.
 *
 * @example
 * ```ts
 * const explain = createExplainer({ catalog, conditions, events, now });
 * const why = explain(expectation);
 * why.due; // { basis: 'protocol_interval', anchorRole: 'last_done', days: 90, ... }
 * ```
 */
export function createExplainer(
  input: ExplainInput,
): (expectation: Expectation) => ExpectationExplanation {
  const timeline = new PatientTimeline(input.events);
  // A closing event may be one the timeline dropped (a cancelled booking): look in every event.
  const anyBySource = new Map<string, ClinicalEvent>();
  for (const event of input.events) {
    const key = refKey(event.source);
    if (!anyBySource.has(key)) {
      anyBySource.set(key, event);
    }
  }
  return (expectation) => explain(expectation, input, timeline, anyBySource);
}

function explain(
  expectation: Expectation,
  input: ExplainInput,
  timeline: PatientTimeline,
  anyBySource: ReadonlyMap<string, ClinicalEvent>,
): ExpectationExplanation {
  const definition = input.catalog.definition(expectation.ruleId);
  const anchor =
    timeline.bySource(expectation.source) ?? anyBySource.get(refKey(expectation.source));
  const closedBy =
    expectation.closedBy === undefined
      ? undefined
      : (timeline.bySource(expectation.closedBy) ?? anyBySource.get(refKey(expectation.closedBy)));
  const base = {
    expectationId: expectation.id,
    layer: expectation.layer,
    ruleId: expectation.ruleId,
    ruleVersion: expectation.ruleVersion,
    ...(closedBy === undefined ? {} : { closedBy }),
  };
  switch (expectation.layer) {
    case 'universal':
      return {
        ...base,
        due: universalDue(expectation, input.catalog, anchor),
        fulfilledBy: fulfillment(expectation, definition, anchor, timeline, input.catalog),
      };
    case 'doctor_plan': {
      const plan = planOf(expectation, timeline);
      const note = plan.note ?? anchor;
      return {
        ...base,
        due: withTolerance(
          {
            basis: 'plan_date',
            anchorRole: note === undefined ? 'unknown' : 'note',
            ...anchorFields(note, expectation.dueAt),
            dueAt: expectation.dueAt,
          },
          definition,
          expectation,
        ),
        fulfilledBy: fulfillment(expectation, definition, anchor, timeline, input.catalog),
        plan,
      };
    }
    case 'cadence': {
      const cadence = cadenceOf(expectation, input.catalog, anchor, timeline);
      const rule = input.catalog.rules.find((candidate) => candidate.id === expectation.ruleId);
      return {
        ...base,
        due: withTolerance(
          {
            basis: 'cadence',
            anchorRole: anchor === undefined ? 'unknown' : 'last_visit',
            ...anchorFields(anchor, expectation.dueAt),
            ...(rule?.cadence === undefined || cadence.usualIntervalDays === undefined
              ? {}
              : {
                  configuredDays: Math.round(rule.cadence.multiplier * cadence.usualIntervalDays),
                }),
            dueAt: expectation.dueAt,
          },
          definition,
          expectation,
        ),
        fulfilledBy: fulfillment(expectation, definition, anchor, timeline, input.catalog),
        cadence,
      };
    }
    case 'protocol':
      return {
        ...base,
        ...protocolOf(expectation, definition, anchor, input, timeline),
        fulfilledBy: fulfillment(expectation, definition, anchor, timeline, input.catalog),
      };
  }
}

function anchorFields(
  anchor: ClinicalEvent | undefined,
  dueAt: Date,
): { anchor?: ClinicalEvent; anchorAt?: Date; days?: number } {
  if (anchor === undefined) {
    return {};
  }
  const at = anchor.type === 'note.received' ? anchor.authoredAt : eventInstant(anchor);
  return { anchor, anchorAt: at, days: daysFrom(at, dueAt) };
}

/** The booking tolerance of the definition's `appointment.booked` correlation, if any. */
function withTolerance(
  due: DueExplanation,
  definition: ExpectationDefinition | undefined,
  expectation: Expectation,
): DueExplanation {
  const kind = kindOfMatchKey(expectation.matchKey);
  const booking = definition?.fulfilledBy.find(
    (correlation) =>
      correlation.event === 'appointment.booked' &&
      (correlation.forKinds === undefined || correlation.forKinds.includes(kind)),
  );
  if (booking === undefined) {
    return due;
  }
  if (expectation.severity === 'critical') {
    return { ...due, bookingToleranceDays: 0 };
  }
  const floor = booking.toleranceDays ?? DEFAULT_BOOKING_TOLERANCE_DAYS;
  const fraction = booking.toleranceFraction ?? DEFAULT_BOOKING_TOLERANCE_FRACTION;
  const interval =
    due.anchorAt === undefined
      ? expectation.dueAt.getTime() - expectation.createdAt.getTime()
      : expectation.dueAt.getTime() - due.anchorAt.getTime();
  return {
    ...due,
    bookingToleranceDays: Math.max(
      floor,
      Math.ceil((Math.max(0, interval) / MS_PER_DAY) * fraction),
    ),
  };
}

function universalDue(
  expectation: Expectation,
  catalog: Catalog,
  anchor: ClinicalEvent | undefined,
): DueExplanation {
  const rule = catalog.rules.find((candidate) => candidate.id === expectation.ruleId);
  const definition = catalog.definition(expectation.ruleId);
  if (expectation.severity === 'critical') {
    return withTolerance(
      {
        basis: 'critical_result',
        anchorRole: anchor === undefined ? 'unknown' : 'trigger',
        ...anchorFields(anchor, expectation.dueAt),
        ...(rule === undefined
          ? {}
          : {
              configuredDays: Math.min(
                rule.dueInDays,
                rule.criticalDueInDays ?? DEFAULT_CRITICAL_RESULT_DUE_IN_DAYS,
              ),
            }),
        dueAt: expectation.dueAt,
      },
      definition,
      expectation,
    );
  }
  if (rule?.dueFrom === 'treatment_end' && anchor?.type === 'medication.prescribed') {
    return withTolerance(
      {
        basis: 'treatment_end',
        anchorRole: 'trigger',
        anchor,
        anchorAt: anchor.startAt,
        days: daysFrom(anchor.startAt, expectation.dueAt),
        configuredDays: rule.dueInDays,
        ...(anchor.durationDays === undefined ? {} : { treatmentDays: anchor.durationDays }),
        dueAt: expectation.dueAt,
      },
      definition,
      expectation,
    );
  }
  return withTolerance(
    {
      basis: 'rule_days',
      anchorRole: anchor === undefined ? 'unknown' : 'trigger',
      ...anchorFields(anchor, expectation.dueAt),
      ...(rule === undefined ? {} : { configuredDays: rule.dueInDays }),
      dueAt: expectation.dueAt,
    },
    definition,
    expectation,
  );
}

function fulfillment(
  expectation: Expectation,
  definition: ExpectationDefinition | undefined,
  anchor: ClinicalEvent | undefined,
  timeline: PatientTimeline,
  catalog: Catalog,
): FulfillmentExplanation {
  const kind = kindOfMatchKey(expectation.matchKey);
  const correlations = (definition?.fulfilledBy ?? []).filter(
    (correlation) => correlation.forKinds === undefined || correlation.forKinds.includes(kind),
  );
  const parsed = parseCodeMatchKey(expectation.matchKey);
  const code =
    (parsed !== undefined && definition?.code?.code === parsed.code ? definition.code : parsed) ??
    definition?.code ??
    (correlations.some((correlation) => correlation.match === 'same_code') && anchor !== undefined
      ? codeOfEvent(anchor)
      : undefined);
  const equivalents = new Set<string>();
  if (code !== undefined) {
    for (const other of equivalentCodes(code)) {
      equivalents.add(other);
    }
    const item = protocolItemOf(definition, catalog);
    if (item !== undefined) {
      for (const key of equivalentMatchKeys(item, expectation.matchKey)) {
        const parsed = parseCodeMatchKey(key);
        if (parsed !== undefined) {
          equivalents.add(parsed.code);
        }
      }
    }
    equivalents.delete(code.code);
  }
  const orderId =
    correlations.some((correlation) => correlation.match === 'same_order') &&
    anchor?.type === 'service_request.created'
      ? anchor.orderId
      : undefined;
  const sameSpecialty = correlations.some((correlation) => correlation.match === 'same_specialty');
  const anchorSpecialty = anchor === undefined ? undefined : timeline.specialtyOf(anchor);
  const specialties =
    definition?.specialties ??
    (sameSpecialty && anchorSpecialty !== undefined ? [anchorSpecialty] : []);
  return {
    expects: definition?.expects ?? kind,
    ...(code === undefined
      ? {}
      : {
          code: {
            system: code.system,
            code: code.code,
            ...(code.display === undefined ? {} : { display: code.display }),
          },
        }),
    equivalentCodes: [...equivalents].sort(),
    ...(orderId === undefined ? {} : { orderId }),
    events: [...new Set(correlations.map((correlation) => correlation.event))],
    specialties: [...specialties],
  };
}

/** The protocol item behind a protocol definition, if still in the catalog. */
function protocolItemOf(
  definition: ExpectationDefinition | undefined,
  catalog: Catalog,
): ProtocolItem | undefined {
  const origin = definition?.protocol;
  return origin === undefined
    ? undefined
    : catalog.protocols
        .find((protocol) => protocol.id === origin.id)
        ?.items.find((item) => item.key === origin.itemKey);
}

function planOf(expectation: Expectation, timeline: PatientTimeline): PlanExplanation {
  const documentId = expectation.evidence?.sourceDocumentId ?? expectation.source.id;
  const quote = expectation.evidence?.quote ?? '';
  const note = timeline
    .ofType('note.received')
    .findLast((event) => event.documentId === documentId);
  const plan = timeline
    .ofType('plan.extracted')
    .findLast((event) => event.sourceDocumentId === documentId);
  const item = plan?.items.find((candidate) => candidate.evidenceQuote === quote);
  const specialty = note === undefined ? undefined : timeline.specialtyOf(note);
  const practitionerId = note === undefined ? undefined : timeline.practitionerOf(note);
  return {
    documentId,
    quote,
    ...(note === undefined ? {} : { note }),
    ...(item === undefined ? {} : { item }),
    ...(specialty === undefined ? {} : { specialty }),
    ...(practitionerId === undefined ? {} : { practitionerId }),
  };
}

function cadenceOf(
  expectation: Expectation,
  catalog: Catalog,
  anchor: ClinicalEvent | undefined,
  timeline: PatientTimeline,
): CadenceExplanation {
  const rule = catalog.rules.find((candidate) => candidate.id === expectation.ruleId);
  const current =
    anchor?.type === 'encounter.finished'
      ? (timeline.encounter(encounterIdOf(anchor)) ?? anchor)
      : undefined;
  if (current === undefined) {
    return { visits: [], patternVisitIds: [] };
  }
  const specialty = (current.specialty ?? '').trim().toLowerCase();
  const visits = timeline
    .encounters()
    .filter(
      (encounter) =>
        (encounter.specialty ?? '').trim().toLowerCase() === specialty &&
        encounter.occurredAt.getTime() <= current.occurredAt.getTime(),
    );
  if (rule?.cadence === undefined) {
    return {
      ...(current.specialty === undefined ? {} : { specialty: current.specialty }),
      visits,
      patternVisitIds: visits.map(encounterIdOf),
    };
  }
  const pattern = patternVisits(
    visits,
    rule.cadence,
    timeline,
    catalog,
    dischargedEncounters(timeline),
  );
  const interval = usualIntervalDays(pattern, rule.cadence);
  return {
    ...(current.specialty === undefined ? {} : { specialty: current.specialty }),
    visits,
    patternVisitIds: pattern.map(encounterIdOf),
    ...(interval === undefined ? {} : { usualIntervalDays: interval }),
    multiplier: rule.cadence.multiplier,
    minPreviousVisits: rule.cadence.minPreviousVisits,
  };
}

function protocolOf(
  expectation: Expectation,
  definition: ExpectationDefinition | undefined,
  anchor: ClinicalEvent | undefined,
  input: ExplainInput,
  timeline: PatientTimeline,
): { due: DueExplanation; protocol?: ProtocolExplanation } {
  const protocolId = expectation.protocolId ?? definition?.protocol?.id;
  const protocol = input.catalog.protocols.find((candidate) => candidate.id === protocolId);
  const item = protocol?.items.find((candidate) => candidate.key === definition?.protocol?.itemKey);
  const schedule = item === undefined ? undefined : itemSchedule(item);
  const enrollment =
    protocol === undefined
      ? ({ episode: 'not_enrolled', evidence: [] } satisfies EnrollmentExplanation)
      : enrollmentOf(protocol, input, timeline);
  const due = protocolDue(expectation, definition, anchor, schedule, enrollment, timeline);
  if (protocolId === undefined) {
    return { due };
  }
  const stage =
    schedule?.type === 'ckd_stage' ? ckdStage(timeline.events, input.conditions) : undefined;
  const dating =
    schedule?.type === 'gestational_age' ? currentDatingOf(protocol, input, timeline) : undefined;
  const weeks =
    dating === undefined || due.anchorAt === undefined
      ? undefined
      : gestationalAgeAt(dating, due.anchorAt).weeks;
  return {
    due,
    protocol: {
      protocolId,
      version: expectation.protocolVersion ?? expectation.ruleVersion,
      ...(protocol === undefined
        ? {}
        : { currentVersion: protocol.version, status: protocol.status }),
      ...(item === undefined ? {} : { itemKey: item.key }),
      ...(schedule === undefined ? {} : { schedule }),
      enrollment,
      ...(stage === undefined ? {} : { ckdStage: stage }),
      ...(weeks === undefined ? {} : { gestationalWeeks: weeks }),
    },
  };
}

function currentDatingOf(
  protocol: Protocol | undefined,
  input: ExplainInput,
  timeline: PatientTimeline,
): { readonly estimatedDeliveryDate: Date } | undefined {
  if (protocol === undefined) {
    return undefined;
  }
  const episode = protocolEpisode(protocol, input.conditions, timeline, input.now);
  return episode?.status === 'active' ? episode.dating : undefined;
}

const SCHEDULE_BASES: Readonly<Record<ProtocolSchedule['type'], DueBasis>> = {
  interval: 'protocol_interval',
  treatment_change: 'protocol_treatment_change',
  gestational_age: 'protocol_gestational_age',
  gestational_window: 'protocol_gestational_window',
  after_outcome: 'protocol_after_outcome',
  ckd_stage: 'protocol_ckd_stage',
};

function protocolDue(
  expectation: Expectation,
  definition: ExpectationDefinition | undefined,
  anchor: ClinicalEvent | undefined,
  schedule: ProtocolSchedule | undefined,
  enrollment: EnrollmentExplanation,
  timeline: PatientTimeline,
): DueExplanation {
  const basis = schedule === undefined ? 'protocol_interval' : SCHEDULE_BASES[schedule.type];
  if (schedule?.type === 'treatment_change') {
    // The control after a start or a dose change counts from the change,
    // whatever was done too soon after it (see `treatmentChangeSchedule`).
    const change = treatmentChanges(timeline.events, schedule.medications)
      .filter((candidate) => candidate.event.occurredAt.getTime() <= expectation.dueAt.getTime())
      .at(-1);
    const changeDue =
      change === undefined ? undefined : addDays(change.event.occurredAt, schedule.afterChangeDays);
    if (
      change !== undefined &&
      changeDue !== undefined &&
      Math.abs(changeDue.getTime() - expectation.dueAt.getTime()) < MS_PER_DAY
    ) {
      const early =
        anchor !== undefined && refKey(anchor.source) !== refKey(change.event.source)
          ? anchor
          : undefined;
      return withTolerance(
        {
          basis,
          anchorRole: 'treatment_change',
          ...anchorFields(change.event, expectation.dueAt),
          configuredDays: schedule.afterChangeDays,
          dueAt: expectation.dueAt,
          ...(early === undefined ? {} : { tooEarly: early }),
        },
        definition,
        expectation,
      );
    }
  }
  const done =
    anchor !== undefined &&
    definition?.fulfilledBy.some((correlation) =>
      matchesShape(correlation, anchor, definition.code),
    ) === true;
  const enrolling =
    anchor !== undefined &&
    (enrollment.evidence.some((event) => refKey(event.source) === refKey(anchor.source)) ||
      (enrollment.condition !== undefined &&
        refKey(enrollment.condition.source) === refKey(anchor.source)));
  const role: AnchorRole =
    anchor === undefined
      ? 'unknown'
      : schedule?.type === 'after_outcome'
        ? 'episode_end'
        : schedule?.type === 'gestational_window'
          ? 'window_open'
          : done
            ? 'last_done'
            : schedule?.type === 'treatment_change' && anchor.type === 'medication.prescribed'
              ? 'treatment_change'
              : enrolling
                ? 'enrollment'
                : anchor.type === 'medication.prescribed'
                  ? 'treatment_change'
                  : 'enrollment';
  const configuredDays =
    schedule === undefined
      ? undefined
      : schedule.type === 'interval'
        ? schedule.everyDays
        : schedule.type === 'after_outcome'
          ? schedule.withinDays
          : schedule.type === 'treatment_change'
            ? stateDays(anchor, expectation.dueAt, [
                schedule.everyDays,
                schedule.untilStable?.everyDays,
              ])
            : undefined;
  return withTolerance(
    {
      basis,
      anchorRole: role,
      ...anchorFields(anchor, expectation.dueAt),
      ...(configuredDays === undefined ? {} : { configuredDays }),
      dueAt: expectation.dueAt,
    },
    definition,
    expectation,
  );
}

/** The interval among `candidates` that `anchor` to `dueAt` really is, if any. */
function stateDays(
  anchor: ClinicalEvent | undefined,
  dueAt: Date,
  candidates: readonly (number | undefined)[],
): number | undefined {
  if (anchor === undefined) {
    return undefined;
  }
  const days = daysFrom(eventInstant(anchor), dueAt);
  return candidates.find((candidate) => candidate === days);
}

function byTime(left: ClinicalEvent, right: ClinicalEvent): number {
  return left.occurredAt.getTime() - right.occurredAt.getTime();
}

function enrollmentOf(
  protocol: Protocol,
  input: ExplainInput,
  timeline: PatientTimeline,
): EnrollmentExplanation {
  const episode = protocolEpisode(protocol, input.conditions, timeline, input.now);
  if (episode === undefined) {
    return { episode: 'not_enrolled', evidence: [] };
  }
  if (episode.status === 'ended') {
    return {
      episode: 'ended',
      evidence: [episode.endedBy],
      endedBy: episode.endedBy,
      outcome: episode.outcome,
    };
  }
  const condition = episode.enrolledBy;
  const source = timeline.bySource(condition.source);
  const treatment = protocol.enrollment.activeTreatment;
  const activeTreatment =
    treatment === undefined
      ? undefined
      : timeline
          .ofType('medication.prescribed')
          .filter(
            (event) =>
              event.occurredAt.getTime() <= input.now.getTime() &&
              medicationMatches(event.medication, treatment),
          )
          .at(-1);
  const common = {
    episode: 'active' as const,
    condition,
    ...(activeTreatment === undefined ? {} : { activeTreatment }),
  };
  switch (condition.sourceType) {
    case 'recorded':
      return { ...common, basis: 'diagnosis', evidence: source === undefined ? [] : [source] };
    case 'extracted_from_note':
      return { ...common, basis: 'note', evidence: source === undefined ? [] : [source] };
    case 'inferred_from_medication':
      return {
        ...common,
        basis: source?.type === 'note.received' ? 'note' : 'medication',
        evidence: source === undefined ? [] : [source],
      };
    case 'inferred_from_result': {
      const rule = (protocol.enrollment.results ?? []).find(
        (candidate) =>
          icd10Matches(condition.code, [candidate.conditionCode]) &&
          source !== undefined &&
          meetsThreshold(candidate, source),
      );
      if (rule === undefined) {
        return { ...common, basis: 'record', evidence: source === undefined ? [] : [source] };
      }
      return {
        ...common,
        basis: 'results',
        evidence: qualifyingResults(rule, timeline, source),
        threshold: {
          code: {
            system: rule.code.system,
            code: rule.code.code,
            ...(rule.code.display === undefined ? {} : { display: rule.code.display }),
          },
          ...(rule.gte === undefined ? {} : { gte: rule.gte }),
          ...(rule.lt === undefined ? {} : { lt: rule.lt }),
          ...(rule.confirm === undefined ? {} : { confirm: rule.confirm }),
        },
      };
    }
  }
}

/** Every result of the record past the threshold up to the enrolling one, oldest first. */
function qualifyingResults(
  rule: EnrollmentResult,
  timeline: PatientTimeline,
  enrolling: ClinicalEvent | undefined,
): ClinicalEvent[] {
  const limit = enrolling?.occurredAt.getTime() ?? Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  return timeline.events
    .filter((event) => event.occurredAt.getTime() <= limit && meetsThreshold(rule, event))
    .filter((event) => {
      const key = refKey(event.source);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(byTime);
}
