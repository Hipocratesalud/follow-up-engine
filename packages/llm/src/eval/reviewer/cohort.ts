import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClinicalEvent,
  clinicId as toClinicId,
  type FhirResourceJson,
  observationComponents,
  type PatientRecordSnapshot,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import { mapBundleToBatches } from '@follow-up-engine/fhir';
import { z } from 'zod';

/** The instant the cohort's histories end on (the testkit's `BASE_DATE`). */
export const COHORT_AS_OF = new Date('2026-01-05T12:00:00.000Z');

/** A cohort patient file (`packages/testkit/fixtures/reviewer-cohort/*.json`), as the eval reads it. */
export const CohortPatientSchema = z.object({
  clinicId: z.string(),
  patientId: z.string(),
  kind: z.enum(['planted', 'control']),
  story: z.string(),
  expected: z.array(z.object({ category: z.string(), rule: z.string(), description: z.string() })),
  entries: z.array(z.object({ at: z.string(), kind: z.string(), bundle: z.unknown() })),
});
export type CohortPatient = z.infer<typeof CohortPatientSchema>;

export async function loadCohort(dir: string): Promise<CohortPatient[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const patients: CohortPatient[] = [];
  for (const file of files) {
    const parsed = CohortPatientSchema.safeParse(
      JSON.parse(await readFile(join(dir, file), 'utf8')),
    );
    if (!parsed.success)
      throw new Error(`Invalid cohort patient ${file}: ${z.prettifyError(parsed.error)}`);
    patients.push(parsed.data);
  }
  return patients;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(strings);
  return [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

/** Names and identifiers of a Patient resource: what is masked before the model (like the runtime does). */
export function redactTermsOf(patient: FhirResourceJson | undefined): string[] {
  if (patient === undefined) return [];
  return [
    ...new Set([
      ...records(patient['name']).flatMap((name) => [
        ...strings(name['text']),
        ...strings(name['family']),
        ...strings(name['given']),
      ]),
      ...records(patient['identifier']).flatMap((identifier) => strings(identifier['value'])),
    ]),
  ];
}

export interface CohortRecord {
  readonly patient: CohortPatient;
  readonly snapshot: PatientRecordSnapshot;
  readonly redactTerms: readonly string[];
}

/**
 * A cohort patient's record as the engine would hold it: every bundle mapped
 * by `@follow-up-engine/fhir` (the same mapper as live ingestion), panel
 * components read from the Observations, diagnoses from the coded
 * Conditions. No expectations or cases: coverage is not scored here.
 */
export function recordOf(patient: CohortPatient): CohortRecord {
  const events: ClinicalEvent[] = [];
  const components = new Map<string, ReturnType<typeof observationComponents>>();
  let patientResource: FhirResourceJson | undefined;
  for (const entry of patient.entries) {
    const mapping = mapBundleToBatches(entry.bundle, {
      clinicId: patient.clinicId,
      receivedAt: new Date(entry.at),
    });
    for (const batch of mapping.batches) events.push(...batch.events);
    for (const { resource } of mapping.resources) {
      if (resource.resourceType === 'Patient') patientResource = resource;
      if (resource.resourceType === 'Observation') {
        const parts = observationComponents(resource);
        if (parts.length > 0) components.set(`Observation/${resource.id}`, parts);
      }
    }
  }
  events.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const birthDate = patientResource?.['birthDate'];
  const gender = patientResource?.['gender'];
  return {
    patient,
    redactTerms: redactTermsOf(patientResource),
    snapshot: {
      clinicId: toClinicId(patient.clinicId),
      patientId: toPatientId(patient.patientId),
      now: COHORT_AS_OF,
      ...(typeof birthDate === 'string' ? { birthDate } : {}),
      ...(typeof gender === 'string' ? { gender } : {}),
      events,
      conditions: [],
      liveExpectations: [],
      activeCases: [],
      components,
    },
  };
}
