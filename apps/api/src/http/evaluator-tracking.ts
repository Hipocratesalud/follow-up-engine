import type { ClinicId, PatientId } from '@follow-up-engine/core';
import type { EngineRuntime, EvaluatorAction } from '@follow-up-engine/runtime';

/**
 * Appends one row to the evaluator lab's action log (docs/deploy.md#hosted-demo,
 * migration 0016). Best effort: a tracking failure never fails the
 * evaluator's actual request, it is only logged.
 */
export async function trackEvaluatorEvent(
  runtime: EngineRuntime,
  event: {
    readonly clinicId: ClinicId;
    readonly evaluatorEmail: string;
    readonly action: EvaluatorAction;
    readonly entityType?: string;
    readonly entityId?: string;
    readonly patientId?: PatientId;
    readonly payload?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await runtime.storage.evaluatorEvents.record({
      ...event,
      simulatedAt: runtime.clock.now(),
      occurredAt: new Date(),
    });
  } catch (error) {
    runtime.logger.warn(
      { error: error instanceof Error ? error.message : String(error), action: event.action },
      'evaluator event not recorded',
    );
  }
}
