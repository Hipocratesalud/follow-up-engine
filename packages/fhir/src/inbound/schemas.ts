import { z } from 'zod';
import type * as R4 from '../fhir-types.ts';
import { FHIR_DATE_TIME_PATTERN } from '../support/datetime.ts';

/**
 * Zod schemas for the FHIR R4 subset the engine consumes.
 *
 * Tolerant: unknown elements are allowed (and kept in the stored resource);
 * the schemas only describe what the mapping reads. Strict on what it needs:
 * a resource that cannot be mapped (no subject, no code, an invalid status)
 * is rejected with a precise path.
 *
 * Each schema `satisfies z.ZodType<Partial<R4.X>>`, so its output stays
 * assignable to the `@types/fhir` definition: a typo or a wrong cardinality
 * here fails to compile.
 */

// ---------------------------------------------------------------------------
// Primitive and general-purpose data types

const fhirString = z.string().min(1, 'FHIR strings must not be empty');
const fhirId = z
  .string()
  .regex(/^[A-Za-z0-9\-.]{1,64}$/, 'expected a FHIR id ([A-Za-z0-9-.]{1,64})');
const fhirDateTime = z.string().regex(FHIR_DATE_TIME_PATTERN, 'expected a FHIR dateTime');

export const CodingSchema = z.object({
  system: fhirString.optional(),
  version: fhirString.optional(),
  code: fhirString.optional(),
  display: fhirString.optional(),
}) satisfies z.ZodType<R4.Coding>;

export const CodeableConceptSchema = z.object({
  coding: z.array(CodingSchema).optional(),
  text: fhirString.optional(),
}) satisfies z.ZodType<R4.CodeableConcept>;

/** A concept the engine needs to read: at least one coding with a code, or a text. */
const UsableConceptSchema = CodeableConceptSchema.refine(
  (concept) =>
    concept.text !== undefined || (concept.coding ?? []).some((c) => c.code !== undefined),
  { message: 'expected at least one coding with a code, or a text' },
);

export const ReferenceSchema = z.object({
  reference: fhirString.optional(),
  type: fhirString.optional(),
  identifier: z.object({ system: fhirString.optional(), value: fhirString.optional() }).optional(),
  display: fhirString.optional(),
}) satisfies z.ZodType<R4.Reference>;

/** A reference the mapping must follow: it needs a literal `reference`. */
const LiteralReferenceSchema = ReferenceSchema.extend({
  reference: fhirString,
});

export const PeriodSchema = z.object({
  start: fhirDateTime.optional(),
  end: fhirDateTime.optional(),
}) satisfies z.ZodType<R4.Period>;

export const DurationSchema = z.object({
  value: z.number().optional(),
  unit: fhirString.optional(),
  system: fhirString.optional(),
  code: fhirString.optional(),
}) satisfies z.ZodType<R4.Quantity>;

/** A measured amount (`Observation.valueQuantity`). */
export const QuantitySchema = z.object({
  value: z.number().optional(),
  comparator: z.enum(['<', '<=', '>=', '>']).optional(),
  unit: fhirString.optional(),
  system: fhirString.optional(),
  code: fhirString.optional(),
}) satisfies z.ZodType<R4.Quantity>;

const ExtensionSchema = z.object({
  url: fhirString,
  valueBoolean: z.boolean().optional(),
}) satisfies z.ZodType<R4.Extension>;

const MetaSchema = z.object({
  versionId: fhirId.optional(),
  lastUpdated: fhirDateTime.optional(),
}) satisfies z.ZodType<R4.Resource['meta']>;

const NarrativeSchema = z.object({
  status: z.enum(['generated', 'extensions', 'additional', 'empty']),
  div: z.string(),
}) satisfies z.ZodType<R4.Narrative>;

const resourceBase = <TType extends string>(resourceType: TType) => ({
  resourceType: z.literal(resourceType),
  id: fhirId.optional(),
  meta: MetaSchema.optional(),
  /** `Resource.language` (BCP-47); read as a note's language, validated where read. */
  language: fhirString.optional(),
});

// ---------------------------------------------------------------------------
// Resources

export const PatientSchema = z.object({
  ...resourceBase('Patient'),
  active: z.boolean().optional(),
  extension: z.array(ExtensionSchema).optional(),
  communication: z
    .array(z.object({ language: CodeableConceptSchema, preferred: z.boolean().optional() }))
    .optional(),
}) satisfies z.ZodType<Partial<R4.Patient>>;

