import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import { BACKFILL_UNSCHEDULED_RELEASE_AT } from '../../domain/backfill.ts';
import type { Origin } from '../../domain/common.ts';
import type { Expectation } from '../../domain/expectation.ts';
import {
  type CaseId,
  caseId,
  type ClinicId,
  type ExpectationId,
  type PatientId,
} from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { priorityOfCase, refreshCasePriorities } from '../case-manager/case-priority.ts';
import type { Catalog } from '../catalog.ts';
import type { EngineSettings } from '../settings.ts';
import { PatientTimeline } from '../timeline.ts';
import { firstActionAt, releaseCase, releaseDueBackfillCases } from '../backfill/release.ts';
import { caseExpectations } from '../escalation/schedule.ts';
import { recheckFulfilled } from '../annotator/recheck.ts';
import { caseOwner } from './owner.ts';

export interface WatcherDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

export interface WatcherReport {
  readonly clinicId: ClinicId;
  /** Backfill cases whose release day came: now visible and escalating. */
  readonly casesReleased: readonly CaseId[];
  /** Fulfilled by a booking whose date passed with no visit: open again (and expired, when due). */
  readonly reopened: number;
  readonly expired: number;
  readonly casesOpened: readonly CaseId[];
  /** Cases that received a new reason instead of a new case being opened. */
  readonly casesMerged: readonly CaseId[];
  /** Active cases whose priority changed when recomputed (the overdue factor moves daily). */
  readonly prioritiesUpdated: number;
}

/** One case per patient and case group (`<patientId>:<caseGroup>`). */
export function caseDedupKey(patientId: PatientId, caseGroup: string): string {
  return `${patientId}:${caseGroup}`;
}

interface PatientContext {
  readonly timeline: PatientTimeline;
  readonly conditions: readonly PatientCondition[];
}

/**
 * The deadline sweep. Every open expectation whose `dueAt` has passed is
 * marked `expired` and grouped into the patient's active case for its case
 * group, or opens a new case. Several layers firing for the same patient and
 * group therefore produce one case with several reasons. Runs one
 * transaction per page, so a crash keeps the pages already done.
 */
export async function runWatcher(
  deps: WatcherDeps,
  clinicId: ClinicId,
  now: Date,
): Promise<WatcherReport> {
  const catalog = await deps.loadCatalog(clinicId);
  const casesReleased = await releaseDueBackfillCases(deps, clinicId, now, catalog);
  const opened: CaseId[] = [];
  const merged = new Set<CaseId>();
  const rechecked = new Set<ExpectationId>();
  let reopened = 0;
  let expired = 0;
  for (;;) {
    const page = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      // Bookings whose date passed first, so what they no longer fulfill
      // expires in the same sweep when due.
      const recheck = await recheckLapsedBookings(stores, deps, catalog, clinicId, now, rechecked);
      reopened += recheck.reopened;
      const due = await stores.expectations.findDue(clinicId, now, deps.settings.sweepBatchSize);
      const sweep = new Sweep(stores, deps, catalog, clinicId, now, 'live');
      for (const expectation of due) {
        const outcome = await sweep.expire(expectation);
        if (outcome.opened) {
          opened.push(outcome.caseId);
        } else {
          merged.add(outcome.caseId);
        }
      }
      return { due: due.length, rechecked: recheck.rechecked };
    });
    expired += page.due;
    if (page.due < deps.settings.sweepBatchSize && page.rechecked < deps.settings.sweepBatchSize) {
      break;
    }
  }
  const prioritiesUpdated = await refreshCasePriorities({
    unitOfWork: deps.unitOfWork,
    clinicId,
    catalog,
    now,
    pageSize: deps.settings.sweepBatchSize,
  });
  return {
    clinicId,
    casesReleased,
    reopened,
    expired,
    casesOpened: opened,
    casesMerged: [...merged].filter((id) => !opened.includes(id)),
    prioritiesUpdated,
  };
}

/**
 * Expectations fulfilled by a booking whose date passed (plus the grace
 * days) are decided again, one page inside the caller's transaction: the
 * visit took place (now fulfilled by it), the patient booked again (by the
 * new booking), or nothing fulfills them and they are open again, so the
 * deadline sweep that follows expires them into a case when due.
 * `processed` keeps a page from being taken twice in one run.
 */
