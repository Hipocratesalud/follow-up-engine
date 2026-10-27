import { SYSTEMS, type Specialty } from '../constants.ts';
import { type FhirResource, transactionBundle } from './fhir-builders.ts';
import type { Prng } from './prng.ts';
import type { TimelineEntry } from './timeline.ts';

/**
 * The patient's allergy status, recorded at intake as FHIR AllergyIntolerance
 * (SNOMED CT): most patients "no known allergy" (716186003), some a drug
 * allergy. Not everyone: a psychologist rarely records it, and a record
 * without one is what the clinical reviewer's record-quality check looks
 * for. Sent as a bundle of its own right after the first consultation, from
 * a generator forked per patient, so every other bundle stays the same.
 */

/** How often each specialty records the allergy status at intake. */
const RECORD_RATE: Record<Specialty, number> = {
  diabetology: 0.8,
  internal_medicine: 0.8,
  gynecology: 0.6,
  psychology: 0.3,
};
/** Of the recorded statuses, the share that is "no known allergy". */
const NO_KNOWN_ALLERGY_RATE = 0.75;

interface DrugAllergy {
  readonly code: string;
  readonly display: string;
  readonly text: string;
  readonly criticality: 'low' | 'high';
  readonly reaction: { readonly code: string; readonly display: string; readonly text: string };
}

const DRUG_ALLERGIES: readonly DrugAllergy[] = [
  {
    code: '764146007',
    display: 'Penicillin',
    text: 'Penicilina',
    criticality: 'high',
    reaction: { code: '126485001', display: 'Urticaria', text: 'Urticaria' },
  },
  {
    code: '387406002',
    display: 'Sulfonamide',
    text: 'Sulfas',
    criticality: 'low',
    reaction: { code: '271807003', display: 'Eruption of skin', text: 'Erupción cutánea' },
  },
  {
    code: '372665008',
    display: 'Non-steroidal anti-inflammatory agent',
    text: 'AINEs',
    criticality: 'high',
    reaction: { code: '41291007', display: 'Angioedema', text: 'Angioedema' },
  },
];

const ALLERGY_CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const ALLERGY_VERIFICATION =
  'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';
/** Sent this long after the first consultation's bundle. */
const AFTER_INTAKE_MS = 2 * 60_000;

function referenceOf(
  resource: FhirResource | undefined,
  path: readonly string[],
): string | undefined {
  let value: unknown = resource;
  for (const key of path) {
    value = Array.isArray(value) ? value[0] : (value as Record<string, unknown> | undefined)?.[key];
  }
  if (Array.isArray(value)) value = value[0];
  const reference = (value as { reference?: unknown } | undefined)?.reference;
  return typeof reference === 'string' ? reference : undefined;
}

/**
 * The patient's entries with the allergy status bundle added after the
 * first consultation, or unchanged when the clinic never recorded it.
 */
export function withAllergyStatus(
  patientId: string,
  specialty: Specialty,
  entries: readonly TimelineEntry[],
  rng: Prng,
): TimelineEntry[] {
  const first = entries.find((entry) => entry.kind === 'consultation');
  if (first === undefined || !rng.chance(RECORD_RATE[specialty])) {
    return [...entries];
  }
  const resources = first.bundle.entry.map((entry) => entry.resource);
  const encounter = resources.find((resource) => resource.resourceType === 'Encounter');
  const practitioner = referenceOf(encounter, ['participant', 'individual']);
  const at = new Date(new Date(first.at).getTime() + AFTER_INTAKE_MS);
  const id = `${patientId}-al01`;
  const common: FhirResource = {
    resourceType: 'AllergyIntolerance',
    id,
    clinicalStatus: { coding: [{ system: ALLERGY_CLINICAL, code: 'active', display: 'Active' }] },
    verificationStatus: {
      coding: [{ system: ALLERGY_VERIFICATION, code: 'confirmed', display: 'Confirmed' }],
    },
  };
  const context = {
    patient: { reference: `Patient/${patientId}` },
    ...(encounter === undefined ? {} : { encounter: { reference: `Encounter/${encounter.id}` } }),
    recordedDate: at.toISOString(),
    ...(practitioner === undefined ? {} : { recorder: { reference: practitioner } }),
  };
  const allergy: FhirResource = rng.chance(NO_KNOWN_ALLERGY_RATE)
    ? {
        ...common,
        code: {
          coding: [{ system: SYSTEMS.snomed, code: '716186003', display: 'No known allergy' }],
          text: 'Sin alergias conocidas',
        },
        ...context,
      }
    : drugAllergy(common, context, rng.pick(DRUG_ALLERGIES));
  const entry: TimelineEntry = {
    at: at.toISOString(),
    kind: 'allergy',
    bundle: transactionBundle(`${patientId}-allergy01`, at, [allergy]),
  };
  return [...entries, entry].sort((left, right) => left.at.localeCompare(right.at));
}

function drugAllergy(
  common: FhirResource,
  context: Record<string, unknown>,
  drug: DrugAllergy,
): FhirResource {
  return {
    ...common,
    type: 'allergy',
    category: ['medication'],
    criticality: drug.criticality,
    code: {
      coding: [{ system: SYSTEMS.snomed, code: drug.code, display: drug.display }],
      text: drug.text,
    },
    ...context,
    reaction: [
      {
        manifestation: [
          {
            coding: [
              { system: SYSTEMS.snomed, code: drug.reaction.code, display: drug.reaction.display },
            ],
            text: drug.reaction.text,
          },
        ],
      },
    ],
  };
}
