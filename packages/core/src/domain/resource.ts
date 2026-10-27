/**
 * Structural view of a FHIR resource as seen by the core.
 *
 * The core deliberately does not depend on the FHIR type definitions (those
 * live in `@follow-up-engine/fhir`, which depends on the core, not the other
 * way round). Repositories only need the two fields that identify a
 * resource; everything else travels opaquely.
 */
export interface ClinicalResource {
  readonly resourceType: string;
  readonly id: string;
}

/** Points at a resource by type and id, like a FHIR `Reference` to `Type/id`. */
export interface ResourceReference {
  readonly resourceType: string;
  readonly id: string;
}
