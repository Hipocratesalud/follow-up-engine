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
