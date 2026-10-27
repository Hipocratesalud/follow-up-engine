import type { AppointmentOriginType } from '../../domain/attribution.ts';
import type { CaseEventActor, CaseResolutionKind, FollowUpCase } from '../../domain/case.ts';
import type { Expectation, ExpectationStatus } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { withoutKey, type CaseWriter } from './case-writer.ts';
import { isActiveCaseStatus } from './state-machine.ts';

/** A booking of the batch being applied: its origin and the case it is attributed to. */
export interface BookingOrigin {
  readonly type: AppointmentOriginType;
  readonly caseId?: CaseId;
}

export type ClosingStatus = Extract<ExpectationStatus, 'fulfilled' | 'superseded' | 'cancelled'>;

/**
 * Closes an open or expired expectation with a machine-readable reason (and
 * what closed it). `recheckAt`: fulfilled by a booking, when to check the
 * visit took place.
 */
export async function closeExpectation(
  stores: TransactionalStores,
  expectation: Expectation,
  status: ClosingStatus,
  closedReason: string,
  now: Date,
  closedBy?: ResourceRef,
  recheckAt?: Date,
): Promise<Expectation> {
  const closed: { -readonly [K in keyof Expectation]: Expectation[K] } = {
    ...expectation,
    status,
    closedReason,
    closedAt: now,
    ...(closedBy === undefined ? {} : { closedBy }),
    updatedAt: now,
  };
  if (recheckAt === undefined) {
    delete closed.recheckAt;
  } else {
    closed.recheckAt = recheckAt;
  }
  await stores.expectations.update(expectation.clinicId, closed);
  return closed;
}

/**
 * An expectation open again: what closed it no longer stands (a booking
 * cancelled, rescheduled or not kept, a visit or result withdrawn). Out of
 * its former case; if already due, the next watcher run expires it again.
 */
export function reopened(expectation: Expectation, now: Date): Expectation {
  const open: { -readonly [K in keyof Expectation]: Expectation[K] } = {
    ...expectation,
    status: 'open',
    updatedAt: now,
  };
  delete open.closedAt;
  delete open.closedReason;
  delete open.closedBy;
  delete open.caseId;
  delete open.recheckAt;
  return open;
}

function resolutionKind(reasons: readonly Expectation[]): CaseResolutionKind {
  return reasons.some((expectation) => expectation.status === 'fulfilled')
    ? 'fulfilled'
    : 'not_needed';
}

/**
 * Resolves the active cases whose every reason has closed (fulfilled late,
 * superseded or cancelled). A case with at least one reason still unmet stays
 * open. Emits `case.resolved` for each case it resolves.
 *
 * @returns the ids of the cases it resolved.
 */
export async function resolveSatisfiedCases(input: {
  readonly stores: TransactionalStores;
  readonly writer: CaseWriter;
  readonly clinicId: ClinicId;
  readonly caseIds: Iterable<CaseId>;
  readonly actor: CaseEventActor;
  readonly now: Date;
  /**
   * The batch's bookings by appointment (`Appointment/<id>`): a case a
   * booking resolves records it (`appointmentId`, `appointmentOrigin`), an
   * unattributed one as `organic` (HIP-141).
   */
  readonly bookingOrigins?: ReadonlyMap<string, BookingOrigin>;
}): Promise<CaseId[]> {
  const resolved: CaseId[] = [];
  for (const caseId of new Set(input.caseIds)) {
    const followUpCase = await input.stores.cases.get(input.clinicId, caseId, { forUpdate: true });
    if (followUpCase === undefined || !isActiveCaseStatus(followUpCase.status)) {
      continue;
    }
    const reasons: Expectation[] = [];
    for (const reason of followUpCase.reasons) {
      const expectation = await input.stores.expectations.get(input.clinicId, reason.expectationId);
      if (expectation !== undefined) {
        reasons.push(expectation);
      }
    }
    if (
      reasons.some(
        (expectation) => expectation.status === 'open' || expectation.status === 'expired',
      )
    ) {
      continue;
    }
    await resolveCase(input.writer, followUpCase, {
      kind: resolutionKind(reasons),
      actor: input.actor,
      now: input.now,
      payload: {
        closedReasons: reasons.map((expectation) => expectation.closedReason ?? expectation.status),
        ...resolvingBooking(followUpCase.id, reasons, input.bookingOrigins),
      },
    });
    resolved.push(caseId);
  }
  return resolved;
}

/**
 * The booking of the batch that fulfilled one of the case's reasons, with
 * its origin as far as this case goes (attributed to another case: organic).
 */
function resolvingBooking(
  caseId: CaseId,
  reasons: readonly Expectation[],
  bookingOrigins: ReadonlyMap<string, BookingOrigin> | undefined,
): Record<string, string> {
  if (bookingOrigins === undefined) {
    return {};
  }
  for (const expectation of reasons) {
    const closedBy = expectation.closedBy;
    if (expectation.status !== 'fulfilled' || closedBy?.resourceType !== 'Appointment') {
      continue;
    }
    const origin = bookingOrigins.get(`${closedBy.resourceType}/${closedBy.id}`);
    if (origin !== undefined) {
      return {
        appointmentId: closedBy.id,
        appointmentOrigin: origin.caseId === caseId ? origin.type : 'organic',
      };
    }
  }
  return {};
}

/** Moves a case to `resolved` and emits `case.resolved`. */
export async function resolveCase(
  writer: CaseWriter,
  followUpCase: FollowUpCase,
  input: {
    readonly kind: CaseResolutionKind;
    readonly actor: CaseEventActor;
    readonly now: Date;
    readonly note?: string;
    readonly payload?: Readonly<Record<string, string | readonly string[]>>;
  },
): Promise<FollowUpCase> {
  const base = withoutKey(followUpCase, 'nextActionAt');
  const resolvedBy = input.actor.type === 'user' ? input.actor.id : undefined;
  const next = await writer.transition(base, {
    to: 'resolved',
    type: 'resolved',
    actor: input.actor,
    at: input.now,
    payload: { kind: input.kind, ...input.payload },
    patch: {
      resolution: {
        kind: input.kind,
        resolvedAt: input.now,
        ...(resolvedBy === undefined ? {} : { resolvedBy }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    },
  });
  await writer.emit('case.resolved', input.now, {
    caseId: next.id,
    patientId: next.patientId,
    resolution: input.kind,
  });
  return next;
}
