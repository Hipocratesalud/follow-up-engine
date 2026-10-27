import type { FhirResourceJson, JsonObject, ResourceRef } from '@follow-up-engine/core';
import { contentHash } from '../support/hash.ts';
import { parseLiteralReference } from '../support/references.ts';
import type { MappingIssue } from '../support/operation-outcome.ts';
import {
  BundleEnvelopeSchema,
  CONSUMED_RESOURCE_SCHEMAS,
  isConsumedResourceType,
  type ConsumedResourceType,
  type ParsedResource,
  type ParsedResourceOf,
} from './schemas.ts';
import { zodIssuesToMappingIssues } from './zod-issues.ts';

/** One bundle entry with a resolved identity. */
export interface IndexedEntry {
  readonly index: number;
  /** `Bundle.entry[i].resource`. */
  readonly expression: string;
  readonly fullUrl?: string;
  readonly ref: ResourceRef;
  /** `meta.versionId`, else `meta.lastUpdated`, else a hash of the content. */
  readonly version: string;
  /** The resource as received, with `id` filled in and bundle-local references rewritten. */
  readonly stored: FhirResourceJson;
  /** Validated view, for consumed resource types that passed validation. */
  readonly parsed?: ParsedResource;
  /** Whether the entry failed validation. */
  readonly invalid: boolean;
}

export interface BundleIndex {
  readonly type: 'transaction' | 'batch';
  readonly entries: readonly IndexedEntry[];
  /** Resolves a literal reference (bundle `fullUrl`, relative or absolute `Type/id`). */
  resolve(reference: string): ResourceRef | undefined;
  /** The entry with the given identity, if it is in the bundle. */
  find(ref: ResourceRef): IndexedEntry | undefined;
  /** The validated resource with the given identity and type, if it is in the bundle. */
  parsed<K extends ConsumedResourceType>(
    resourceType: K,
    ref: ResourceRef,
  ): ParsedResourceOf<K> | undefined;
}

export type IndexResult =
  | { readonly ok: true; readonly index: BundleIndex; readonly issues: readonly MappingIssue[] }
  | { readonly ok: false; readonly issues: readonly MappingIssue[] };

const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

const refKey = (ref: ResourceRef): string => `${ref.resourceType}/${ref.id}`;

function idFromFullUrl(fullUrl: string, resourceType: string): string | undefined {
  const urn = /^urn:(?:uuid|oid):(.+)$/i.exec(fullUrl)?.[1];
  if (urn !== undefined) {
    const id = urn.toLowerCase();
    return FHIR_ID.test(id) ? id : undefined;
  }
  const literal = parseLiteralReference(fullUrl);
  return literal?.resourceType === resourceType ? literal.id : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep copy with every bundle-local `reference` rewritten to `Type/id`, as a FHIR server does. */
function rewriteReferences(value: unknown, byFullUrl: ReadonlyMap<string, ResourceRef>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteReferences(item, byFullUrl));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const target =
      key === 'reference' && typeof inner === 'string' ? byFullUrl.get(inner) : undefined;
    copy[key] = target === undefined ? rewriteReferences(inner, byFullUrl) : refKey(target);
  }
  return copy;
}

function versionOf(resource: Record<string, unknown>): string {
  const meta = isPlainObject(resource['meta']) ? resource['meta'] : undefined;
  const versionId = meta?.['versionId'];
  const lastUpdated = meta?.['lastUpdated'];
  if (typeof versionId === 'string' && versionId !== '') {
    return versionId;
  }
  if (typeof lastUpdated === 'string' && lastUpdated !== '') {
    return lastUpdated;
  }
  return contentHash({ ...resource, meta: undefined });
}

/**
 * Validates the Bundle envelope, gives every entry an identity (resource
 * `id`, else the `urn:uuid:` / absolute `fullUrl`, else the `request.url` of
 * a conditional PUT), validates each consumed resource against its schema
 * and indexes everything for reference resolution.
 */
