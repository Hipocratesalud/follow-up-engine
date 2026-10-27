import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { normalizeSpecialty } from '../matching/correlation.ts';
import { encounterOf, type PatientTimeline } from '../timeline.ts';

/** The practitioner of the consultation `event` belongs to, when the record says so. */
function consultationPractitioner(
  event: ClinicalEvent | undefined,
  timeline: PatientTimeline,
): string | undefined {
  const encounterId = event === undefined ? undefined : encounterOf(event);
  return encounterId === undefined ? undefined : timeline.encounter(encounterId)?.practitionerId;
}

/** For a result linked to its order (`basedOn`), the consultation that ordered it. */
function orderingPractitioner(
  anchor: ClinicalEvent | undefined,
  timeline: PatientTimeline,
): string | undefined {
  if (anchor?.type !== 'result.received' || anchor.basedOnOrderId === undefined) {
    return undefined;
  }
  const order = timeline
    .ofType('service_request.created')
    .find((event) => event.orderId === anchor.basedOnOrderId);
  return consultationPractitioner(order, timeline);
}

/**
 * The practitioner who last treated the patient in one of `specialties`
 * (any specialty when empty), by the latest finished consultation that
 * names one.
 */
function lastTreatingPractitioner(
  timeline: PatientTimeline,
  specialties: ReadonlySet<string>,
): string | undefined {
  return [...timeline.encounters()]
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    .filter(
      (visit) =>
        visit.practitionerId !== undefined &&
        (specialties.size === 0 || specialties.has(normalizeSpecialty(visit.specialty))),
    )
    .at(-1)?.practitionerId;
}

/**
 * Who works a case. A follow-up gap is the treating clinician's to act on
 * (ordering a test, reviewing a result need a clinician), so the owner is:
 * the practitioner of the consultation that created the expectation; for a
 * result linked to its order, the one who ordered it; else the patient's
 * last treating practitioner in the specialties that follow it (the
 * protocol's, or the specialty of the record behind it), then in any
 * specialty. The front desk only when the record names no practitioner at
 * all. A standalone lab result or a problem-list diagnosis (the sources of
 * most protocol reasons) no longer sends the case to the front desk.
 */
export function caseOwner(
  expectation: Expectation,
  timeline: PatientTimeline,
  frontDesk: string,
  definition?: ExpectationDefinition,
): string {
  const anchor = timeline.bySource(expectation.source);
  const anchorSpecialty = anchor === undefined ? undefined : timeline.specialtyOf(anchor);
  const specialties = new Set(
    (definition?.specialties ?? (anchorSpecialty === undefined ? [] : [anchorSpecialty]))
      .map(normalizeSpecialty)
      .filter((specialty) => specialty !== ''),
  );
  return (
    consultationPractitioner(anchor, timeline) ??
    orderingPractitioner(anchor, timeline) ??
    (specialties.size > 0 ? lastTreatingPractitioner(timeline, specialties) : undefined) ??
    lastTreatingPractitioner(timeline, new Set()) ??
    frontDesk
  );
}
