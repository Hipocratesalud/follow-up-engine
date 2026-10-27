import type { ResourceRef } from '@follow-up-engine/core';
import type { CodeableConcept, Extension, Reference } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';
import { toFhirId } from '../support/hash.ts';
import { ENGINE_IDENTIFIER_SYSTEMS } from '../terminology.ts';

/** Request resources: an expectation they trigger is `Task.basedOn` them. */
const REQUEST_TYPES: readonly string[] = [
  'ServiceRequest',
  'MedicationRequest',
  'CarePlan',
  'Appointment',
  'DeviceRequest',
];

export function referenceTo(ref: ResourceRef): Reference {
  return { reference: `${ref.resourceType}/${toFhirId(ref.id)}`, type: ref.resourceType };
}

export function patientReference(patientId: string): Reference {
  return referenceTo({ resourceType: 'Patient', id: patientId });
}

export function taskReference(taskId: string): Reference {
  return referenceTo({ resourceType: 'Task', id: taskId });
}

export function isRequestResource(ref: ResourceRef): boolean {
  return REQUEST_TYPES.includes(ref.resourceType);
}

/** A host user (assignee, resolver, actor) as a logical reference: host ids are not FHIR resources here. */
export function hostUserReference(userId: string): Reference {
  return {
    type: 'Practitioner',
    identifier: { system: ENGINE_IDENTIFIER_SYSTEMS.hostUser, value: userId },
  };
}

export function concept(system: string, code: string, text?: string): CodeableConcept {
  return { coding: [{ system, code }], ...(text === undefined ? {} : { text }) };
}

/** Typed builders for engine extensions; `undefined` values produce no extension. */
export const ext = {
  code: (url: string, value: string | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueCode: value }],
  string: (url: string, value: string | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueString: value }],
  integer: (url: string, value: number | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueInteger: value }],
  decimal: (url: string, value: number | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueDecimal: value }],
  dateTime: (url: string, value: Date | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueDateTime: toFhirInstant(value) }],
  reference: (url: string, value: Reference | undefined): Extension[] =>
    value === undefined ? [] : [{ url, valueReference: value }],
  complex: (url: string, parts: readonly Extension[]): Extension[] =>
    parts.length === 0 ? [] : [{ url, extension: [...parts] }],
};

/** Reads a simple extension by URL. */
export function findExtension(
  extensions: readonly Extension[] | undefined,
  url: string,
): Extension | undefined {
  return extensions?.find((extension) => extension.url === url);
}
