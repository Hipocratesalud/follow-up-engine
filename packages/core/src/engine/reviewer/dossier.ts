import { ACTIVE_CASE_STATUSES, type FollowUpCase } from '../../domain/case.ts';
import type {
  ClinicalEvent,
  ConditionRecordedEvent,
  EncounterFinishedEvent,
  MedicationPrescribedEvent,
  NoteReceivedEvent,
  ResultReceivedEvent,
  ServiceRequestCreatedEvent,
} from '../../domain/clinical-event.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import { atcCodeOf } from '../terminology/atc.ts';
import { foldText } from '../support/text.ts';
import { latestAppointmentVersions, refKey, withoutWithdrawnRecords } from '../timeline.ts';
import type { CitationKind } from '../../domain/clinical-finding.ts';
import type { ReviewInput, SignalView, TrendView } from '../../ports/clinical-review-agent.ts';
import {
  BLOOD_PRESSURE_PANEL_LOINC,
  LOINC,
  MEASUREMENTS,
  type MeasurementDefinition,
  measurementOfLoinc,
  toMeasurementUnit,
} from './knowledge.ts';
import { formatValue, type SeriesPoint, summarizeTrend, type TrendSummary } from './trends.ts';
import {
  DEFAULT_REVIEW_LOCALE,
  type ReviewerCopy,
  reviewerCopy,
  type ReviewLocale,
} from './copy.ts';

const MS_PER_DAY = 86_400_000;
/** Notes sent whole in the review input; older ones stay reachable through `get_notes`. */
export const RECENT_NOTES = 6;
/** Characters of each recent note in the input (head and tail kept, the plan is at the end). */
export const NOTE_EXCERPT_CHARS = 1_600;
/** Clinical history the reviewer looks at. */
export const LOOKBACK_DAYS = 3 * 365;

/** A numeric component of a panel Observation (blood pressure). */
export interface ObservationComponent {
  readonly code: string;
  readonly value: number;
  readonly unit?: string;
}

/**
 * Everything the reviewer may read about one patient, gathered by the
 * application service from the stores (or by the eval from FHIR bundles).
 * The engine's own state comes along so coverage is decided by code.
 */
export interface PatientRecordSnapshot {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly now: Date;
  /** `YYYY-MM-DD` (FHIR `Patient.birthDate`). */
  readonly birthDate?: string;
  /** FHIR `Patient.gender`. */
  readonly gender?: string;
  readonly events: readonly ClinicalEvent[];
  readonly conditions: readonly PatientCondition[];
  /** Open expectations and expired ones grouped into an active case. */
  readonly liveExpectations: readonly Expectation[];
  readonly activeCases: readonly FollowUpCase[];
  /** Components of panel Observations (systolic and diastolic of a BP panel), by `Observation/<id>`. */
  readonly components?: ReadonlyMap<string, readonly ObservationComponent[]>;
}

/**
 * A record the reviewer can cite. `handle` is what the model sees (`N3`,
 * `R7`): host ids never reach a model. `text` is what a quote is checked
 * against: the note itself, or the canonical line the engine renders for a
 * structured record (`Creatinina: 1.7 mg/dL`, `Metformina 850 mg`).
 */
export interface CitableDocument {
  readonly handle: string;
  readonly kind: CitationKind;
  readonly source: ResourceRef;
  readonly occurredAt: Date;
  readonly text: string;
  /** In the review's locale (`Diabetology note`, `Creatinine`). */
  readonly title: string;
  readonly specialty?: string;
  /** For results: the measurement key (`creatinine`). */
  readonly measurement?: string;
  readonly value?: number;
}

export interface NoteDocument extends CitableDocument {
  readonly kind: 'note';
  readonly encounterId?: string;
}

export interface MedicationEntry {
  readonly handle: string;
  readonly name: string;
  readonly dose?: string;
  /** First prescription of this drug. */
  readonly since: Date;
  readonly lastPrescribedAt: Date;
  readonly atc?: string;
  readonly active: boolean;
  readonly source: ResourceRef;
}

export interface ConditionEntry {
  readonly handle?: string;
  readonly code: string;
  readonly display: string;
  readonly status: string;
}

