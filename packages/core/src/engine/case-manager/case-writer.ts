import type { CaseEventActor, CaseEventType, CaseStatus, FollowUpCase } from '../../domain/case.ts';
import type { DomainEvent, DomainEventOf, DomainEventType } from '../../domain/domain-event.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import type { JsonObject } from '../../shared/json.ts';
import { assertCaseTransition } from './state-machine.ts';

/** Writes cases together with their audit trail and outbound events, inside one transaction. */
export class CaseWriter {
  readonly #stores: TransactionalStores;
  readonly #ids: IdGenerator;
  readonly #clinicId: ClinicId;

  constructor(stores: TransactionalStores, ids: IdGenerator, clinicId: ClinicId) {
    this.#stores = stores;
    this.#ids = ids;
    this.#clinicId = clinicId;
  }

  async audit(
    followUpCase: FollowUpCase,
    type: CaseEventType,
    actor: CaseEventActor,
    at: Date,
    payload: JsonObject = {},
  ): Promise<void> {
    await this.#stores.audit.append(this.#clinicId, {
      clinicId: this.#clinicId,
      caseId: followUpCase.id,
      type,
      actor,
      payload,
      at,
    });
  }

  async create(
    followUpCase: FollowUpCase,
    actor: CaseEventActor,
    payload: JsonObject,
  ): Promise<void> {
    await this.#stores.cases.create(this.#clinicId, followUpCase);
    await this.audit(followUpCase, 'opened', actor, followUpCase.createdAt, payload);
  }

  /** Saves a change that keeps the status (new reason, priority, assignee). */
  async update(
    next: FollowUpCase,
    event: {
      readonly type: CaseEventType;
      readonly actor: CaseEventActor;
      readonly payload?: JsonObject;
    },
  ): Promise<FollowUpCase> {
    await this.#stores.cases.update(this.#clinicId, next);
    await this.audit(next, event.type, event.actor, next.updatedAt, event.payload);
    return next;
  }

  /**
   * Moves a case to `to`, validated against the state machine, and audits it.
   *
   * @throws {InvalidCaseTransitionError}
   */
  async transition(
    current: FollowUpCase,
    input: {
      readonly to: CaseStatus;
      readonly type: CaseEventType;
      readonly actor: CaseEventActor;
      readonly at: Date;
      readonly payload?: JsonObject;
      readonly patch?: Partial<Omit<FollowUpCase, 'id' | 'clinicId' | 'patientId' | 'status'>>;
    },
  ): Promise<FollowUpCase> {
    assertCaseTransition(current.id, current.status, input.to);
    const next: FollowUpCase = {
      ...current,
      ...input.patch,
      status: input.to,
      updatedAt: input.at,
    };
    return this.update(next, {
      type: input.type,
      actor: input.actor,
      payload: { from: current.status, to: input.to, ...input.payload },
    });
  }

  /** Adds an outbound event to the transactional outbox. */
  async emit<TType extends DomainEventType>(
    type: TType,
    at: Date,
    payload: DomainEventOf<TType>['payload'],
  ): Promise<void> {
    const event = {
      id: this.#ids.next('domain_event'),
      type,
      clinicId: this.#clinicId,
      occurredAt: at,
      payload,
    } as DomainEvent;
    await this.#stores.outbox.add(this.#clinicId, event);
  }
}

/** Drops an optional date from a case (exactOptionalPropertyTypes forbids assigning `undefined`). */
export function withoutKey(
  followUpCase: FollowUpCase,
  key: 'nextActionAt' | 'snoozedUntil',
): FollowUpCase {
  const copy: { -readonly [K in keyof FollowUpCase]: FollowUpCase[K] } = { ...followUpCase };
  if (key === 'nextActionAt') {
    delete copy.nextActionAt;
  } else {
    delete copy.snoozedUntil;
  }
  return copy;
}
