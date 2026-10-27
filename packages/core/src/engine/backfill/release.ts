import { isUnscheduledRelease } from '../../domain/backfill.ts';
import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { CaseListQuery } from '../../ports/case-repository.ts';
import type { ClinicDirectory, ClinicSettings } from '../../ports/clinic-directory.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import type { Catalog } from '../catalog.ts';
import { caseExpectations, policyOf } from '../escalation/schedule.ts';
import type { EngineSettings } from '../settings.ts';
import { addDays, daysBetween } from '../support/time.ts';

/** Settings the release plan falls back to when the clinic has none (PRD defaults). */
export const BACKFILL_RELEASE_DEFAULTS = {
  dailyCaseCapPerOwner: 20,
  backfillNotifyMaxAgeDays: 730,
} as const satisfies Pick<ClinicSettings, 'dailyCaseCapPerOwner' | 'backfillNotifyMaxAgeDays'>;

const RELEASE_ACTOR: CaseEventActor = { type: 'system', id: 'backfill' };
const PAGE_SIZE = 200;

/** Every case matching `query`, across pages. */
export async function listCases(
  stores: TransactionalStores,
  clinicId: ClinicId,
  query: Omit<CaseListQuery, 'limit' | 'cursor'>,
): Promise<FollowUpCase[]> {
  const cases: FollowUpCase[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.cases.list(clinicId, {
      ...query,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    cases.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return cases;
}

/** When a case opened for `expectation` takes its first escalation step. */
export function firstActionAt(catalog: Catalog, expectation: Expectation, now: Date): Date {
  return addDays(
    now,
    catalog.definition(expectation.ruleId)?.escalationPolicy.steps[0]?.afterDays ?? 0,
  );
}

/**
 * Makes a held backfill case visible and actionable now: release date set,
 * escalation started, `released` audited and `case.opened` emitted (the host
 * hears about a backfill case when the team does).
 */
export async function releaseCase(
  writer: CaseWriter,
  catalog: Catalog,
  followUpCase: FollowUpCase,
  reasons: readonly Expectation[],
  now: Date,
): Promise<FollowUpCase> {
  const policy = policyOf(catalog, reasons, followUpCase);
  const released = await writer.update(
    {
      ...followUpCase,
      releaseAt: now,
      nextActionAt: addDays(now, policy.steps[0]?.afterDays ?? 0),
      updatedAt: now,
    },
    { type: 'released', actor: RELEASE_ACTOR, payload: { releasedAt: now.toISOString() } },
  );
  await writer.emit('case.opened', now, {
    caseId: released.id,
    patientId: released.patientId,
    reasons: reasons.map((expectation) => expectation.reason),
    priority: released.priority,
    origin: released.origin,
  });
  return released;
}

export interface ReleaseDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
}

/**
 * Activates the backfill cases whose release day came (`releaseAt <= now`,
 * still waiting: open and not escalating yet). Run by every watcher sweep,
 * so each day's batch shows up on its own.
 *
 * @returns the ids of the cases released.
 */
export async function releaseDueBackfillCases(
  deps: ReleaseDeps,
  clinicId: ClinicId,
  now: Date,
  catalog: Catalog,
): Promise<CaseId[]> {
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const due = (
      await listCases(stores, clinicId, {
        origin: 'backfill',
        statuses: ['open'],
        releasedAsOf: now,
      })
    ).filter(
      (followUpCase) =>
        followUpCase.releaseAt !== undefined && followUpCase.nextActionAt === undefined,
    );
    const writer = new CaseWriter(stores, deps.ids, clinicId);
    for (const followUpCase of due) {
      const reasons = await caseExpectations(stores, clinicId, followUpCase);
      await releaseCase(writer, catalog, followUpCase, reasons, now);
    }
    return due.map((followUpCase) => followUpCase.id);
  });
}

/** What a release plan decided. */
export interface BackfillReleasePlan {
  /** Cases given a release day. */
  readonly scheduled: number;
  /** Cases too old to notify: they stay among the patients to recover. */
  readonly notNotified: number;
  /** Cases per day offset from now (`[0]` is released today). */
  readonly perDay: readonly number[];
}

