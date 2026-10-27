import type {
  ClinicalEvent,
  ClinicalEventOf,
  EncounterFinishedEvent,
} from '../domain/clinical-event.ts';
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

/**
 * A patient's clinical history, chronological, with the lookups the engine
 * needs (the event behind a resource, encounters by specialty, opt-out).
 */
export class PatientTimeline {
  readonly events: readonly ClinicalEvent[];
  readonly #bySource = new Map<string, ClinicalEvent>();
  readonly #encounters = new Map<string, EncounterFinishedEvent>();

  constructor(events: readonly ClinicalEvent[]) {
    this.events = [...events].sort(
      (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
    );
    for (const event of this.events) {
      const key = refKey(event.source);
      if (!this.#bySource.has(key)) {
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

  /** The first event derived from a resource (an expectation's anchor). */
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

  /** The specialty of the encounter an event belongs to, if known. */
  specialtyOf(event: ClinicalEvent): string | undefined {
    if (event.type === 'encounter.finished' || event.type === 'appointment.booked') {
      return event.specialty;
    }
    const encounterId = event.encounterId;
    return encounterId === undefined ? undefined : this.encounter(encounterId)?.specialty;
  }
}
