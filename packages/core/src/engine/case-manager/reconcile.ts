import type { CaseEventActor, CaseResolutionKind, FollowUpCase } from '../../domain/case.ts';
import type { Expectation, ExpectationStatus } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { ResourceRef } from '../../domain/resource.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import { withoutKey, type CaseWriter } from './case-writer.ts';
import { isActiveCaseStatus } from './state-machine.ts';

export type ClosingStatus = Extract<ExpectationStatus, 'fulfilled' | 'superseded' | 'cancelled'>;

/** Closes an open or expired expectation with a machine-readable reason (and what closed it). */
export async function closeExpectation(
  stores: TransactionalStores,
  expectation: Expectation,
  status: ClosingStatus,
  closedReason: string,
  now: Date,
  closedBy?: ResourceRef,
): Promise<Expectation> {
  const closed: Expectation = {
    ...expectation,
    status,
    closedReason,
    closedAt: now,
    ...(closedBy === undefined ? {} : { closedBy }),
    updatedAt: now,
  };
  await stores.expectations.update(expectation.clinicId, closed);
  return closed;
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
}): Promise<CaseId[]> {
  const resolved: CaseId[] = [];
  for (const caseId of new Set(input.caseIds)) {
    const followUpCase = await input.stores.cases.get(input.clinicId, caseId);
    if (followUpCase === undefined || !isActiveCaseStatus(followUpCase.status)) {
      continue;
    }
    const reasons = (
      await Promise.all(
        followUpCase.reasons.map((reason) =>
          input.stores.expectations.get(input.clinicId, reason.expectationId),
        ),
      )
    ).filter((expectation): expectation is Expectation => expectation !== undefined);
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
      },
    });
    resolved.push(caseId);
  }
  return resolved;
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
