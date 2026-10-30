import { z } from 'zod';
import { CONSULTATION_DOCUMENT_TYPES } from '@follow-up-engine/fhir';

/** `YYYY-MM-DD`, the day on the engine's calendar (the clinic's date picker). */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const calendarDay = z
  .string()
  .regex(CALENDAR_DAY)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T12:00:00Z`)));

/** "Sex" of a fictitious lab patient: kept separate from FHIR `gender` at the edge. */
export const LAB_PATIENT_SEXES = ['male', 'female', 'other', 'unknown'] as const;

export const LabPatientCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sex: z.enum(LAB_PATIENT_SEXES).optional(),
    /** Years; the engine stores an approximate birth date. */
    age: z.number().int().min(0).max(120).optional(),
    specialty: z.string().trim().min(1).max(64).optional(),
  })
  .meta({ id: 'LabPatientCreate' });

export const LabPatientSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    age: z.number().int().optional(),
    sex: z.enum(LAB_PATIENT_SEXES).optional(),
  })
  .meta({ id: 'LabPatient' });

const NewLabPatientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sex: z.enum(LAB_PATIENT_SEXES).optional(),
  age: z.number().int().min(0).max(120).optional(),
  specialty: z.string().trim().min(1).max(64).optional(),
});

/** ~2 MB of base64 (4/3 overhead plus headroom). */
const MAX_BASE64_LENGTH = 2_900_000;

export const LabDocumentUploadSchema = z
  .object({
    patientId: z.string().trim().min(1).max(64).optional(),
    newPatient: NewLabPatientSchema.optional(),
    /** Pasted text, as an alternative to a file. */
    text: z.string().trim().min(1).max(50_000).optional(),
    filename: z.string().trim().min(1).max(200).optional(),
    contentType: z.string().trim().min(1).max(100).optional(),
    /** Base64 of the file; required with `filename`/`contentType`. */
    dataBase64: z.string().min(1).max(MAX_BASE64_LENGTH).optional(),
    /** The engine clock's date by default; past dates allowed. */
    documentDate: calendarDay,
    documentType: z.enum(CONSULTATION_DOCUMENT_TYPES),
    specialty: z.string().trim().min(1).max(64).optional(),
  })
  .refine((body) => body.patientId !== undefined || body.newPatient !== undefined, {
    params: { message: 'labPatientRequired' },
    path: ['patientId'],
  })
  .refine((body) => body.text !== undefined || body.dataBase64 !== undefined, {
    params: { message: 'labDocumentRequired' },
    path: ['text'],
  })
  .meta({ id: 'LabDocumentUpload' });

export const LabImpactQuerySchema = z
  .object({
    date: calendarDay,
    patientId: z.string().trim().min(1).max(64).optional(),
  })
  .meta({ id: 'LabImpactQuery' });

/**
 * A structured record the evaluator lab adds directly, with no note and no
 * LLM reading (`buildRecordBundle`, `@follow-up-engine/fhir`): one "Add to
 * the record" action, one minimal shape per kind.
 */
export const LAB_RECORD_KINDS = [
  'order',
  'result',
  'prescription',
  'visit',
  'diagnosis',
  'appointment_booked',
  'appointment_cancelled',
] as const;

const LabOrderEntrySchema = z.object({
  kind: z.literal('order'),
  loinc: z.string().trim().min(1).max(20),
  display: z.string().trim().min(1).max(120),
  category: z.enum(['laboratory', 'imaging']).optional(),
});

const LabResultEntrySchema = z.object({
  kind: z.literal('result'),
  loinc: z.string().trim().min(1).max(20),
  display: z.string().trim().min(1).max(120),
  value: z.number().optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  interpretation: z.enum(['normal', 'abnormal']).optional(),
  basedOnOrderId: z.string().trim().min(1).max(100).optional(),
});

const LabPrescriptionEntrySchema = z.object({
  kind: z.literal('prescription'),
  text: z.string().trim().min(1).max(200),
  durationDays: z.number().int().min(1).max(3650).optional(),
});

const LabVisitEntrySchema = z.object({ kind: z.literal('visit') });

const LabDiagnosisEntrySchema = z.object({
  kind: z.literal('diagnosis'),
  icd10: z.string().trim().min(1).max(20),
  display: z.string().trim().min(1).max(200).optional(),
});

const LabAppointmentBookedEntrySchema = z.object({
  kind: z.literal('appointment_booked'),
  /** `YYYY-MM-DD`; the appointment's own date, which may differ from the record's date. */
  scheduledFor: calendarDay,
  specialty: z.string().trim().min(1).max(64).optional(),
});

const LabAppointmentCancelledEntrySchema = z.object({
  kind: z.literal('appointment_cancelled'),
  /** The `Appointment.id` a booked-appointment record returned. */
  appointmentId: z.string().trim().min(1).max(100),
  scheduledFor: calendarDay,
});

export const LabRecordEntrySchema = z.discriminatedUnion('kind', [
  LabOrderEntrySchema,
  LabResultEntrySchema,
  LabPrescriptionEntrySchema,
  LabVisitEntrySchema,
  LabDiagnosisEntrySchema,
  LabAppointmentBookedEntrySchema,
  LabAppointmentCancelledEntrySchema,
]);

export const LabRecordAddSchema = z
  .object({
    patientId: z.string().trim().min(1).max(64),
    /** The engine clock's date by default; past dates allowed. */
    recordDate: calendarDay,
    entry: LabRecordEntrySchema,
  })
  .meta({ id: 'LabRecordAdd' });

export type LabRecordEntry = z.infer<typeof LabRecordEntrySchema>;
export type LabRecordAdd = z.infer<typeof LabRecordAddSchema>;

/** Most documents one "Import history" request takes (the request body is capped at 5 MB too). */
export const MAX_LAB_HISTORY_DOCUMENTS = 12;

const LabHistoryDocumentSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(100),
  /** Base64 of the file (PDF, DOCX, TXT, or a JPEG/PNG/WebP photo of a result). */
  dataBase64: z.string().min(1).max(MAX_BASE64_LENGTH),
  /** When the document was written: the replay's chronological order. */
  documentDate: calendarDay,
  /** `lab_result` (and every photo) is read as a lab report; anything else as a clinical note. */
  documentType: z.enum(CONSULTATION_DOCUMENT_TYPES),
  specialty: z.string().trim().min(1).max(64).optional(),
});

/**
 * "Import history" (the evaluator lab): several historical documents of one
 * patient at once, each with its own date, replayed chronologically by the
 * initial backfill. JSON (base64 files) or `multipart/form-data` (`files`
 * parts plus a `documents` JSON field with one `{ documentDate,
 * documentType, specialty? }` per file, in order).
 */
export const LabHistoryImportSchema = z
  .object({
    patientId: z.string().trim().min(1).max(64).optional(),
    newPatient: NewLabPatientSchema.optional(),
    documents: z.array(LabHistoryDocumentSchema).min(1).max(MAX_LAB_HISTORY_DOCUMENTS),
  })
  .refine((body) => body.patientId !== undefined || body.newPatient !== undefined, {
    params: { message: 'labPatientRequired' },
    path: ['patientId'],
  })
  .meta({ id: 'LabHistoryImport' });

const isoInstant = z.string().meta({ format: 'date-time' });

export const LabHistoryDocumentOutcomeSchema = z.object({
  index: z.number().int(),
  filename: z.string(),
  documentDate: calendarDay,
  documentType: z.enum(CONSULTATION_DOCUMENT_TYPES),
  readAs: z.enum(['note', 'lab_report']),
  source: z.enum(['photo', 'text']),
  status: z.enum(['staged', 'already_imported', 'no_results', 'unreadable']),
  error: z.string().optional(),
  results: z
    .array(
      z.object({
        test: z.string(),
        loinc: z.string(),
        value: z.number(),
        unit: z.string().optional(),
        interpretation: z.enum(['H', 'L', 'N']).optional(),
      }),
    )
    .optional(),
  unrecognizedTests: z.array(z.string()).optional(),
  resources: z.array(z.string()),
  reading: z
    .object({ model: z.string(), costUsd: z.number(), latencyMs: z.number() })
    .optional()
    .meta({ description: "The lab-result reading's model and cost, as the llm_gateway logged it" }),
});

export const LabHistoryImportResponseSchema = z
  .object({
    patientId: z.string(),
    clinicId: z.string(),
    documents: z.array(LabHistoryDocumentOutcomeSchema),
    eventsStaged: z.number().int(),
    backfill: z.object({
      runId: z.string(),
      status: z.string(),
      resumed: z.boolean(),
      expectationsCreated: z.number().int(),
      expectationsFulfilled: z.number().int(),
      casesOpened: z.number().int(),
      notesRead: z.number().int(),
      notesLlmCostUsd: z.number(),
      release: z
        .object({
          scheduled: z.number().int(),
          notNotified: z.number().int(),
          perDay: z.array(z.number().int()),
        })
        .optional(),
    }),
    /** Backfill cases of the patient: released today by the cap, or waiting among the patients to recover. */
    cases: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        releaseAt: isoInstant.optional(),
        released: z.boolean(),
      }),
    ),
    /** Every LLM call this import made, as the llm_gateway logged it. */
    llm: z.object({ calls: z.number().int(), costUsd: z.number() }),
  })
  .meta({ id: 'LabHistoryImportResponse' });

export const LabHistorySampleSetSchema = z
  .object({
    sets: z.array(
      z.object({
        id: z.string(),
        patient: z.object({
          name: z.string(),
          sex: z.enum(LAB_PATIENT_SEXES),
          age: z.number().int(),
        }),
        documents: z.array(LabHistoryDocumentSchema),
      }),
    ),
  })
  .meta({ id: 'LabHistorySampleSet' });

export type LabHistoryImport = z.infer<typeof LabHistoryImportSchema>;
export type LabHistoryImportResponse = z.infer<typeof LabHistoryImportResponseSchema>;
export type LabHistorySampleSet = z.infer<typeof LabHistorySampleSetSchema>;

export type LabPatientCreate = z.infer<typeof LabPatientCreateSchema>;
export type LabPatient = z.infer<typeof LabPatientSchema>;
export type LabDocumentUpload = z.infer<typeof LabDocumentUploadSchema>;
export type LabImpactQuery = z.infer<typeof LabImpactQuerySchema>;
