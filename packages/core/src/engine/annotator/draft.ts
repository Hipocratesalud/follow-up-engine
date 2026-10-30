import type { Evidence, Origin } from '../../domain/common.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, ExpectationId, PatientId } from '../../domain/ids.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import { refKey } from '../timeline.ts';

/** An expectation a layer wants to create, before ids and timestamps. */
export interface ExpectationDraft {
  readonly definition: ExpectationDefinition;
  readonly source: ResourceRef;
  readonly matchKey: string;
  readonly dueAt: Date;
  readonly idempotencyKey: string;
  readonly evidence?: Evidence;
  /** `doctor_plan`: the extractor's confidence in the plan item. */
  readonly confidence?: number;
  /** `critical`: triggered by a panic result. */
  readonly severity?: 'critical';
}

/**
 * `<resourceType>/<id>#<ruleId>[#<discriminator>]`: source type + source id +
 * rule id, so reprocessing the same data never creates a second expectation.
 */
export function expectationIdempotencyKey(
  source: ResourceRef,
  ruleId: string,
  discriminator?: string,
): string {
  const base = `${refKey(source)}#${ruleId}`;
  return discriminator === undefined ? base : `${base}#${discriminator}`;
}

/**
 * The idempotency key of an expectation created for `patientId` when the
 * resource that triggers it was first sent for another patient (its subject
 * was corrected since): the original key belongs to that patient's
 * withdrawn expectation.
 */
export function movedIdempotencyKey(idempotencyKey: string, patientId: string): string {
  return `${idempotencyKey}@${patientId}`;
}

export interface MaterializeContext {
  readonly id: ExpectationId;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly now: Date;
  readonly origin: Origin;
}

export function materializeExpectation(
  draft: ExpectationDraft,
  context: MaterializeContext,
): Expectation {
  const { definition } = draft;
  return {
    id: context.id,
    clinicId: context.clinicId,
    patientId: context.patientId,
    idempotencyKey: draft.idempotencyKey,
    ruleId: definition.ruleId,
    ruleVersion: definition.version,
    layer: definition.layer,
    source: draft.source,
    matchKey: draft.matchKey,
    dueAt: draft.dueAt,
    status: 'open',
    origin: context.origin,
    ...(definition.protocol === undefined
      ? {}
      : { protocolId: definition.protocol.id, protocolVersion: definition.protocol.version }),
    reason: definition.reason,
    ...(draft.evidence === undefined ? {} : { evidence: draft.evidence }),
    ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
    ...(draft.severity === undefined ? {} : { severity: draft.severity }),
    createdAt: context.now,
    updatedAt: context.now,
  };
}
