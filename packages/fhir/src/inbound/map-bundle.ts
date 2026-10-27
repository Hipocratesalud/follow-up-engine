import {
  clinicId as toClinicId,
  patientId as toPatientId,
  type ClinicalBatch,
  type ClinicId,
  type FhirResourceJson,
  type PatientId,
} from '@follow-up-engine/core';
import type { OperationOutcome } from '../fhir-types.ts';
import { hasErrors, toOperationOutcome, type MappingIssue } from '../support/operation-outcome.ts';
import { indexBundle, type BundleIndex, type IndexedEntry } from './bundle-index.ts';
import {
  createEntryContext,
  type EntryContext,
  type MappedClinicalEvent,
  type MappedResource,
} from './context.ts';
import { mapCondition } from './mappers/condition.ts';
import { encounterSpecialty, mapAppointment, mapEncounter } from './mappers/encounter.ts';
import { mapComposition, mapDocumentReference } from './mappers/notes.ts';
import { mapMedicationRequest, mapServiceRequest } from './mappers/orders.ts';
import { mapConsent, mapPatient } from './mappers/patient.ts';
import { mapDiagnosticReport, mapObservation } from './mappers/results.ts';
import type { ParsedResource } from './schemas.ts';

export interface MapBundleOptions {
  readonly clinicId: ClinicId | string;
  /** When the engine received the bundle; fallback for missing clinical times. */
  readonly receivedAt: Date;
}

/** A resource to store for a patient, with its id filled in and bundle references resolved. */
export interface PatientResource {
  readonly patientId: PatientId;
  readonly resource: FhirResourceJson;
}

export interface BundleMappingResult {
  /** One batch per patient and consultation; empty when a transaction is rejected. */
  readonly batches: readonly ClinicalBatch[];
  /** Every patient-scoped resource of the bundle, ready for `ClinicalRecordRepository.saveResource`. */
  readonly resources: readonly PatientResource[];
  /** Errors, warnings and notes; `undefined` when the bundle mapped cleanly. */
  readonly issues: OperationOutcome | undefined;
}

/** Resource types that only give context (resolved by reference) and are never reported. */
const CONTEXT_TYPES: readonly string[] = [
  'Medication',
  'Practitioner',
  'PractitionerRole',
  'Organization',
  'Location',
  'Device',
  'Specimen',
  'RelatedPerson',
  'HealthcareService',
];

function mapParsed(resource: ParsedResource, ctx: EntryContext): MappedResource | undefined {
  switch (resource.resourceType) {
    case 'Patient':
      return mapPatient(resource, ctx);
    case 'Consent':
      return mapConsent(resource, ctx);
    case 'Encounter':
      return mapEncounter(resource, ctx);
    case 'Appointment':
      return mapAppointment(resource, ctx);
    case 'ServiceRequest':
      return mapServiceRequest(resource, ctx);
    case 'MedicationRequest':
      return mapMedicationRequest(resource, ctx);
    case 'DiagnosticReport':
      return mapDiagnosticReport(resource, ctx);
    case 'Observation':
      return mapObservation(resource, ctx);
    case 'Condition':
      return mapCondition(resource, ctx);
    case 'DocumentReference':
      return mapDocumentReference(resource, ctx);
    case 'Composition':
      return mapComposition(resource, ctx);
    case 'Medication':
      return undefined;
  }
}

interface MappedEntry {
  readonly entry: IndexedEntry;
  readonly mapped: MappedResource;
}

/** Encounter id → specialty, for every Encounter in the bundle (any status). */
function encounterSpecialties(index: BundleIndex): ReadonlyMap<string, string> {
  const specialties = new Map<string, string>();
  for (const entry of index.entries) {
    if (entry.parsed?.resourceType === 'Encounter') {
      const specialty = encounterSpecialty(entry.parsed);
      if (specialty !== undefined) {
        specialties.set(entry.ref.id, specialty);
      }
    }
  }
  return specialties;
}

/**
 * Groups one patient's mapped entries into consultations. With at most one
 * Encounter in the bundle, everything belongs to it. With several, each
 * resource goes to the Encounter it references; the rest form a batch with
 * no `encounterId`.
 */