/** The patient's record as the reviewer reads it: documents by handle, trends, medications. */
export interface ReviewDossier {
  readonly snapshot: PatientRecordSnapshot;
  /** Language of every text the reviewer writes (quotes from notes stay as written). */
  readonly locale: ReviewLocale;
  readonly copy: ReviewerCopy;
  readonly documents: ReadonlyMap<string, CitableDocument>;
  readonly notes: readonly NoteDocument[];
  readonly trends: readonly TrendSummary[];
  readonly medications: readonly MedicationEntry[];
  readonly conditions: readonly ConditionEntry[];
  readonly conditionCodes: readonly string[];
  readonly encounters: readonly EncounterFinishedEvent[];
  readonly orders: readonly ServiceRequestCreatedEvent[];
  readonly upcomingAppointmentAt?: Date;
  readonly ageYears?: number;
  readonly female?: boolean;
  /** Specialty of the latest visit or note. */
  readonly specialty?: string;
  /** Every specialty the patient was seen in. */
  readonly specialties: readonly string[];
  handleOf(source: ResourceRef): string | undefined;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function ageOn(birthDate: string | undefined, now: Date): number | undefined {
  if (birthDate === undefined) return undefined;
  const birth = new Date(`${birthDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return undefined;
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : undefined;
}

/** `head [...] tail` of a long text, cut at whitespace. */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.4);
  const tailLength = limit - headLength;
  const head = text.slice(0, headLength).replace(/\s+\S*$/, '');
  const tail = text.slice(text.length - tailLength).replace(/^\S*\s+/, '');
  return `${head} […] ${tail}`;
}

function medicationKey(event: MedicationPrescribedEvent): string {
  return atcCodeOf(event.medication) ?? foldText(event.medication.text).split(/\s+/)[0] ?? '';
}

function isActive(event: MedicationPrescribedEvent, now: Date): boolean {
  if (event.durationDays === undefined) return true;
  return event.startAt.getTime() + event.durationDays * MS_PER_DAY >= now.getTime();
}

function resultValue(
  measurement: MeasurementDefinition,
  event: ResultReceivedEvent,
): number | undefined {
  const value = event.value?.value;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return toMeasurementUnit(measurement, value, event.value?.unit);
}

/** A result split into the measurements it reports (a BP panel reports two). */
function measuredValues(
  event: ResultReceivedEvent,
  components: ReadonlyMap<string, readonly ObservationComponent[]> | undefined,
): { measurement: MeasurementDefinition; value: number }[] {
  if (event.code.system !== LOINC) return [];
  const measurement = measurementOfLoinc(event.code.code);
  if (measurement !== undefined) {
    const value = resultValue(measurement, event);
    return value === undefined ? [] : [{ measurement, value }];
  }
  if (!BLOOD_PRESSURE_PANEL_LOINC.includes(event.code.code)) return [];
  return (components?.get(refKey(event.source)) ?? []).flatMap((component) => {
    const part = measurementOfLoinc(component.code);
    const value =
      part === undefined ? undefined : toMeasurementUnit(part, component.value, component.unit);
    return part === undefined || value === undefined ? [] : [{ measurement: part, value }];
  });
}

/**
 * Builds the reviewer's view of a patient: withdrawn records dropped, only
 * the last {@link LOOKBACK_DAYS}, every citable record given a handle in a
 * stable order, trends computed, the latest version of each drug.
 */
export function buildDossier(
  snapshot: PatientRecordSnapshot,
  locale: ReviewLocale = DEFAULT_REVIEW_LOCALE,
): ReviewDossier {
  const copy = reviewerCopy(locale);
  const since = snapshot.now.getTime() - LOOKBACK_DAYS * MS_PER_DAY;
  const events = latestAppointmentVersions(withoutWithdrawnRecords(snapshot.events)).filter(
    (event) => event.occurredAt.getTime() >= since && event.occurredAt <= snapshot.now,
  );
  const documents = new Map<string, CitableDocument>();
  const handles = new Map<string, string>();
  const counters = { N: 0, R: 0, M: 0, C: 0 };
  function register(
    prefix: keyof typeof counters,
    document: Omit<CitableDocument, 'handle'>,
    key = refKey(document.source),
  ): CitableDocument | undefined {
    const existing = handles.get(key);
    if (existing !== undefined) return documents.get(existing);
    counters[prefix] += 1;
    const handle = `${prefix}${String(counters[prefix])}`;
    const full = { ...document, handle } as CitableDocument;
    documents.set(handle, full);
    handles.set(key, handle);
    if (!handles.has(refKey(document.source))) handles.set(refKey(document.source), handle);
    return full;
  }

  // Notes (latest version of each document), oldest first.
  const noteEvents = new Map<string, NoteReceivedEvent>();
  for (const event of events) {
    if (event.type === 'note.received') noteEvents.set(event.documentId, event);
  }
  const notes: NoteDocument[] = [];
  for (const note of [...noteEvents.values()].sort(
    (left, right) => left.authoredAt.getTime() - right.authoredAt.getTime(),
  )) {
    const label = note.specialty === undefined ? undefined : copy.specialty(note.specialty);
    const document = register('N', {
      kind: 'note',
      source: note.source,
      occurredAt: note.authoredAt,
      text: note.text,
      title: copy.noteTitle(label),
      ...(note.specialty === undefined ? {} : { specialty: note.specialty }),
    });
    if (document !== undefined) {
      notes.push({
        ...document,
        kind: 'note',
        ...(note.encounterId === undefined ? {} : { encounterId: note.encounterId }),
      });
    }
  }

  // Results of trended measurements.
  const series = new Map<string, SeriesPoint[]>();
  for (const event of events) {
    if (event.type !== 'result.received') continue;
    // A report that lists its Observations: the values come with them, not twice.
    if (
      event.source.resourceType === 'DiagnosticReport' &&
      (event.listedResults?.length ?? 0) > 0
    ) {
      continue;
    }
    const measured = measuredValues(event, snapshot.components);
    for (const { measurement, value } of measured) {
      const label = copy.measurements[measurement.key] ?? measurement.key;
      const text = `${label}: ${formatValue(value, measurement.decimals)} ${measurement.unit}`;
      const document = register(
        'R',
        {
          kind: 'result',
          source: event.source,
          occurredAt: event.occurredAt,
          text,
          title: label,
          measurement: measurement.key,
          value,
        },
        `${refKey(event.source)}#${measurement.key}`,
      );
      if (document === undefined) continue;
      const points = series.get(measurement.key) ?? [];
      points.push({ handle: document.handle, at: event.occurredAt, value });
      series.set(measurement.key, points);
    }
  }
  const trends = MEASUREMENTS.flatMap((measurement) => {
    const points = series.get(measurement.key);
    return points === undefined
      ? []
      : [
          summarizeTrend(
            measurement,
            points,
            copy.measurements[measurement.key] ?? measurement.key,
          ),
        ];
  });

  // Medications: one entry per drug, its latest prescription.
  const byDrug = new Map<string, MedicationPrescribedEvent[]>();
  for (const event of events) {
    if (event.type !== 'medication.prescribed') continue;
    const key = medicationKey(event);
    byDrug.set(key, [...(byDrug.get(key) ?? []), event]);
  }
  const medications: MedicationEntry[] = [];
  for (const prescriptions of byDrug.values()) {
    const sorted = [...prescriptions].sort(
      (left, right) => left.startAt.getTime() - right.startAt.getTime(),
    );
    const latest = sorted.at(-1);
    const first = sorted[0];
    if (latest === undefined || first === undefined) continue;
    const text = latest.dosageText
      ? `${latest.medication.text} — ${latest.dosageText}`
      : latest.medication.text;
    const document = register('M', {
      kind: 'medication',
      source: latest.source,
      occurredAt: latest.startAt,
      text,
      title: latest.medication.text,
    });
    if (document === undefined) continue;
    const atc = atcCodeOf(latest.medication);
    medications.push({
      handle: document.handle,
      name: latest.medication.text,
      ...(latest.dosageText === undefined ? {} : { dose: latest.dosageText }),
      since: first.startAt,
      lastPrescribedAt: latest.startAt,
      ...(atc === undefined ? {} : { atc }),
      active: isActive(latest, snapshot.now),
      source: latest.source,
    });
  }
  medications.sort((left, right) => left.since.getTime() - right.since.getTime());

  // Conditions: coded diagnoses become documents; the engine's view decides the status.
  const recorded = new Map<string, ConditionRecordedEvent>();
  for (const event of events) {
    if (event.type === 'condition.recorded') recorded.set(event.code.code, event);
  }
  for (const event of recorded.values()) {
    register('C', {
      kind: 'condition',
      source: event.source,
      occurredAt: event.occurredAt,
      text: event.code.display ? `${event.code.code} ${event.code.display}` : event.code.code,
      title: event.code.display ?? event.code.code,
    });
  }
  const standing = snapshot.conditions.filter(
    (condition) => condition.status === 'confirmed' || condition.status === 'probable',
  );
  const conditions: ConditionEntry[] =
    standing.length > 0
      ? standing.map((condition) => {
          const handle =
            handles.get(refKey(condition.source)) ??
            handles.get(refKey(recorded.get(condition.code.code)?.source ?? condition.source));
          return {
            ...(handle === undefined ? {} : { handle }),
            code: condition.code.code,
            display: condition.code.display ?? condition.code.code,
            status: condition.status,
          };
        })
      : [...recorded.values()].map((event) => ({
          ...(handles.get(refKey(event.source)) === undefined
            ? {}
            : { handle: handles.get(refKey(event.source)) ?? '' }),
          code: event.code.code,
          display: event.code.display ?? event.code.code,
          status: event.verification === 'confirmed' ? 'confirmed' : 'probable',
        }));

  const encounters = events.filter(
    (event): event is EncounterFinishedEvent => event.type === 'encounter.finished',
  );
  const orders = events.filter(
    (event): event is ServiceRequestCreatedEvent => event.type === 'service_request.created',
  );
  const upcoming = latestAppointmentVersions(snapshot.events)
    .filter((event) => event.type === 'appointment.booked')
    .map((event) => event.scheduledFor)
    .filter((date) => date > snapshot.now)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  const specialties = [
    ...new Set(
      [
        ...encounters.map((event) => event.specialty),
        ...notes.map((note) => note.specialty),
      ].filter((specialty): specialty is string => specialty !== undefined),
    ),
  ];
  const latestSpecialty = [
    ...encounters.map((e) => ({ at: e.occurredAt, s: e.specialty })),
    ...notes.map((n) => ({ at: n.occurredAt, s: n.specialty })),
  ]
    .filter((item): item is { at: Date; s: string } => item.s !== undefined)
    .sort((left, right) => left.at.getTime() - right.at.getTime())
    .at(-1)?.s;
  const ageYears = ageOn(snapshot.birthDate, snapshot.now);

  return {
    snapshot,
    locale,
    copy,
    documents,
    notes,
    trends,
    medications,
    conditions,
    conditionCodes: conditions.map((condition) => condition.code),
    encounters,
    orders,
    ...(upcoming === undefined ? {} : { upcomingAppointmentAt: upcoming }),
    ...(ageYears === undefined ? {} : { ageYears }),
    ...(snapshot.gender === 'female' || snapshot.gender === 'male'
      ? { female: snapshot.gender === 'female' }
      : {}),
    ...(latestSpecialty === undefined ? {} : { specialty: latestSpecialty }),
    specialties,
    handleOf: (source) => handles.get(refKey(source)),
  };
}

