import type { JsonObject } from '../shared/json.ts';

/** Points at a FHIR resource by type and id, like a FHIR `Reference` to `Type/id`. */
export interface ResourceRef {
  readonly resourceType: string;
  readonly id: string;
}

/**
 * A FHIR R4 resource as raw JSON (stored as `jsonb`).
 *
 * The core deliberately does not depend on the FHIR type definitions (those
 * live in `@follow-up-engine/fhir`, which depends on the core, not the other
 * way round). It only needs the two fields that identify the resource.
 */
export type FhirResourceJson = JsonObject & {
  readonly resourceType: string;
  readonly id: string;
};

/** A code from a terminology, like a FHIR `Coding`. */
export interface Coding {
  /** Terminology URI, for example `http://hl7.org/fhir/sid/icd-10` or `http://loinc.org`. */
  readonly system: string;
  readonly code: string;
  readonly display?: string;
}

/** Terminology URI for ICD-10. */
export const ICD10_SYSTEM = 'http://hl7.org/fhir/sid/icd-10';

function metaField(
  resource: FhirResourceJson,
  field: 'versionId' | 'lastUpdated',
): string | undefined {
  const meta = resource['meta'];
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  const value = (meta as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const NUMERIC_VERSION = /^\d{1,15}$/;

/**
 * Whether `incoming` is an older version of `stored` (the host delivers at
 * least once and may reorder): its numeric `meta.versionId` is lower, or,
 * when the versions are not both numeric, its `meta.lastUpdated` is earlier.
 * `false` when the resources carry nothing to compare.
 */
export function isOlderResourceVersion(
  incoming: FhirResourceJson,
  stored: FhirResourceJson,
): boolean {
  const incomingVersion = metaField(incoming, 'versionId');
  const storedVersion = metaField(stored, 'versionId');
  if (
    incomingVersion !== undefined &&
    storedVersion !== undefined &&
    NUMERIC_VERSION.test(incomingVersion) &&
    NUMERIC_VERSION.test(storedVersion)
  ) {
    return Number(incomingVersion) < Number(storedVersion);
  }
  const incomingAt = Date.parse(metaField(incoming, 'lastUpdated') ?? '');
  const storedAt = Date.parse(metaField(stored, 'lastUpdated') ?? '');
  return !Number.isNaN(incomingAt) && !Number.isNaN(storedAt) && incomingAt < storedAt;
}