async function recheckLapsedBookings(
  stores: TransactionalStores,
  deps: WatcherDeps,
  catalog: Catalog,
  clinicId: ClinicId,
  now: Date,
  processed: Set<ExpectationId>,
): Promise<{ readonly rechecked: number; readonly reopened: number }> {
  const due = (
    await stores.expectations.findDueForRecheck(clinicId, now, deps.settings.sweepBatchSize)
  ).filter((expectation) => !processed.has(expectation.id));
  const timelines = new Map<PatientId, PatientTimeline>();
  let reopened = 0;
  for (const expectation of due) {
    processed.add(expectation.id);
    let timeline = timelines.get(expectation.patientId);
    if (timeline === undefined) {
      timeline = new PatientTimeline(
        await stores.clinicalRecords.listEventsForPatient(clinicId, expectation.patientId),
      );
      timelines.set(expectation.patientId, timeline);
    }
    const outcome = await recheckFulfilled({
      stores,
      catalog,
      timeline,
      expectation,
      now,
      graceDays: deps.settings.bookingVisitGraceDays,
    });
    if (outcome.kind === 'reopened') {
      reopened += 1;
    }
  }
  return { rechecked: due.length, reopened };
}

/**
 * One patient's expectations fulfilled by a booking whose date passed with
 * no visit, decided again inside the caller's transaction (the end of a
 * backfill replay, before what history left unmet is expired).
 *
 * @returns how many expectations were opened again.
 */
export async function recheckPatientBookings(input: {
  readonly stores: TransactionalStores;
  readonly settings: EngineSettings;
  readonly catalog: Catalog;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly now: Date;
}): Promise<number> {
  const { stores, clinicId, patientId, now } = input;
  const due = (await stores.expectations.listByPatient(clinicId, patientId, ['fulfilled'])).filter(
    (expectation) =>
      expectation.recheckAt !== undefined && expectation.recheckAt.getTime() <= now.getTime(),
  );
  if (due.length === 0) {
    return 0;
  }
  const timeline = new PatientTimeline(
    await stores.clinicalRecords.listEventsForPatient(clinicId, patientId),
  );
  let reopened = 0;
  for (const expectation of due) {
    const outcome = await recheckFulfilled({
      stores,
      catalog: input.catalog,
      timeline,
      expectation,
      now,
      graceDays: input.settings.bookingVisitGraceDays,
    });
    if (outcome.kind === 'reopened') {
      reopened += 1;
    }
  }
  return reopened;
}

/**
 * Expires one patient's due expectations inside the caller's transaction:
 * the end of a backfill replay, where what history left unmet becomes held
 * `backfill` cases.
 */
export async function expirePatient(
  input: {
    readonly stores: TransactionalStores;
    readonly deps: WatcherDeps;
    readonly catalog: Catalog;
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly now: Date;
  },
  origin: Origin,
): Promise<{ readonly opened: readonly CaseId[]; readonly expired: number }> {
  const { stores, clinicId, now } = input;
  const due = (await stores.expectations.findOpenByPatient(clinicId, input.patientId)).filter(
    (expectation) => expectation.dueAt.getTime() <= now.getTime(),
  );
  const sweep = new Sweep(stores, input.deps, input.catalog, clinicId, now, origin);
  const opened: CaseId[] = [];
  for (const expectation of due) {
    const outcome = await sweep.expire(expectation);
    if (outcome.opened) {
      opened.push(outcome.caseId);
    }
  }
  return { opened, expired: due.length };
}

/** A sweep opens `live` cases (the watcher) or held `backfill` cases (the backfill replay). */
class Sweep {
  readonly #stores: TransactionalStores;
  readonly #deps: WatcherDeps;
  readonly #catalog: Catalog;
  readonly #clinicId: ClinicId;
  readonly #now: Date;
  readonly #writer: CaseWriter;
  readonly #origin: Origin;
  readonly #patients = new Map<PatientId, PatientContext>();

  constructor(
    stores: TransactionalStores,
    deps: WatcherDeps,
    catalog: Catalog,
    clinicId: ClinicId,
    now: Date,
    origin: Origin,
  ) {
    this.#origin = origin;
    this.#stores = stores;
    this.#deps = deps;
    this.#catalog = catalog;
    this.#clinicId = clinicId;
    this.#now = now;
    this.#writer = new CaseWriter(stores, deps.ids, clinicId);
  }