export interface PlanReleaseDeps {
  readonly unitOfWork: UnitOfWork;
  readonly clinics: ClinicDirectory;
  readonly settings: EngineSettings;
}

interface Candidate {
  readonly followUpCase: FollowUpCase;
  /** Days since the oldest unmet reason was due. */
  readonly overdueDays: number;
}

function byRisk(left: Candidate, right: Candidate): number {
  return (
    right.followUpCase.priority - left.followUpCase.priority ||
    right.overdueDays - left.overdueDays ||
    left.followUpCase.id.localeCompare(right.followUpCase.id)
  );
}

/**
 * Schedules the held backfill cases of a clinic for release, so turning the
 * engine on produces a digestible list instead of a flood:
 * - risk first: the case priority (chronic condition, pending results, rule
 *   weight), then the longest overdue;
 * - at most `dailyCaseCapPerOwner` releases per owner per day (day 0 is now),
 *   counting what earlier plans already scheduled;
 * - cases whose most recent reason is overdue by more than
 *   `backfillNotifyMaxAgeDays` are never released: they stay listed among the
 *   patients to recover and never notify anyone.
 *
 * Idempotent: only cases still unscheduled are planned.
 */
export async function planBackfillRelease(
  deps: PlanReleaseDeps,
  clinicId: ClinicId,
  now: Date,
): Promise<BackfillReleasePlan> {
  const clinic = await deps.clinics.get(clinicId);
  const cap = Math.max(
    1,
    clinic?.settings.dailyCaseCapPerOwner ?? BACKFILL_RELEASE_DEFAULTS.dailyCaseCapPerOwner,
  );
  const maxAgeDays =
    clinic?.settings.backfillNotifyMaxAgeDays ?? BACKFILL_RELEASE_DEFAULTS.backfillNotifyMaxAgeDays;
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const waiting = await listCases(stores, clinicId, {
      origin: 'backfill',
      statuses: ['open'],
      unreleasedAsOf: now,
    });
    const load = new Map<string, number[]>();
    const ownerOf = (followUpCase: FollowUpCase) =>
      followUpCase.assignee ?? deps.settings.frontDeskOwner;
    for (const followUpCase of waiting) {
      if (followUpCase.releaseAt !== undefined && !isUnscheduledRelease(followUpCase.releaseAt)) {
        const day = Math.max(0, daysBetween(now, followUpCase.releaseAt));
        const days = load.get(ownerOf(followUpCase)) ?? [];
        days[day] = (days[day] ?? 0) + 1;
        load.set(ownerOf(followUpCase), days);
      }
    }
    const candidates: Candidate[] = [];
    let notNotified = 0;
    for (const followUpCase of waiting.filter((item) => isUnscheduledRelease(item.releaseAt))) {
      const reasons = await caseExpectations(stores, clinicId, followUpCase);
      const dues = reasons.map((expectation) => expectation.dueAt.getTime());
      const newest = dues.length === 0 ? now.getTime() : Math.max(...dues);
      const oldest = dues.length === 0 ? now.getTime() : Math.min(...dues);
      if (daysBetween(new Date(newest), now) > maxAgeDays) {
        notNotified += 1;
        continue;
      }
      candidates.push({ followUpCase, overdueDays: daysBetween(new Date(oldest), now) });
    }
    const perDay: number[] = [];
    for (const { followUpCase } of candidates.sort(byRisk)) {
      const days = load.get(ownerOf(followUpCase)) ?? [];
      let day = 0;
      while ((days[day] ?? 0) >= cap) {
        day += 1;
      }
      days[day] = (days[day] ?? 0) + 1;
      load.set(ownerOf(followUpCase), days);
      perDay[day] = (perDay[day] ?? 0) + 1;
      await stores.cases.update(clinicId, {
        ...followUpCase,
        releaseAt: addDays(now, day),
        updatedAt: now,
      });
    }
    return {
      scheduled: candidates.length,
      notNotified,
      perDay: Array.from({ length: perDay.length }, (_, day) => perDay[day] ?? 0),
    };
  });
}
