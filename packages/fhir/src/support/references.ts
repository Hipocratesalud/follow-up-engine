import type { ResourceRef } from '@follow-up-engine/core';

/** `[base/]Type/id[/_history/vid]`. */
const LITERAL_REFERENCE =
  /^(?:(.+)\/)?([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[A-Za-z0-9\-.]{1,64})?$/;

/** Parses a relative or absolute literal reference into a type and id. */
export function parseLiteralReference(reference: string): ResourceRef | undefined {
  const match = LITERAL_REFERENCE.exec(reference.split('?')[0] ?? reference);
  const resourceType = match?.[2];
  const id = match?.[3];
  return resourceType === undefined || id === undefined ? undefined : { resourceType, id };
}
