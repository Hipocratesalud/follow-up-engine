import type {
  ClinicalEvent,
  ClinicalEventType,
  Coding,
  PlanExtractedEvent,
  ResourceRef,
} from '@follow-up-engine/core';
import { ENGINE_CODE_SYSTEMS } from '../terminology.ts';
import type { IssueCode, IssueSeverity, MappingIssue } from '../support/operation-outcome.ts';
import type { BundleIndex, IndexedEntry } from './bundle-index.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Events the FHIR mapping produces (`plan.extracted` comes from the LLM, never from FHIR). */
export type MappedClinicalEvent = Exclude<ClinicalEvent, PlanExtractedEvent>;

/** An event before it is assigned to a clinic, patient and consultation. */
export type EventDraft = DistributiveOmit<
  MappedClinicalEvent,
  'clinicId' | 'patientId' | 'encounterId'
>;

/** What one resource contributes to the batches of its patient. */
export interface MappedResource {
  readonly patientId: string;
  /** The consultation the resource belongs to (its own id for an Encounter). */
  readonly encounterId?: string;
  readonly events: readonly EventDraft[];
}

/** Everything a resource mapper needs; every helper reports problems at a precise path. */
export interface EntryContext {
  readonly entry: IndexedEntry;
  readonly bundle: BundleIndex;
  readonly receivedAt: Date;
  /** Records an issue at `<entry expression>.<path>`. */
  report(severity: IssueSeverity, code: IssueCode, message: string, path?: string): void;
  /**
   * Resolves a reference that must point at one of `expectedTypes`.
   * Reports an error (when `required`) or a warning and returns `undefined` otherwise.
   */
  follow(
    reference: { readonly reference?: string | undefined } | undefined,
    path: string,
    expectedTypes: readonly string[],
    required: boolean,
  ): ResourceRef | undefined;
  /** The base fields of an event derived from this entry. */
  base<TType extends ClinicalEventType>(
    type: TType,
    occurredAt: Date | undefined,
  ): {
    readonly type: TType;
    readonly source: ResourceRef;
    readonly occurredAt: Date;
    readonly idempotencyKey: string;
  };
}

export function createEntryContext(
  entry: IndexedEntry,
  bundle: BundleIndex,
  receivedAt: Date,
  issues: MappingIssue[],
): EntryContext {
  const expressionOf = (path: string | undefined): string =>
    path === undefined || path === '' ? entry.expression : `${entry.expression}.${path}`;
  const report: EntryContext['report'] = (severity, code, message, path) => {
    issues.push({ severity, code, message, expression: expressionOf(path) });
  };
  return {
    entry,
    bundle,
    receivedAt,
    report,
    follow(reference, path, expectedTypes, required) {
      const severity = required ? 'error' : 'warning';
      const literal = reference?.reference;
      if (literal === undefined) {
        if (required) {
          report('error', 'required', 'a literal reference is required', path);
        }
        return undefined;
      }
      const target = bundle.resolve(literal);
      if (target === undefined) {
        report(severity, 'not-found', `cannot resolve reference "${literal}"`, path);
        return undefined;
      }
      if (!expectedTypes.includes(target.resourceType)) {
        report(
          severity,
          'value',
          `expected a reference to ${expectedTypes.join(' or ')}, got ${target.resourceType}`,
          path,
        );
        return undefined;
      }
      return target;
    },
    base(type, occurredAt) {
      return {
        type,
        source: entry.ref,
        occurredAt: occurredAt ?? receivedAt,
        idempotencyKey: `${entry.ref.resourceType}/${entry.ref.id}/${entry.version}#${type}`,
      };
    },
  };
}

/** A `CodeableConcept` as read by the mapping. */
export interface ConceptInput {
  readonly coding?:
    | readonly {
        readonly system?: string | undefined;
        readonly code?: string | undefined;
        readonly display?: string | undefined;
      }[]
    | undefined;
  readonly text?: string | undefined;
}

/** The first coding that has both a system and a code, preferring `preferredSystems` in order. */
export function pickCoding(
  concept: ConceptInput | undefined,
  preferredSystems: readonly string[] = [],
): Coding | undefined {
  const complete = (concept?.coding ?? []).flatMap((coding) =>
    coding.system !== undefined && coding.code !== undefined
      ? [
          {
            system: coding.system,
            code: coding.code,
            ...(coding.display === undefined ? {} : { display: coding.display }),
          },
        ]
      : [],
  );
  for (const system of preferredSystems) {
    const preferred = complete.find((coding) => coding.system === system);
    if (preferred !== undefined) {
      return preferred;
    }
  }
  return complete[0];
}

/** Human label of a concept: its text, else the first display, else the first code. */
export function conceptLabel(concept: ConceptInput | undefined): string | undefined {
  const codings = concept?.coding ?? [];
  return (
    concept?.text ??
    codings.find((coding) => coding.display !== undefined)?.display ??
    codings.find((coding) => coding.code !== undefined)?.code
  );
}

/** Whether any coding of the concept has one of the codes (in `system`, when given). */
export function hasCode(
  concept: ConceptInput | undefined,
  codes: readonly string[],
  system?: string,
): boolean {
  return (concept?.coding ?? []).some(
    (coding) =>
      coding.code !== undefined &&
      codes.includes(coding.code) &&
      (system === undefined || coding.system === system),
  );
}

/**
 * The specialty named by a concept: the code when it is in the engine's
 * specialty CodeSystem, else the concept's label.
 */
export function specialtyOf(
  ...concepts: readonly (ConceptInput | undefined)[]
): string | undefined {
  for (const concept of concepts) {
    const engineCode = pickCoding(concept, [ENGINE_CODE_SYSTEMS.specialty]);
    if (engineCode?.system === ENGINE_CODE_SYSTEMS.specialty) {
      return engineCode.code;
    }
    const label = conceptLabel(concept);
    if (label !== undefined) {
      return label;
    }
  }
  return undefined;
}

/** Lowercase ASCII slug, used to key uncoded concepts. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'unnamed' : slug;
}

/** A placeholder coding for a concept that only has text. */
export function uncodedCoding(text: string): Coding {
  return { system: ENGINE_CODE_SYSTEMS.uncoded, code: slugify(text), display: text };
}