function trendView(trend: TrendSummary): TrendView {
  return {
    test: trend.test,
    label: trend.label,
    unit: trend.unit,
    values: trend.points.map((point) => ({
      docId: point.handle,
      date: isoDay(point.at),
      value: point.value,
    })),
    ...(trend.low === undefined ? {} : { low: trend.low }),
    ...(trend.high === undefined ? {} : { high: trend.high }),
    changePct: trend.changePct,
    slopePerYear: trend.slopePerYear,
    consecutiveWorsening: trend.consecutiveWorsening,
    latestOutOfRange: trend.latestOutOfRange,
  };
}

const SEX: Readonly<Record<string, string>> = { female: 'F', male: 'M' };

/** The model-facing input of a dossier and its signals. */
export function reviewInputOf(
  dossier: ReviewDossier,
  patientRef: string,
  signals: readonly SignalView[],
): ReviewInput {
  const { snapshot } = dossier;
  const live = snapshot.liveExpectations.filter(
    (expectation) => expectation.status === 'open' || expectation.status === 'expired',
  );
  const sex = snapshot.gender === undefined ? undefined : SEX[snapshot.gender];
  return {
    patientRef,
    asOf: isoDay(snapshot.now),
    ...(dossier.ageYears === undefined ? {} : { ageYears: dossier.ageYears }),
    ...(sex === undefined ? {} : { sex }),
    conditions: dossier.conditions.map((condition) => ({
      ...(condition.handle === undefined ? {} : { docId: condition.handle }),
      code: condition.code,
      display: condition.display,
      status: condition.status,
    })),
    medications: dossier.medications.map((medication) => ({
      docId: medication.handle,
      name: medication.name,
      ...(medication.dose === undefined ? {} : { dose: medication.dose }),
      since: isoDay(medication.since),
      ...(medication.atc === undefined ? {} : { atc: medication.atc }),
      active: medication.active,
    })),
    labTrends: dossier.trends.filter((trend) => trend.kind === 'lab').map(trendView),
    vitals: dossier.trends.filter((trend) => trend.kind === 'vital').map(trendView),
    recentNotes: dossier.notes.slice(-RECENT_NOTES).map((note) => ({
      docId: note.handle,
      date: isoDay(note.occurredAt),
      ...(note.specialty === undefined ? {} : { specialty: note.specialty }),
      text: excerpt(note.text, NOTE_EXCERPT_CHARS),
    })),
    openExpectations: live.map((expectation) => ({
      ruleId: expectation.ruleId,
      label: expectation.reason.label,
      dueAt: isoDay(expectation.dueAt),
      status: expectation.status,
    })),
    openCases: snapshot.activeCases
      .filter((item) => (ACTIVE_CASE_STATUSES as readonly string[]).includes(item.status))
      .map((item) => ({
        reasons: item.reasons.map((reason) => reason.reasonCode),
        status: item.status,
      })),
    signals,
  };
}
