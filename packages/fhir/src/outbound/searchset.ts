import type {
  Bundle,
  BundleEntry,
  BundleLink,
  FhirResource,
  OperationOutcome,
} from '../fhir-types.ts';
import { toFhirInstant } from '../support/datetime.ts';

export interface SearchsetOptions {
  /** FHIR base URL (`https://host/fhir`); when given, entries get an absolute `fullUrl`. */
  readonly baseUrl?: string;
  /** Total matches across all pages; defaults to the number of resources. */
  readonly total?: number;
  readonly selfUrl?: string;
  readonly nextUrl?: string;
  readonly previousUrl?: string;
  readonly timestamp?: Date;
  /** Warnings about the search itself (ignored parameters): an entry with `search.mode = outcome`. */
  readonly outcome?: OperationOutcome;
}

/**
 * Wraps resources in a FHIR `searchset` Bundle (every entry has
 * `search.mode = match`), plus an `outcome` entry when the search has issues.
 */
export function toSearchsetBundle(
  resources: readonly FhirResource[],
  options: SearchsetOptions = {},
): Bundle {
  const base = options.baseUrl?.replace(/\/+$/, '');
  const link: BundleLink[] = [
    ...(options.selfUrl === undefined ? [] : [{ relation: 'self', url: options.selfUrl }]),
    ...(options.nextUrl === undefined ? [] : [{ relation: 'next', url: options.nextUrl }]),
    ...(options.previousUrl === undefined
      ? []
      : [{ relation: 'previous', url: options.previousUrl }]),
  ];
  const entries: BundleEntry[] = [
    ...resources.map((resource) => ({
      ...(base === undefined || resource.id === undefined
        ? {}
        : { fullUrl: `${base}/${resource.resourceType}/${resource.id}` }),
      resource,
      search: { mode: 'match' as const },
    })),
    ...(options.outcome === undefined
      ? []
      : [{ resource: options.outcome, search: { mode: 'outcome' as const } }]),
  ];
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    ...(options.timestamp === undefined ? {} : { timestamp: toFhirInstant(options.timestamp) }),
    total: options.total ?? resources.length,
    ...(link.length === 0 ? {} : { link }),
    ...(entries.length === 0 ? {} : { entry: entries }),
  };
}
