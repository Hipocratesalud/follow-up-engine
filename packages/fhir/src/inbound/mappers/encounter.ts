import { practitionerId, type PractitionerId } from '@follow-up-engine/core';
import { TERMINOLOGY } from '../../terminology.ts';
import { firstDate } from '../../support/datetime.ts';
import { hasCode, specialtyOf, type EntryContext, type MappedResource } from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

/** Participation types in order of preference for "the" practitioner of an encounter. */
const PARTICIPATION_PREFERENCE = ['PPRF', 'ATND', 'SPRF', 'PART'] as const;

function encounterPractitioner(
  encounter: ParsedResourceOf<'Encounter'>,
  ctx: EntryContext,
): PractitionerId | undefined {
  const participants = (encounter.participant ?? []).map((participant, index) => ({
    participant,
    index,
    rank: PARTICIPATION_PREFERENCE.findIndex((code) =>
      (participant.type ?? []).some((type) => hasCode(type, [code], TERMINOLOGY.participationType)),
    ),
  }));
  const ordered = participants.sort(
    (a, b) =>
      (a.rank === -1 ? PARTICIPATION_PREFERENCE.length : a.rank) -
      (b.rank === -1 ? PARTICIPATION_PREFERENCE.length : b.rank),
  );
  for (const { participant, index } of ordered) {
    if (participant.individual?.reference === undefined) {
      continue;
    }
    const target = ctx.follow(
      participant.individual,
      `participant[${String(index)}].individual`,
      ['Practitioner', 'PractitionerRole', 'RelatedPerson'],
      false,
    );
    if (target?.resourceType === 'Practitioner') {
      return practitionerId(target.id);
    }
  }
  return undefined;
}

/** Specialty of an encounter: `serviceType`, else the first `type`. */
export function encounterSpecialty(encounter: ParsedResourceOf<'Encounter'>): string | undefined {
  return specialtyOf(encounter.serviceType, ...(encounter.type ?? []));
}

/** Encounter (finished) → `encounter.finished`. Other statuses only group the bundle. */
export function mapEncounter(
  encounter: ParsedResourceOf<'Encounter'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(encounter.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounterId = ctx.entry.ref.id;
  if (encounter.status !== 'finished') {
    ctx.report(
      'information',
      'informational',
      `Encounter status "${encounter.status}" produces no event; it still groups the consultation`,
      'status',
    );
    return { patientId: patient.id, encounterId, events: [] };
  }
  const practitioner = encounterPractitioner(encounter, ctx);
  const specialty = encounterSpecialty(encounter);
  return {
    patientId: patient.id,
    encounterId,
    events: [
      {
        ...ctx.base(
          'encounter.finished',
          firstDate(encounter.period?.end, encounter.period?.start),
        ),
        ...(practitioner === undefined ? {} : { practitionerId: practitioner }),
        ...(specialty === undefined ? {} : { specialty }),
      },
    ],
  };
}

/** Appointment (booked / cancelled) → `appointment.booked` / `appointment.cancelled`. */
export function mapAppointment(
  appointment: ParsedResourceOf<'Appointment'>,
  ctx: EntryContext,
): MappedResource | undefined {
  let patientId: string | undefined;
  let practitioner: PractitionerId | undefined;
  appointment.participant.forEach((participant, index) => {
    const literal = participant.actor?.reference;
    const target = literal === undefined ? undefined : ctx.bundle.resolve(literal);
    if (target?.resourceType === 'Patient' && patientId === undefined) {
      patientId = target.id;
    } else if (target?.resourceType === 'Practitioner' && practitioner === undefined) {
      practitioner = practitionerId(target.id);
    } else if (literal !== undefined && target === undefined) {
      ctx.report(
        'warning',
        'not-found',
        `cannot resolve reference "${literal}"`,
        `participant[${String(index)}].actor`,
      );
    }
  });
  if (patientId === undefined) {
    ctx.report('error', 'required', 'an Appointment needs a Patient participant', 'participant');
    return undefined;
  }
  if (appointment.status !== 'booked' && appointment.status !== 'cancelled') {
    ctx.report(
      'information',
      'informational',
      `Appointment status "${appointment.status}" produces no event`,
      'status',
    );
    return { patientId, events: [] };
  }
  const scheduledFor = firstDate(appointment.start);
  if (scheduledFor === undefined) {
    ctx.report('error', 'required', `a ${appointment.status} Appointment needs a start`, 'start');
    return undefined;
  }
  if (appointment.status === 'cancelled') {
    return {
      patientId,
      events: [
        {
          ...ctx.base('appointment.cancelled', firstDate(appointment.meta?.lastUpdated)),
          scheduledFor,
        },
      ],
    };
  }
  const specialty = specialtyOf(
    ...(appointment.specialty ?? []),
    ...(appointment.serviceType ?? []),
    appointment.appointmentType,
  );
  return {
    patientId,
    events: [
      {
        ...ctx.base(
          'appointment.booked',
          firstDate(appointment.created, appointment.meta?.lastUpdated),
        ),
        scheduledFor,
        ...(practitioner === undefined ? {} : { practitionerId: practitioner }),
        ...(specialty === undefined ? {} : { specialty }),
      },
    ],
  };
}
