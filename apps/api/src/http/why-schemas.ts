import {
  ANCHOR_ROLES,
  DUE_BASES,
  ENROLLMENT_BASES,
  EXPECTATION_LAYERS,
  PLAN_ITEM_KINDS,
  PROTOCOL_STATUSES,
} from '@follow-up-engine/core';
import { z } from 'zod';

/*
 * "Why this?" (HIP-142): the evidence behind every reason of a case and
 * every expectation of a patient, recomputed from the stored record and the
 * clinic's catalog (`engine.explain`). Every document it cites is one of
 * the patient's own; every `text` is in the request's language; clinical
 * content (note text, quotes, the host's displays) is returned as written.
 */

const isoDate = z.string().meta({ format: 'date-time', example: '2026-01-21T12:00:00.000Z' });

export const WHY_DOCUMENT_KINDS = [
  'note',
  'order',
  'result',
  'prescription',
  'visit',
  'appointment',
  'diagnosis',
  'allergy',
  'other',
] as const;

export const DocumentRefViewSchema = z
  .object({
    resourceType: z.string().meta({ example: 'Observation' }),
    id: z.string(),
    kind: z.enum(WHY_DOCUMENT_KINDS),
    kindLabel: z.string().meta({ description: 'Localized: "Result"' }),
    at: isoDate.meta({
      description: 'When it happened clinically (a note: when it was written; a booking: its date)',
    }),
    title: z.string().meta({
      description: 'What it is: the test, the drug, the diagnosis ("Hemoglobin A1c (HbA1c)")',
    }),
    code: z.string().optional().meta({ description: 'Its code (LOINC, ICD-10, ATC), when coded' }),
    detail: z.string().optional().meta({
      description: 'Localized detail: a value and its interpretation, a dosage, a status',
    }),
    value: z.string().optional().meta({ description: 'Results: the value with its unit' }),
    interpretation: z.enum(['normal', 'abnormal', 'unknown', 'critical']).optional(),
    status: z.string().optional().meta({ description: "The host's FHIR status, as sent" }),
    specialty: z.string().optional().meta({ description: 'Specialty key, as the host sent it' }),
    author: z.string().optional().meta({ description: 'Notes: who wrote it, when the host says' }),
    documentId: z.string().optional().meta({ description: 'Notes: the document id' }),
    encounterId: z.string().optional(),
  })
  .meta({ id: 'DocumentRefView' });
export type DocumentRefView = z.infer<typeof DocumentRefViewSchema>;

export const PatientDocumentViewSchema = DocumentRefViewSchema.extend({
  text: z.string().optional().meta({ description: 'Notes: the full text, as written' }),
  withdrawn: z.boolean().optional().meta({
    description: 'The host withdrew it later (entered in error, revoked, replaced)',
  }),
}).meta({ id: 'PatientDocumentView' });
export type PatientDocumentView = z.infer<typeof PatientDocumentViewSchema>;

export const PatientDocumentListSchema = z
  .object({ items: z.array(PatientDocumentViewSchema) })
  .meta({ id: 'PatientDocumentList' });

const CodingViewSchema = z.object({
  system: z.string(),
  code: z.string(),
  display: z.string().optional(),
});