  async expire(
    expectation: Expectation,
  ): Promise<{ readonly caseId: CaseId; readonly opened: boolean }> {
    const definition = this.#catalog.definition(expectation.ruleId);
    const dedupKey = caseDedupKey(
      expectation.patientId,
      definition?.caseGroup ?? expectation.reason.code,
    );
    const patient = await this.#patient(expectation.patientId);
    const actor: CaseEventActor = { type: 'rule', id: expectation.ruleId };
    const active = await this.#stores.cases.findActiveByDedupKey(this.#clinicId, dedupKey, {
      forUpdate: true,
    });
    const followUpCase =
      active === undefined
        ? await this.#open(expectation, dedupKey, patient, actor)
        : await this.#merge(active, expectation, patient, actor);
    await this.#stores.expectations.update(this.#clinicId, {
      ...expectation,
      status: 'expired',
      caseId: followUpCase.id,
      updatedAt: this.#now,
    });
    return { caseId: followUpCase.id, opened: active === undefined };
  }

  async #open(
    expectation: Expectation,
    dedupKey: string,
    patient: PatientContext,
    actor: CaseEventActor,
  ): Promise<FollowUpCase> {
    const held = this.#origin === 'backfill';
    const followUpCase: FollowUpCase = {
      id: caseId(this.#deps.ids.next('case')),
      clinicId: this.#clinicId,
      patientId: expectation.patientId,
      dedupKey,
      reasons: [{ expectationId: expectation.id, reasonCode: expectation.reason.code }],
      status: 'open',
      priority: this.#priority([expectation], patient, 0),
      assignee: caseOwner(expectation, patient.timeline, this.#deps.settings.frontDeskOwner),
      escalationStep: 0,
      // A held backfill case neither escalates nor shows until its release day.
      ...(held
        ? { releaseAt: BACKFILL_UNSCHEDULED_RELEASE_AT }
        : { nextActionAt: firstActionAt(this.#catalog, expectation, this.#now) }),
      origin: this.#origin,
      createdAt: this.#now,
      updatedAt: this.#now,
    };
    await this.#writer.create(followUpCase, actor, {
      expectationId: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
    });
    if (!held) {
      await this.#writer.emit('case.opened', this.#now, {
        caseId: followUpCase.id,
        patientId: followUpCase.patientId,
        reasons: [expectation.reason],
        priority: followUpCase.priority,
        origin: followUpCase.origin,
      });
    }
    return followUpCase;
  }

  async #merge(
    active: FollowUpCase,
    expectation: Expectation,
    patient: PatientContext,
    actor: CaseEventActor,
  ): Promise<FollowUpCase> {
    if (active.reasons.some((reason) => reason.expectationId === expectation.id)) {
      return active;
    }
    const reasons = [
      ...(await caseExpectations(this.#stores, this.#clinicId, active)),
      expectation,
    ];
    const updated = await this.#writer.update(
      {
        ...active,
        reasons: [
          ...active.reasons,
          { expectationId: expectation.id, reasonCode: expectation.reason.code },
        ],
        priority: this.#priority(reasons, patient, active.escalationStep),
        updatedAt: this.#now,
      },
      {
        type: 'reason_added',
        actor,
        payload: {
          expectationId: expectation.id,
          ruleId: expectation.ruleId,
          layer: expectation.layer,
        },
      },
    );
    // Something due today joins a held backfill case: it is actionable now.
    const releaseAt = updated.releaseAt?.getTime();
    if (this.#origin === 'live' && releaseAt !== undefined && releaseAt > this.#now.getTime()) {
      return releaseCase(this.#writer, this.#catalog, updated, reasons, this.#now);
    }
    return updated;
  }

  #priority(
    reasons: readonly Expectation[],
    patient: PatientContext,
    escalationStep: number,
  ): number {
    return priorityOfCase({
      catalog: this.#catalog,
      reasons,
      conditions: patient.conditions,
      escalationStep,
      now: this.#now,
    });
  }

  async #patient(patientId: PatientId): Promise<PatientContext> {
    const cached = this.#patients.get(patientId);
    if (cached !== undefined) {
      return cached;
    }
    const events = await this.#stores.clinicalRecords.listEventsForPatient(
      this.#clinicId,
      patientId,
    );
    const conditions = await this.#stores.conditions.listByPatient(this.#clinicId, patientId);
    const context: PatientContext = { timeline: new PatientTimeline(events), conditions };
    this.#patients.set(patientId, context);
    return context;
  }
}