export const ConsentSchema = z.object({
  ...resourceBase('Consent'),
  status: z.enum(['draft', 'proposed', 'active', 'rejected', 'inactive', 'entered-in-error']),
  patient: LiteralReferenceSchema,
  category: z.array(CodeableConceptSchema).min(1),
  dateTime: fhirDateTime.optional(),
  provision: z.object({ type: z.enum(['deny', 'permit']).optional() }).optional(),
}) satisfies z.ZodType<Partial<R4.Consent>>;

export const EncounterSchema = z.object({
  ...resourceBase('Encounter'),
  status: z.enum([
    'planned',
    'arrived',
    'triaged',
    'in-progress',
    'onleave',
    'finished',
    'cancelled',
    'entered-in-error',
    'unknown',
  ]),
  subject: LiteralReferenceSchema,
  type: z.array(CodeableConceptSchema).optional(),
  serviceType: CodeableConceptSchema.optional(),
  participant: z
    .array(
      z.object({
        type: z.array(CodeableConceptSchema).optional(),
        individual: ReferenceSchema.optional(),
      }),
    )
    .optional(),
  period: PeriodSchema.optional(),
}) satisfies z.ZodType<Partial<R4.Encounter>>;

/** An `Appointment` extension the engine reads (the follow-up case it answers, HIP-141). */
const AppointmentExtensionSchema = z.object({
  url: fhirString,
  valueReference: ReferenceSchema.optional(),
}) satisfies z.ZodType<R4.Extension>;

export const AppointmentSchema = z.object({
  ...resourceBase('Appointment'),
  extension: z.array(AppointmentExtensionSchema).optional(),
  // Attribution (HIP-141): the case `Task` or the `CommunicationRequest` the
  // booking answers. `basedOn` targets ServiceRequest in strict R4 profiles;
  // `supportingInformation` (Reference(Any)) and the extension are conformant.
  basedOn: z.array(ReferenceSchema).optional(),
  supportingInformation: z.array(ReferenceSchema).optional(),
  status: z.enum([
    'proposed',
    'pending',
    'booked',
    'arrived',
    'fulfilled',
    'cancelled',
    'noshow',
    'entered-in-error',
    'checked-in',
    'waitlist',
  ]),
  serviceType: z.array(CodeableConceptSchema).optional(),
  specialty: z.array(CodeableConceptSchema).optional(),
  appointmentType: CodeableConceptSchema.optional(),
  start: fhirDateTime.optional(),
  end: fhirDateTime.optional(),
  created: fhirDateTime.optional(),
  participant: z
    .array(
      z.object({
        actor: ReferenceSchema.optional(),
        status: z.enum(['accepted', 'declined', 'tentative', 'needs-action']),
      }),
    )
    .min(1),
}) satisfies z.ZodType<Partial<R4.Appointment>>;

export const ServiceRequestSchema = z.object({
  ...resourceBase('ServiceRequest'),
  status: z.enum([
    'draft',
    'active',
    'on-hold',
    'revoked',
    'completed',
    'entered-in-error',
    'unknown',
  ]),
  intent: z.enum([
    'proposal',
    'plan',
    'directive',
    'order',
    'original-order',
    'reflex-order',
    'filler-order',
    'instance-order',
    'option',
  ]),
  category: z.array(CodeableConceptSchema).optional(),
  code: UsableConceptSchema,
  subject: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  occurrenceDateTime: fhirDateTime.optional(),
  authoredOn: fhirDateTime.optional(),
}) satisfies z.ZodType<Partial<R4.ServiceRequest>>;

export const MedicationSchema = z.object({
  ...resourceBase('Medication'),
  code: CodeableConceptSchema.optional(),
}) satisfies z.ZodType<Partial<R4.Medication>>;

export const MedicationRequestSchema = z
  .object({
    ...resourceBase('MedicationRequest'),
    status: z.enum([
      'active',
      'on-hold',
      'cancelled',
      'completed',
      'entered-in-error',
      'stopped',
      'draft',
      'unknown',
    ]),
    intent: z.enum([
      'proposal',
      'plan',
      'order',
      'original-order',
      'reflex-order',
      'filler-order',
      'instance-order',
      'option',
    ]),
    medicationCodeableConcept: UsableConceptSchema.optional(),
    medicationReference: ReferenceSchema.optional(),
    subject: LiteralReferenceSchema,
    encounter: ReferenceSchema.optional(),
    authoredOn: fhirDateTime.optional(),
    dosageInstruction: z
      .array(
        z.object({
          text: fhirString.optional(),
          asNeededBoolean: z.boolean().optional(),
          asNeededCodeableConcept: CodeableConceptSchema.optional(),
          timing: z
            .object({
              repeat: z
                .object({
                  boundsDuration: DurationSchema.optional(),
                  boundsPeriod: PeriodSchema.optional(),
                })
                .optional(),
            })
            .optional(),
        }),
      )
      .optional(),
    dispenseRequest: z
      .object({
        validityPeriod: PeriodSchema.optional(),
        numberOfRepeatsAllowed: z.number().int().nonnegative().optional(),
        expectedSupplyDuration: DurationSchema.optional(),
      })
      .optional(),
  })
  .refine(
    (request) =>
      request.medicationCodeableConcept !== undefined || request.medicationReference !== undefined,
    {
      message: 'expected medicationCodeableConcept or medicationReference',
      path: ['medication[x]'],
    },
  ) satisfies z.ZodType<Partial<R4.MedicationRequest>>;

