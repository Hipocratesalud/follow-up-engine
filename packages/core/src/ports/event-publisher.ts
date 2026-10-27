import type { DomainEvent } from '../domain/domain-event.ts';
import type { ClinicId } from '../domain/ids.ts';

/**
 * Delivers an outbound event to the host (signed webhook in production,
 * memory in tests). Called by the worker for each outbox entry; throwing
 * makes the worker retry, so delivery is at least once and the host
 * deduplicates on `event.id`.
 */
export interface EventPublisher {
  /** `event.clinicId` must equal `clinicId`. */
  publish(clinicId: ClinicId, event: DomainEvent): Promise<void>;
}
