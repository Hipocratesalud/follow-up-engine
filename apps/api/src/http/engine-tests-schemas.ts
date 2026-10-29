import { z } from 'zod';

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