const RESULT_STATUSES = [
  'registered',
  'preliminary',
  'final',
  'amended',
  'corrected',
  'cancelled',
  'entered-in-error',
  'unknown',
] as const;

export const ObservationSchema = z.object({
  ...resourceBase('Observation'),
  status: z.enum(RESULT_STATUSES),
  basedOn: z.array(ReferenceSchema).optional(),
  code: UsableConceptSchema,
  subject: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  effectiveDateTime: fhirDateTime.optional(),
  effectivePeriod: PeriodSchema.optional(),
  effectiveInstant: fhirDateTime.optional(),
  issued: fhirDateTime.optional(),
  valueQuantity: QuantitySchema.optional(),
  valueDateTime: fhirDateTime.optional(),
  interpretation: z.array(CodeableConceptSchema).optional(),
}) satisfies z.ZodType<Partial<R4.Observation>>;

export const DiagnosticReportSchema = z.object({
  ...resourceBase('DiagnosticReport'),
  status: z.enum([...RESULT_STATUSES, 'partial', 'appended']),
  basedOn: z.array(ReferenceSchema).optional(),
  code: UsableConceptSchema,
  subject: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  effectiveDateTime: fhirDateTime.optional(),
  effectivePeriod: PeriodSchema.optional(),
  issued: fhirDateTime.optional(),
  result: z.array(ReferenceSchema).optional(),
  conclusion: fhirString.optional(),
  conclusionCode: z.array(CodeableConceptSchema).optional(),
}) satisfies z.ZodType<Partial<R4.DiagnosticReport>>;

export const ConditionSchema = z.object({
  ...resourceBase('Condition'),
  clinicalStatus: CodeableConceptSchema.optional(),
  verificationStatus: CodeableConceptSchema.optional(),
  code: UsableConceptSchema,
  subject: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  onsetDateTime: fhirDateTime.optional(),
  recordedDate: fhirDateTime.optional(),
}) satisfies z.ZodType<Partial<R4.Condition>>;

export const AllergyIntoleranceSchema = z.object({
  ...resourceBase('AllergyIntolerance'),
  clinicalStatus: CodeableConceptSchema.optional(),
  verificationStatus: CodeableConceptSchema.optional(),
  type: z.enum(['allergy', 'intolerance']).optional(),
  category: z.array(z.enum(['food', 'medication', 'environment', 'biologic'])).optional(),
  criticality: z.enum(['low', 'high', 'unable-to-assess']).optional(),
  code: UsableConceptSchema.optional(),
  patient: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  onsetDateTime: fhirDateTime.optional(),
  recordedDate: fhirDateTime.optional(),
}) satisfies z.ZodType<Partial<R4.AllergyIntolerance>>;

export const DocumentReferenceSchema = z.object({
  ...resourceBase('DocumentReference'),
  status: z.enum(['current', 'superseded', 'entered-in-error']),
  docStatus: z.enum(['preliminary', 'final', 'amended', 'entered-in-error']).optional(),
  type: CodeableConceptSchema.optional(),
  subject: LiteralReferenceSchema,
  date: fhirDateTime.optional(),
  description: fhirString.optional(),
  text: NarrativeSchema.optional(),
  content: z
    .array(
      z.object({
        attachment: z.object({
          contentType: fhirString.optional(),
          language: fhirString.optional(),
          data: z.string().optional(),
          title: fhirString.optional(),
        }),
      }),
    )
    .min(1),
  context: z
    .object({
      encounter: z.array(ReferenceSchema).optional(),
      period: PeriodSchema.optional(),
      practiceSetting: CodeableConceptSchema.optional(),
    })
    .optional(),
  relatesTo: z
    .array(
      z.object({
        code: z.enum(['replaces', 'transforms', 'signs', 'appends']),
        target: ReferenceSchema,
      }),
    )
    .optional(),
}) satisfies z.ZodType<Partial<R4.DocumentReference>>;

