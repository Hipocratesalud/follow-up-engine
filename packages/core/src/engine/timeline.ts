import type {
  ClinicalEvent,
  ClinicalEventOf,
  EncounterFinishedEvent,
} from '../domain/clinical-event.ts';
import type { PractitionerId } from '../domain/ids.ts';
import type { ResourceRef } from '../domain/resource.ts';

export function refKey(ref: ResourceRef): string {
  return `${ref.resourceType}/${ref.id}`;
}

/**
 * When an event "happens" for correlation purposes: the scheduled date of an
 * appointment, the clinical time of everything else.
 */
export function eventInstant(event: ClinicalEvent): Date {
  return event.type === 'appointment.booked' ? event.scheduledFor : event.occurredAt;
}

/** The encounter an event belongs to: its own id for an encounter, else `encounterId`. */
export function encounterOf(event: ClinicalEvent): string | undefined {
  return event.type === 'encounter.finished'
    ? (event.encounterId ?? event.source.id)
    : event.encounterId;
}

/** When the version an event was derived from was recorded: `recordedAt`, else the clinical time. */
function versionInstant(event: ClinicalEvent): number {
  return (event.recordedAt ?? event.occurredAt).getTime();
}

/**
 * Keeps only the latest version of each Appointment: its booking stands
 * when that version is booked (a reschedule replaces the earlier date), and
 * nothing stands when it is cancelled, a no-show or entered in error (a
 * booking made again after a cancellation stands again). Versions are
 * ordered by when the host recorded them (`recordedAt`, else the clinical
 * time), then by arrival. A cancelled booking fulfills nothing and anchors
 * nothing.
 */
export function latestAppointmentVersions(events: readonly ClinicalEvent[]): ClinicalEvent[] {
  const latest = new Map<string, { readonly event: ClinicalEvent; readonly at: number }>();
  for (const event of events) {
    if (event.type !== 'appointment.booked' && event.type !== 'appointment.cancelled') {
      continue;
    }
    const key = refKey(event.source);
    const at = versionInstant(event);
    const current = latest.get(key);
    if (current === undefined || at >= current.at) {
      latest.set(key, { event, at });
    }
  }
  return events.filter(
    (event) =>
      event.type !== 'appointment.booked' || latest.get(refKey(event.source))?.event === event,
  );
}

/**
 * Drops every event of a resource that a later `record.withdrawn` of the
 * same resource withdrew (an order revoked, a diagnosis refuted, a note
 * entered in error, a resource moved to another patient), events derived
 * from it included (a note's plan). The withdrawal itself stays.
 */
export function withoutWithdrawnRecords(events: readonly ClinicalEvent[]): ClinicalEvent[] {
  const withdrawals = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'record.withdrawn') {
      const key = refKey(event.source);
      withdrawals.set(key, Math.max(withdrawals.get(key) ?? 0, event.occurredAt.getTime()));
    }
  }
  if (withdrawals.size === 0) {
    return [...events];
  }
  return events.filter((event) => {
    const withdrawnAt = withdrawals.get(refKey(event.source));
    return (
      event.type === 'record.withdrawn' ||
      withdrawnAt === undefined ||
      event.occurredAt.getTime() > withdrawnAt
    );
  });
}

/**
 * A patient's clinical history, chronological, with the lookups the engine
 * needs (the event behind a resource, encounters by specialty, opt-out).
 */
/** A fact the engine derived from a resource (a note's plan or reading), not what the host sent. */
function isDerivedEvent(event: ClinicalEvent): boolean {
  return event.type === 'plan.extracted' || event.idempotencyKey.includes('::');
}

export class PatientTimeline {
  readonly events: readonly ClinicalEvent[];
  readonly #bySource = new Map<string, ClinicalEvent>();
  readonly #encounters = new Map<string, EncounterFinishedEvent>();
  readonly #kept: ReadonlySet<string>;

  constructor(events: readonly ClinicalEvent[]) {
    const sorted = [...events].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    this.events = withoutWithdrawnRecords(latestAppointmentVersions(sorted));
    this.#kept = new Set(this.events.map((event) => event.idempotencyKey));
    for (const event of this.events) {
      const key = refKey(event.source);
      const current = this.#bySource.get(key);
      // What the host sent stands for its resource, not a fact the engine
      // derived from it: a note's reading dates a delivery weeks before the
      // note ("puérpera de 50 días"), which must not move the note's anchor.
      if (current === undefined || (isDerivedEvent(current) && !isDerivedEvent(event))) {
        this.#bySource.set(key, event);
      }
      if (event.type === 'encounter.finished') {
        const id = encounterOf(event);
        if (id !== undefined && !this.#encounters.has(id)) {
          this.#encounters.set(id, event);
        }
      }
    }
  }

  /**
   * Whether the event is in the record but no longer stands: a booking
   * replaced by a later version of its Appointment (rescheduled, cancelled),
   * or any event of a resource withdrawn later.
   */
  isWithdrawn(event: ClinicalEvent): boolean {
    return !this.#kept.has(event.idempotencyKey);
  }

  /**
   * The first event of a resource (an expectation's anchor), preferring what
   * the host sent over what the engine derived from it.
   */
  bySource(ref: ResourceRef): ClinicalEvent | undefined {
    return this.#bySource.get(refKey(ref));
  }

  encounter(encounterId: string): EncounterFinishedEvent | undefined {
    return this.#encounters.get(encounterId);
  }

  /** Finished encounters, one per encounter id, chronological. */
  encounters(): readonly EncounterFinishedEvent[] {
    return [...this.#encounters.values()];
  }

  ofType<TType extends ClinicalEvent['type']>(type: TType): readonly ClinicalEventOf<TType>[] {
    return this.events.filter((event): event is ClinicalEventOf<TType> => event.type === type);
  }

  /** Whether the patient asked not to be followed up. */
  get optedOut(): boolean {
    return this.events.some((event) => event.type === 'patient.opted_out');
  }

  /**
   * The specialty an event belongs to, if known: an encounter's or
   * appointment's own, a note's practice setting, else the specialty of the
   * consultation it belongs to (for a result without one, the consultation
   * that ordered it).
   */
  specialtyOf(event: ClinicalEvent): string | undefined {
    if (event.type === 'encounter.finished' || event.type === 'appointment.booked') {
      return event.specialty;
    }
    if (event.type === 'note.received' && event.specialty !== undefined) {
      return event.specialty;
    }
    const consultation = this.#consultationOf(event);
    if (consultation !== undefined) {
      return consultation.specialty;
    }
    if (event.type === 'plan.extracted') {
      const note = this.bySource(event.source);
      return note?.type === 'note.received' ? note.specialty : undefined;
    }
    return undefined;
  }

  /** The practitioner an event belongs to, if known (an encounter's or appointment's own, else its consultation's). */
  practitionerOf(event: ClinicalEvent): PractitionerId | undefined {
    if (event.type === 'encounter.finished' || event.type === 'appointment.booked') {
      return event.practitionerId;
    }
    return this.#consultationOf(event)?.practitionerId;
  }

  /** The finished consultation an event belongs to; for a result, else the one that ordered it. */
  #consultationOf(event: ClinicalEvent): EncounterFinishedEvent | undefined {
    const own = event.encounterId === undefined ? undefined : this.encounter(event.encounterId);
    if (own !== undefined || event.type !== 'result.received') {
      return own;
    }
    const order =
      event.basedOnOrderId === undefined
        ? undefined
        : this.bySource({ resourceType: 'ServiceRequest', id: event.basedOnOrderId });
    return order?.encounterId === undefined ? undefined : this.encounter(order.encounterId);
  }
}
