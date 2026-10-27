import type {
  ClinicalRecordRepository,
  ClinicId,
  FhirResourceJson,
  NoteExtractor,
} from '@follow-up-engine/core';

/** Resource types a `note.received` event can come from (`documentId` is their id). */
const NOTE_RESOURCE_TYPES = ['DocumentReference', 'Composition'] as const;

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

/**
 * What to mask in a note written about this patient: every name (text,
 * family, given), every identifier value (national id, record number) and
 * every phone or email the host sent in the Patient resource.
 */
export function patientRedactTerms(patient: FhirResourceJson): string[] {
  const terms = [
    ...records(patient['name']).flatMap((name) => [
      ...strings(name['text']),
      ...strings(name['family']),
      ...strings(name['given']),
    ]),
    ...records(patient['identifier']).flatMap((identifier) => strings(identifier['value'])),
    ...records(patient['telecom']).flatMap((telecom) => strings(telecom['value'])),
  ];
  return [...new Set(terms)];
}

/**
 * Wraps the engine's `NoteExtractor` so the patient's names and identifiers
 * travel with each note as `redactTerms`: the extractor masks them before the
 * note leaves for a third-party model. The engine only knows the document id,
 * so the composition root looks up the stored note resource, then its
 * patient. A note without a stored patient is read without masking terms.
 */
export function withPatientRedaction(
  inner: NoteExtractor,
  clinicalRecords: Pick<ClinicalRecordRepository, 'getResource'>,
): NoteExtractor {
  async function termsFor(clinicId: ClinicId, documentId: string): Promise<string[]> {
    for (const resourceType of NOTE_RESOURCE_TYPES) {
      const note = await clinicalRecords.getResource(clinicId, { resourceType, id: documentId });
      if (note === undefined) continue;
      const patient = await clinicalRecords.getResource(clinicId, {
        resourceType: 'Patient',
        id: note.patientId,
      });
      return patient === undefined ? [] : patientRedactTerms(patient.resource);
    }
    return [];
  }

  return {
    async extract(clinicId, input) {
      const terms = [...(input.redactTerms ?? []), ...(await termsFor(clinicId, input.documentId))];
      return inner.extract(
        clinicId,
        terms.length === 0 ? input : { ...input, redactTerms: [...new Set(terms)] },
      );
    },
  };
}