/** One `Composition.section`, recursively. */
export interface CompositionSectionInput {
  title?: string | undefined;
  text?: z.output<typeof NarrativeSchema> | undefined;
  section?: CompositionSectionInput[] | undefined;
}

const CompositionSectionSchema: z.ZodType<CompositionSectionInput> = z.lazy(() =>
  z.object({
    title: fhirString.optional(),
    text: NarrativeSchema.optional(),
    section: z.array(CompositionSectionSchema).optional(),
  }),
);

export const CompositionSchema = z.object({
  ...resourceBase('Composition'),
  status: z.enum(['preliminary', 'final', 'amended', 'entered-in-error']),
  type: CodeableConceptSchema,
  subject: LiteralReferenceSchema,
  encounter: ReferenceSchema.optional(),
  date: fhirDateTime,
  title: fhirString,
  text: NarrativeSchema.optional(),
  section: z.array(CompositionSectionSchema).optional(),
}) satisfies z.ZodType<Partial<R4.Composition>>;

/** A `Communication` extension the engine reads (the contact outcome). */
const CommunicationExtensionSchema = z.object({
  url: fhirString,
  valueCodeableConcept: CodeableConceptSchema.optional(),
  valueCode: fhirString.optional(),
}) satisfies z.ZodType<R4.Extension>;

/**
 * What came of a contact attempt, reported by the host: `basedOn` the
 * engine's `CommunicationRequest`, the outcome in the `contact-outcome`
 * extension or `statusReason`.
 */
export const CommunicationSchema = z.object({
  ...resourceBase('Communication'),
  extension: z.array(CommunicationExtensionSchema).optional(),
  basedOn: z
    .array(ReferenceSchema)
    .min(1, 'a Communication must be basedOn a CommunicationRequest'),
  status: z.enum([
    'preparation',
    'in-progress',
    'not-done',
    'on-hold',
    'stopped',
    'completed',
    'entered-in-error',
    'unknown',
  ]),
  statusReason: CodeableConceptSchema.optional(),
  subject: LiteralReferenceSchema,
  medium: z.array(CodeableConceptSchema).optional(),
  sent: fhirDateTime.optional(),
  received: fhirDateTime.optional(),
  sender: ReferenceSchema.optional(),
}) satisfies z.ZodType<Partial<R4.Communication>>;

// ---------------------------------------------------------------------------
// Bundle envelope

export const BUNDLE_TYPES_ACCEPTED = ['transaction', 'batch'] as const;

export const BundleEnvelopeSchema = z.object({
  resourceType: z.literal('Bundle'),
  id: fhirId.optional(),
  meta: MetaSchema.optional(),
  type: z.enum(BUNDLE_TYPES_ACCEPTED, {
    message: 'only "transaction" and "batch" Bundles are accepted',
  }),
  timestamp: fhirDateTime.optional(),
  entry: z
    .array(
      z.object({
        fullUrl: fhirString.optional(),
        resource: z.looseObject({ resourceType: fhirString }).optional(),
        request: z
          .object({
            method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']),
            url: fhirString,
          })
          .optional(),
      }),
    )
    .optional(),
});

/** Schemas of the resources that produce clinical events, by `resourceType`. */
export const CONSUMED_RESOURCE_SCHEMAS = {
  Patient: PatientSchema,
  Consent: ConsentSchema,
  Encounter: EncounterSchema,
  Appointment: AppointmentSchema,
  ServiceRequest: ServiceRequestSchema,
  MedicationRequest: MedicationRequestSchema,
  Observation: ObservationSchema,
  DiagnosticReport: DiagnosticReportSchema,
  Condition: ConditionSchema,
  AllergyIntolerance: AllergyIntoleranceSchema,
  DocumentReference: DocumentReferenceSchema,
  Composition: CompositionSchema,
  Communication: CommunicationSchema,
  Medication: MedicationSchema,
} as const;

export type ConsumedResourceType = keyof typeof CONSUMED_RESOURCE_SCHEMAS;

/** The parsed (validated) form of each consumed resource type. */
export type ParsedResource = {
  [K in ConsumedResourceType]: z.output<(typeof CONSUMED_RESOURCE_SCHEMAS)[K]>;
}[ConsumedResourceType];

export type ParsedResourceOf<K extends ConsumedResourceType> = z.output<
  (typeof CONSUMED_RESOURCE_SCHEMAS)[K]
>;

export function isConsumedResourceType(value: string): value is ConsumedResourceType {
  return Object.hasOwn(CONSUMED_RESOURCE_SCHEMAS, value);
}
