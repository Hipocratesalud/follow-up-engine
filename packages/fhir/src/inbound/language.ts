import { normalizeLanguageTag } from '@follow-up-engine/core';
import type { EntryContext } from './context.ts';

/** IETF BCP-47, the code system of FHIR `language` codings (ValueSet `all-languages`). */
export const BCP47_SYSTEM = 'urn:ietf:bcp:47';

/**
 * A FHIR `code` that should hold a BCP-47 tag, canonicalized; a value that is
 * not a tag is reported as a warning at `path` and ignored (never rejected:
 * a wrong language must not cost the clinic a note or a patient).
 */
export function readLanguageCode(
  ctx: EntryContext,
  value: string | undefined,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  const tag = normalizeLanguageTag(value);
  if (tag === undefined) {
    ctx.report('warning', 'code-invalid', `"${value}" is not a BCP-47 language tag; ignored`, path);
  }
  return tag;
}

interface LanguageConcept {
  readonly coding?:
    | readonly { readonly system?: string | undefined; readonly code?: string | undefined }[]
    | undefined;
  readonly text?: string | undefined;
}

/**
 * The BCP-47 tag of a language `CodeableConcept` (`Patient.communication.language`):
 * its `urn:ietf:bcp:47` coding first, then any coding whose code is a tag, then
 * a text that is a tag (`"es"`). `undefined` when nothing in it is a tag.
 */
export function languageOfConcept(concept: LanguageConcept): string | undefined {
  const codings = concept.coding ?? [];
  const ordered = [
    ...codings.filter((coding) => coding.system === BCP47_SYSTEM),
    ...codings.filter((coding) => coding.system !== BCP47_SYSTEM),
  ];
  for (const coding of ordered) {
    const tag = normalizeLanguageTag(coding.code);
    if (tag !== undefined) return tag;
  }
  return normalizeLanguageTag(concept.text);
}
