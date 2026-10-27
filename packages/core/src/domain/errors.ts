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
