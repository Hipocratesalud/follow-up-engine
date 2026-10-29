import { z } from 'zod';
import { CONSULTATION_DOCUMENT_TYPES } from '@follow-up-engine/fhir';
import { calendarDay, LabRecordEntrySchema } from './lab-schemas.ts';

export const ENGINE_TEST_VERDICTS = ['works_as_expected', 'does_not_work'] as const;
export type EngineTestVerdict = (typeof ENGINE_TEST_VERDICTS)[number];

/**
 * A physician's verdict on one guided engine test (docs/deploy.md#engine-tests):
 * their own read of the card, independent of the automatic check.
 */
export const EngineTestVerdictSchema = z
  .object({
    verdict: z.enum(ENGINE_TEST_VERDICTS),
    comment: z.string().trim().max(2_000).optional(),
    /** What the run's own automatic check found, echoed back for the audit trail. */
    autoCheckPassed: z.boolean(),
    /** The patient the run created, when the verdict follows a run (always, in practice). */
    patientId: z.string().trim().min(1).max(64).optional(),
  })
  .meta({ id: 'EngineTestVerdict' });

export type EngineTestVerdictInput = z.infer<typeof EngineTestVerdictSchema>;

// -------------------------------------------------------------- step values

/** ~2 MB of base64 (4/3 overhead plus headroom) — the same ceiling the lab's own upload uses. */
const MAX_BASE64_LENGTH = 2_900_000;

const EngineTestDiagnosisSchema = z.object({
  icd10: z.string().trim().min(1).max(20),
  display: z.string().trim().min(1).max(200).optional(),
  verification: z.enum(['confirmed', 'provisional']).optional(),
});

/** One "Add to the record" action: a lab/imaging order, a result, a prescription, a visit, a diagnosis or an appointment. */
export const RecordStepValueSchema = z
  .object({
    action: z.literal('record'),
    recordDate: calendarDay,
    entry: LabRecordEntrySchema,
  })
  .meta({ id: 'EngineTestRecordStepValue' });

/** "Upload a report or paste a note": the same document form the Lab page uses. */
export const DocumentStepValueSchema = z
  .object({
    action: z.literal('document'),
    documentDate: calendarDay,
    documentType: z.enum(CONSULTATION_DOCUMENT_TYPES),
    specialty: z.string().trim().min(1).max(64).optional(),
    /** Pasted text, as an alternative to a file. */
    text: z.string().trim().min(1).max(50_000).optional(),
    file: z
      .object({
        filename: z.string().trim().min(1).max(200),
        contentType: z.string().trim().min(1).max(100),
        dataBase64: z.string().min(1).max(MAX_BASE64_LENGTH),
      })
      .optional(),
    /** Attached to the same note, when the step enrolls the patient in a protocol. */
    diagnoses: z.array(EngineTestDiagnosisSchema).max(5).optional(),
  })
  .refine((body) => body.text !== undefined || body.file !== undefined, {
    params: { message: 'labDocumentRequired' },
    path: ['text'],
  })
  .meta({ id: 'EngineTestDocumentStepValue' });

/** "Move your lab's date to …": the same clock the Lab page's "see the impact on a date" moves. */
export const ClockStepValueSchema = z
  .object({ action: z.literal('clock'), targetDate: calendarDay })
  .meta({ id: 'EngineTestClockStepValue' });

/** The per-clinic timeframe step: a new `dueInDays` for the scenario's own rule. */
export const RuleTimeframeStepValueSchema = z
  .object({ action: z.literal('rule_timeframe'), dueInDays: z.number().int().min(1).max(365) })
  .meta({ id: 'EngineTestRuleTimeframeStepValue' });

/** The doctor confirms a plan item read from a note: no fields, one action. */
export const ConfirmPlanStepValueSchema = z
  .object({ action: z.literal('confirm_plan') })
  .meta({ id: 'EngineTestConfirmPlanStepValue' });

/** Reads the scenario's rule card: no fields, read-only. */
export const RuleCardStepValueSchema = z
  .object({ action: z.literal('rule_card') })
  .meta({ id: 'EngineTestRuleCardStepValue' });

export const EngineTestStepValueSchema = z.discriminatedUnion('action', [
  RecordStepValueSchema,
  DocumentStepValueSchema,
  ClockStepValueSchema,
  RuleTimeframeStepValueSchema,
  ConfirmPlanStepValueSchema,
  RuleCardStepValueSchema,
]);

export type EngineTestStepAction = EngineTestStepValue['action'];
export type RecordStepValue = z.infer<typeof RecordStepValueSchema>;
export type DocumentStepValue = z.infer<typeof DocumentStepValueSchema>;
export type ClockStepValue = z.infer<typeof ClockStepValueSchema>;
export type RuleTimeframeStepValue = z.infer<typeof RuleTimeframeStepValueSchema>;
export type ConfirmPlanStepValue = z.infer<typeof ConfirmPlanStepValueSchema>;
export type RuleCardStepValue = z.infer<typeof RuleCardStepValueSchema>;
export type EngineTestStepValue = z.infer<typeof EngineTestStepValueSchema>;

/** `POST /api/demo/engine-tests/:id/steps/:n`: the scenario's own start date, the patient it is running on, and this step's (possibly edited) input. */
export const EngineTestStepRequestSchema = z
  .object({
    day0: z.string().trim().min(1).max(40),
    patientId: z.string().trim().min(1).max(64),
    value: EngineTestStepValueSchema,
  })
  .meta({ id: 'EngineTestStepRequest' });

export type EngineTestStepRequest = z.infer<typeof EngineTestStepRequestSchema>;

/** "Try anything else": the optional free-form step, any record or document action. */
export const EngineTestFreeformValueSchema = z.union([
  RecordStepValueSchema,
  DocumentStepValueSchema,
]);

export const EngineTestFreeformRequestSchema = z
  .object({
    patientId: z.string().trim().min(1).max(64),
    value: EngineTestFreeformValueSchema,
  })
  .meta({ id: 'EngineTestFreeformRequest' });

export type EngineTestFreeformRequest = z.infer<typeof EngineTestFreeformRequestSchema>;