export function indexBundle(input: unknown): IndexResult {
  const envelope = BundleEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { ok: false, issues: zodIssuesToMappingIssues(envelope.error.issues, 'Bundle') };
  }
  const issues: MappingIssue[] = [];
  const rawEntries = isPlainObject(input) && Array.isArray(input['entry']) ? input['entry'] : [];

  interface Identified {
    readonly index: number;
    readonly fullUrl?: string;
    readonly ref: ResourceRef;
    readonly raw: Record<string, unknown>;
  }
  const identified: Identified[] = [];
  const byFullUrl = new Map<string, ResourceRef>();
  const byKey = new Map<string, number>();

  envelope.data.entry?.forEach((entry, index) => {
    const entryExpression = `Bundle.entry[${String(index)}]`;
    const raw: unknown = (rawEntries[index] as Record<string, unknown> | undefined)?.['resource'];
    if (entry.resource === undefined || !isPlainObject(raw)) {
      issues.push({
        severity: 'information',
        code: 'not-supported',
        message: `entry without a resource (${entry.request?.method ?? 'no request'}) is ignored`,
        expression: entryExpression,
      });
      return;
    }
    const resourceType = entry.resource.resourceType;
    const ownId = typeof raw['id'] === 'string' ? raw['id'] : undefined;
    const requestRef =
      entry.request === undefined ? undefined : parseLiteralReference(entry.request.url);
    const id =
      ownId ??
      (entry.fullUrl === undefined ? undefined : idFromFullUrl(entry.fullUrl, resourceType)) ??
      (requestRef?.resourceType === resourceType ? requestRef.id : undefined);
    if (id === undefined) {
      issues.push({
        severity: 'error',
        code: 'required',
        message:
          'cannot identify the resource: give it an id, a urn:uuid fullUrl or a PUT request.url',
        expression: entryExpression,
      });
      return;
    }
    const ref = { resourceType, id };
    const duplicate = byKey.get(refKey(ref));
    if (duplicate !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate',
        message: `${refKey(ref)} already appears in entry[${String(duplicate)}]`,
        expression: entryExpression,
      });
      return;
    }
    byKey.set(refKey(ref), identified.length);
    if (entry.fullUrl !== undefined) {
      byFullUrl.set(entry.fullUrl, ref);
    }
    identified.push({
      index,
      ...(entry.fullUrl === undefined ? {} : { fullUrl: entry.fullUrl }),
      ref,
      raw,
    });
  });

  const entries: IndexedEntry[] = identified.map(({ index, fullUrl, ref, raw }) => {
    const expression = `Bundle.entry[${String(index)}].resource`;
    const stored = {
      ...(rewriteReferences(raw, byFullUrl) as JsonObject),
      resourceType: ref.resourceType,
      id: ref.id,
    } as FhirResourceJson;
    const base = {
      index,
      expression,
      ...(fullUrl === undefined ? {} : { fullUrl }),
      ref,
      version: versionOf(stored),
      stored,
    };
    if (!isConsumedResourceType(ref.resourceType)) {
      return { ...base, invalid: false };
    }
    const result = CONSUMED_RESOURCE_SCHEMAS[ref.resourceType].safeParse(raw);
    if (!result.success) {
      issues.push(...zodIssuesToMappingIssues(result.error.issues, expression));
      return { ...base, invalid: true };
    }
    return { ...base, parsed: result.data, invalid: false };
  });

  const find = (ref: ResourceRef): IndexedEntry | undefined => {
    const position = byKey.get(refKey(ref));
    return position === undefined ? undefined : entries[position];
  };
  const index: BundleIndex = {
    type: envelope.data.type,
    entries,
    find,
    resolve(reference) {
      const local = byFullUrl.get(reference);
      if (local !== undefined) {
        return local;
      }
      if (reference.startsWith('urn:') || reference.startsWith('#')) {
        return undefined;
      }
      return parseLiteralReference(reference);
    },
    parsed<K extends ConsumedResourceType>(resourceType: K, ref: ResourceRef) {
      return ref.resourceType === resourceType
        ? (find(ref)?.parsed as ParsedResourceOf<K> | undefined)
        : undefined;
    },
  };
  return { ok: true, index, issues };
}
