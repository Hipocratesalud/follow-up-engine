import type { CaseEvent, CaseEventActor } from '@follow-up-engine/core';
import type { Provenance, ProvenanceAgent } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { contentHash, toFhirId } from '../support/hash.ts';
import {
  ENGINE_CODE_SYSTEMS,
  ENGINE_EXTENSIONS,
  ENGINE_IDENTIFIER_SYSTEMS,
  TERMINOLOGY,
} from '../terminology.ts';
import { concept, ext, hostUserReference, patientReference, taskReference } from './elements.ts';

/** Display name of the engine when it acts on its own. */
const ENGINE_DISPLAY = 'Follow-up Engine';

/** `Provenance.agent.who` for each kind of actor. */
export function provenanceAgent(actor: CaseEventActor): ProvenanceAgent {
  const type = concept(TERMINOLOGY.provenanceParticipantType, 'performer');
  switch (actor.type) {
    case 'user':
      return {
        type,
        who: actor.id === undefined ? { display: 'Unknown user' } : hostUserReference(actor.id),
      };
    case 'patient':
      return {
        type,
        who:
          actor.id === undefined
            ? { type: 'Patient', display: 'Patient' }
            : patientReference(actor.id),
      };
    case 'rule':
      return {
        type,
        who: {
          type: 'Device',
          display: actor.id === undefined ? ENGINE_DISPLAY : `${ENGINE_DISPLAY} rule ${actor.id}`,
          identifier: { system: ENGINE_IDENTIFIER_SYSTEMS.rule, value: actor.id ?? 'unknown' },
        },
      };
    case 'system':
      return {
        type,
        who: {
          type: 'Device',
          display: ENGINE_DISPLAY,
          identifier: {
            system: ENGINE_IDENTIFIER_SYSTEMS.engine,
            value: actor.id ?? 'follow-up-engine',
          },
        },
      };
  }
}

/** Deterministic id of a case event (case events have no id of their own). */
export function caseEventId(event: CaseEvent): string {
  const digest = contentHash({ actor: event.actor, payload: event.payload }).slice(0, 8);
  return toFhirId(`${event.caseId}-${event.type}-${String(event.at.getTime())}-${digest}`);
}

/**
 * A case event as a FHIR `Provenance` targeting the case Task: what happened
 * (`activity`, engine case-event code), when, and who did it. The structured
 * payload (ids and codes only, never clinical free text) travels as JSON in
 * an extension.
 */
export function caseEventToProvenance(event: CaseEvent): Provenance {
  const payload =
    Object.keys(event.payload).length === 0 ? undefined : JSON.stringify(event.payload);
  const extension = ext.string(ENGINE_EXTENSIONS.caseEventPayload, payload);
  return {
    resourceType: 'Provenance',
    id: caseEventId(event),
    ...(extension.length === 0 ? {} : { extension }),
    target: [taskReference(event.caseId)],
    occurredDateTime: toFhirInstant(event.at),
    recorded: toFhirInstant(event.at),
    activity: concept(ENGINE_CODE_SYSTEMS.caseEvent, event.type),
    agent: [provenanceAgent(event.actor)],
  };
}