export const ReasonWhyViewSchema = z
  .object({
    layer: z.enum(EXPECTATION_LAYERS),
    due: z
      .object({
        basis: z.enum(DUE_BASES),
        anchorRole: z.enum(ANCHOR_ROLES),
        anchor: DocumentRefViewSchema.optional().meta({
          description: 'The record the due date counts from',
        }),
        anchorAt: isoDate.optional(),
        days: z.number().int().optional().meta({
          description: 'Days from anchorAt to dueAt, the interval the engine applied',
        }),
        configuredDays: z.number().int().optional().meta({
          description: 'The interval the rule or protocol states, when it is one number',
        }),
        treatmentDays: z.number().int().optional(),
        bookingToleranceDays: z.number().int().optional().meta({
          description: 'A booking up to this many days after dueAt still fulfills it',
        }),
        dueAt: isoDate,
        text: z.string().meta({
          description: 'Localized: "Due Jan 21, 2026 = last time done (Jun 10, 2025) + 90 days"',
        }),
        basisText: z.string().meta({ description: 'Localized: how the interval was chosen' }),
        toleranceText: z.string().optional(),
        tooEarly: DocumentRefViewSchema.optional().meta({
          description:
            'treatment_change: done too soon after the change to count as its control (the control stays due)',
        }),
        tooEarlyText: z.string().optional(),
      })
      .meta({ description: 'How the due date was computed' }),
    fulfilledBy: z
      .object({
        expects: z.enum(PLAN_ITEM_KINDS),
        code: CodingViewSchema.optional(),
        equivalentCodes: z.array(z.string()),
        orderId: z.string().optional(),
        events: z.array(z.string()).meta({ description: 'Clinical event types that fulfill it' }),
        specialties: z.array(z.string()),
        text: z.string().meta({ description: 'Localized: what would fulfill it' }),
      })
      .meta({ description: 'What would fulfill it' }),
    closedBy: DocumentRefViewSchema.optional().meta({
      description: 'The record that closed it (the result, the visit, the booking)',
    }),
    plan: z
      .object({
        documentId: z.string(),
        quote: z.string().meta({ description: 'The verbatim quote, as written' }),
        authoredAt: isoDate.optional(),
        author: z.string().optional(),
        specialty: z.string().optional(),
        noteExcerpt: z.string().optional(),
        itemDescription: z.string().optional().meta({
          description: 'What the AI read (short English description from the extractor)',
        }),
        note: DocumentRefViewSchema.optional(),
      })
      .optional()
      .meta({ description: "doctor_plan: the note and the doctor's words" }),
    protocol: z
      .object({
        id: z.string(),
        name: z.string().optional(),
        version: z.string().meta({ description: 'Version that created the expectation' }),
        currentVersion: z.string().optional(),
        status: z.enum(PROTOCOL_STATUSES).optional(),
        statusText: z.string().optional(),
        title: z.string().meta({ description: 'Localized: "Diabetes follow-up v1.2.1"' }),
        itemKey: z.string().optional(),
        scheduleText: z.string().optional().meta({
          description: "Localized: the item's interval as the protocol states it",
        }),
        enrollment: z.object({
          episode: z.enum(['active', 'ended', 'not_enrolled']),
          basis: z.enum(ENROLLMENT_BASES).optional(),
          condition: z
            .object({
              code: z.string(),
              display: z.string(),
              status: z.string(),
              sourceType: z.string(),
              quote: z.string().optional(),
            })
            .optional(),
          evidence: z.array(DocumentRefViewSchema).meta({
            description:
              'The records that enroll the patient: the coded diagnosis, the prescription, every result past the threshold',
          }),
          threshold: z
            .object({
              code: CodingViewSchema,
              gte: z.number().optional(),
              lt: z.number().optional(),
              confirm: z
                .object({ count: z.number().int(), minDaysApart: z.number().int() })
                .optional(),
            })
            .optional(),
          activeTreatment: DocumentRefViewSchema.optional(),
          endedBy: DocumentRefViewSchema.optional(),
          text: z.string().meta({ description: 'Localized: why the patient is in the protocol' }),
          activeTreatmentText: z.string().optional(),
        }),
        ckdStage: z
          .object({ gfr: z.string().optional(), albuminuria: z.string().optional() })
          .optional(),
        gestationalWeeks: z.number().int().optional(),
      })
      .optional()
      .meta({ description: 'protocol: the protocol, its schedule and the enrollment' }),
    cadence: z
      .object({
        specialty: z.string().optional(),
        visits: z.array(
          z.object({
            at: isoDate,
            encounterId: z.string(),
            inPattern: z.boolean().meta({
              description: 'False for visits of closed episodes, which are not a pattern',
            }),
          }),
        ),
        usualIntervalDays: z.number().optional(),
        multiplier: z.number().optional(),
        expectedBy: isoDate,
        text: z.string(),
      })
      .optional()
      .meta({ description: 'cadence: the visit history that forms the pattern' }),
  })
  .meta({ id: 'ReasonWhyView' });
export type ReasonWhyView = z.infer<typeof ReasonWhyViewSchema>;
