/** A referenced entity does not exist in the clinic. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.entity = entity;
    this.id = id;
  }
}

/** A write violates a uniqueness invariant (for example a second active case for a dedup key). */
export class ConflictError extends Error {
  override readonly name = 'ConflictError';
  readonly entity: string;
  readonly key: string;

  constructor(entity: string, key: string) {
    super(`${entity} conflict on ${key}`);
    this.entity = entity;
    this.key = key;
  }
}

/** An entity's `clinicId` does not match the clinic the call is scoped to. */
export class TenantMismatchError extends Error {
  override readonly name = 'TenantMismatchError';

  constructor() {
    super('Entity clinicId does not match the clinicId of the call');
  }
}

/** A case cannot move from its current status to the requested one. */
export class InvalidCaseTransitionError extends Error {
  override readonly name = 'InvalidCaseTransitionError';
  readonly caseId: string;
  readonly from: string;
  readonly to: string;

  constructor(caseId: string, from: string, to: string) {
    super(`Case ${caseId} cannot move from ${from} to ${to}`);
    this.caseId = caseId;
    this.from = from;
    this.to = to;
  }
}

/** A command was rejected because its input breaks a business rule (for example feedback without a reason). */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * A list cursor that the repository did not produce for the same query
 * (garbage, tampered with, or taken from another ordering).
 */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';

  constructor() {
    super('Invalid case list cursor');
  }
}
