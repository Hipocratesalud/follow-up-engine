import {
  CONTACT_CHANNELS,
  CONTACT_OUTCOMES,
  type ContactChannel,
  type ContactOutcome,
} from '@follow-up-engine/core';
import { firstDate } from '../../support/datetime.ts';
import { ENGINE_CODE_SYSTEMS, ENGINE_EXTENSIONS, TERMINOLOGY } from '../../terminology.ts';
import type { ConceptInput, EntryContext, MappedResource } from '../context.ts';

export type { MappedCommunication } from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

/** HL7 v3 ParticipationMode codes that name one channel unambiguously. */
const MODE_CHANNEL: Readonly<Record<string, ContactChannel>> = {
  PHONE: 'phone_call',
  EMAILWRIT: 'email',
};

function codeIn(concept: ConceptInput | undefined, system: string): string | undefined {
  return concept?.coding?.find((coding) => coding.system === system && coding.code !== undefined)
    ?.code;
}

function channelOf(media: readonly ConceptInput[] | undefined): ContactChannel | undefined {
  for (const medium of media ?? []) {
    const own = codeIn(medium, ENGINE_CODE_SYSTEMS.contactChannel);
    if (own !== undefined && (CONTACT_CHANNELS as readonly string[]).includes(own)) {
      return own as ContactChannel;
    }
    const mode = codeIn(medium, TERMINOLOGY.participationMode);
    if (mode !== undefined && MODE_CHANNEL[mode] !== undefined) {
      return MODE_CHANNEL[mode];
    }
  }
  return undefined;
}

function isOutcome(code: string | undefined): code is ContactOutcome {
  return code !== undefined && (CONTACT_OUTCOMES as readonly string[]).includes(code);
}

/**
 * Communication → a contact outcome on the `CommunicationRequest` it is
 * `basedOn` (no clinical event). The outcome comes from the `contact-outcome`
 * extension, else `statusReason`, both in the contact-outcome CodeSystem; a
 * `not-done` Communication without one did not reach the patient
 * (`no_answer`). An unknown outcome code is an error: the engine would
 * otherwise decide on a guess.
 */
export function mapCommunication(
  communication: ParsedResourceOf<'Communication'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(communication.subject, 'subject', ['Patient'], true);
  const basedOn = communication.basedOn.findIndex((reference) =>
    reference.reference?.startsWith('CommunicationRequest/'),
  );
  const request =
    basedOn < 0
      ? undefined
      : ctx.follow(
          communication.basedOn[basedOn],
          `basedOn[${String(basedOn)}]`,
          ['CommunicationRequest'],
          true,
        );
  if (basedOn < 0) {
    ctx.report(
      'error',
      'required',
      'basedOn must reference the CommunicationRequest the engine sent (CommunicationRequest/<id>)',
      'basedOn',
    );
  }
  const extension = communication.extension?.find(
    (candidate) => candidate.url === ENGINE_EXTENSIONS.contactOutcome,
  );
  const fromExtension =
    extension === undefined
      ? undefined
      : (codeIn(extension.valueCodeableConcept, ENGINE_CODE_SYSTEMS.contactOutcome) ??
        extension.valueCode);
  const fromStatusReason = codeIn(communication.statusReason, ENGINE_CODE_SYSTEMS.contactOutcome);
  const reported = fromExtension ?? fromStatusReason;
  if (reported !== undefined && !isOutcome(reported)) {
    ctx.report(
      'error',
      'code-invalid',
      `unknown contact outcome "${reported}" (expected one of ${CONTACT_OUTCOMES.join(', ')})`,
      extension === undefined ? 'statusReason' : 'extension',
    );
    return undefined;
  }
  if (patient === undefined || request === undefined) {
    return undefined;
  }
  const outcome: ContactOutcome | undefined =
    reported ?? (communication.status === 'not-done' ? 'no_answer' : undefined);
  const channel = channelOf(communication.medium);
  const sentAt = firstDate(communication.sent);
  const receivedAt = firstDate(communication.received);
  const lastUpdated = firstDate(communication.meta?.lastUpdated);
  const versionId = communication.meta?.versionId;
  return {
    patientId: patient.id,
    events: [],
    communication: {
      id: ctx.entry.ref.id,
      requestId: request.id,
      patientId: patient.id,
      status: communication.status,
      ...(channel === undefined ? {} : { channel }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(sentAt === undefined ? {} : { sentAt }),
      ...(receivedAt === undefined ? {} : { receivedAt }),
      ...(versionId === undefined ? {} : { versionId }),
      ...(lastUpdated === undefined ? {} : { lastUpdated }),
    },
  };
}
