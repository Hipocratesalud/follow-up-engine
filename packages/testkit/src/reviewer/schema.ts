import { z } from 'zod';

/** What the reviewer is expected to find in a cohort patient (the eval's ground truth). */
export const ExpectedFindingSchema = z.strictObject({
  category: z.string().min(1),
  /** Detector rule that should produce it (`lab_trend:creatinine`). */
  rule: z.string().min(1),
  /** One line, English: what was planted. */
  description: z.string().min(1),
});
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

const IsoInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);

export const ReviewerCohortPatientSchema = z.strictObject({
  clinicId: z.string(),
  patientId: z.string(),
  name: z.string(),
  gender: z.enum(['female', 'male']),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** `planted`: a deliberate signal; `control`: a similar record with none. */
  kind: z.enum(['planted', 'control']),
  /** What was planted, in a few words. */
  story: z.string(),
  expected: z.array(ExpectedFindingSchema),
  entries: z.array(
    z.strictObject({
      at: IsoInstant,
      kind: z.enum(['consultation', 'result', 'appointment_booked']),
      bundle: z.looseObject({ resourceType: z.literal('Bundle') }),
    }),
  ),
});
export type ReviewerCohortPatient = z.infer<typeof ReviewerCohortPatientSchema>;

export interface ReviewerCohort {
  readonly patients: readonly ReviewerCohortPatient[];
}