function groupByConsultation(
  entries: readonly MappedEntry[],
): Map<string | undefined, MappedEntry[]> {
  const encounterIds = entries
    .filter(({ entry }) => entry.ref.resourceType === 'Encounter')
    .map(({ entry }) => entry.ref.id);
  const groups = new Map<string | undefined, MappedEntry[]>();
  for (const item of entries) {
    const key =
      encounterIds.length <= 1
        ? encounterIds[0]
        : encounterIds.find((id) => id === item.mapped.encounterId);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

/** Orders issues by the entry they point at (bundle-level issues first); stable otherwise. */
function sortByEntry(issues: MappingIssue[]): void {
  const entryOf = (issue: MappingIssue): number =>
    Number(/^Bundle\.entry\[(\d+)\]/.exec(issue.expression)?.[1] ?? -1);
  issues.sort((a, b) => entryOf(a) - entryOf(b));
}

/**
 * Turns a FHIR R4 `transaction` or `batch` Bundle into the engine's
 * `ClinicalBatch`es: one per patient and consultation, events in bundle order.
 *
 * Semantics follow FHIR: a `transaction` is all-or-nothing (any error rejects
 * the whole bundle and no batch is returned); a `batch` maps every entry that
 * is valid and reports the rest.
 *
 * Pure and deterministic: the same bundle and options always give the same
 * batches, and each event carries a stable `idempotencyKey`.
 */
export function mapBundleToBatches(
  bundle: unknown,
  options: MapBundleOptions,
): BundleMappingResult {
  const clinic = toClinicId(options.clinicId);
  const indexed = indexBundle(bundle);
  if (!indexed.ok) {
    return { batches: [], resources: [], issues: toOperationOutcome(indexed.issues) };
  }
  const { index } = indexed;
  const issues: MappingIssue[] = [...indexed.issues];

  const mappedEntries: MappedEntry[] = [];
  for (const entry of index.entries) {
    if (entry.invalid) {
      continue;
    }
    if (entry.parsed === undefined) {
      if (!CONTEXT_TYPES.includes(entry.ref.resourceType)) {
        issues.push({
          severity: 'information',
          code: 'not-supported',
          message: `${entry.ref.resourceType} is not consumed by the engine; ignored`,
          expression: entry.expression,
        });
      }
      continue;
    }
    const entryIssues: MappingIssue[] = [];
    const mapped = mapParsed(
      entry.parsed,
      createEntryContext(entry, index, options.receivedAt, entryIssues),
    );
    issues.push(...entryIssues);
    if (!hasErrors(entryIssues) && mapped !== undefined) {
      mappedEntries.push({ entry, mapped });
    }
  }

  sortByEntry(issues);
  if (index.type === 'transaction' && hasErrors(issues)) {
    issues.push({
      severity: 'error',
      code: 'processing',
      message: 'transaction rejected: fix the errors above; nothing was processed',
      expression: 'Bundle',
    });
    return { batches: [], resources: [], issues: toOperationOutcome(issues) };
  }

  const byPatient = new Map<string, MappedEntry[]>();
  for (const item of mappedEntries) {
    const list = byPatient.get(item.mapped.patientId) ?? [];
    list.push(item);
    byPatient.set(item.mapped.patientId, list);
  }

  const specialties = encounterSpecialties(index);
  const batches: ClinicalBatch[] = [];
  const resources: PatientResource[] = [];
  for (const [rawPatientId, items] of byPatient) {
    const patient = toPatientId(rawPatientId);
    resources.push(...items.map(({ entry }) => ({ patientId: patient, resource: entry.stored })));
    for (const [encounterId, group] of groupByConsultation(items)) {
      const events = group.flatMap(({ mapped }) =>
        mapped.events.map((draft): MappedClinicalEvent => {
          const eventEncounter = mapped.encounterId ?? encounterId;
          const specialty =
            eventEncounter === undefined ? undefined : specialties.get(eventEncounter);
          const withSpecialty =
            draft.type === 'note.received' &&
            draft.specialty === undefined &&
            specialty !== undefined
              ? { ...draft, specialty }
              : draft;
          return {
            ...withSpecialty,
            clinicId: clinic,
            patientId: patient,
            ...(eventEncounter === undefined ? {} : { encounterId: eventEncounter }),
          };
        }),
      );
      if (events.length > 0) {
        batches.push({
          clinicId: clinic,
          patientId: patient,
          ...(encounterId === undefined ? {} : { encounterId }),
          receivedAt: options.receivedAt,
          events,
        });
      }
    }
  }
  return { batches, resources, issues: toOperationOutcome(issues) };
}

export interface BundleValidationResult {
  /** True when the bundle has no error or fatal issue. */
  readonly ok: boolean;
  readonly outcome: OperationOutcome | undefined;
}

/**
 * Validates a bundle exactly as {@link mapBundleToBatches} would read it,
 * without producing batches. Use it to answer a host with an
 * `OperationOutcome` before accepting the bundle.
 */
export function validateBundle(bundle: unknown): BundleValidationResult {
  const result = mapBundleToBatches(bundle, {
    clinicId: 'validation',
    receivedAt: new Date(0),
  });
  const ok = !(result.issues?.issue ?? []).some(
    (issue) => issue.severity === 'error' || issue.severity === 'fatal',
  );
  return { ok, outcome: result.issues };
}
