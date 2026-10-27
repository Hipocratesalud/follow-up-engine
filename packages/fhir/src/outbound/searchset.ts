import type { Bundle, BundleLink, FhirResource } from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';

export interface SearchsetOptions {
  /** FHIR base URL (`https://host/fhir`); when given, entries get an absolute `fullUrl`. */
  readonly baseUrl?: string;
  /** Total matches across all pages; defaults to the number of resources. */
  readonly total?: number;
  readonly selfUrl?: string;
  readonly nextUrl?: string;
  readonly timestamp?: Date;
}

/** Wraps resources in a FHIR `searchset` Bundle (every entry has `search.mode = match`). */
export function toSearchsetBundle(
  resources: readonly FhirResource[],
  options: SearchsetOptions = {},
): Bundle {
  const base = options.baseUrl?.replace(/\/+$/, '');
  const link: BundleLink[] = [
    ...(options.selfUrl === undefined ? [] : [{ relation: 'self', url: options.selfUrl }]),
    ...(options.nextUrl === undefined ? [] : [{ relation: 'next', url: options.nextUrl }]),
  ];
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    ...(options.timestamp === undefined ? {} : { timestamp: toFhirInstant(options.timestamp) }),
    total: options.total ?? resources.length,
    ...(link.length === 0 ? {} : { link }),
    ...(resources.length === 0
      ? {}
      : {
          entry: resources.map((resource) => ({
            ...(base === undefined || resource.id === undefined
              ? {}
              : { fullUrl: `${base}/${resource.resourceType}/${resource.id}` }),
            resource,
            search: { mode: 'match' as const },
          })),
        }),
  };
}
