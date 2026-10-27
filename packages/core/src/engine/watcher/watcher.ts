import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { type CaseId, caseId, type ClinicId, type PatientId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { enrollingConditions } from '../annotator/conditions.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { computeCasePriority } from '../case-manager/priority.ts';
import type { Catalog } from '../catalog.ts';
import type { EngineSettings } from '../settings.ts';
import { addDays } from '../support/time.ts';
import { PatientTimeline } from '../timeline.ts';
import { caseOwner } from './owner.ts';

export interface WatcherDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

export interface WatcherReport {
  readonly clinicId: ClinicId;
  readonly expired: number;
  readonly casesOpened: readonly CaseId[];
  /** Cases that received a new reason instead of a new case being opened. */
  readonly casesMerged: readonly CaseId[];
}

/** One case per patient and case group (`<patientId>:<caseGroup>`). */
export function caseDedupKey(patientId: PatientId, caseGroup: string): string {
  return `${patientId}:${caseGroup}`;
}

interface PatientContext {
  readonly timeline: PatientTimeline;
  readonly chronic: boolean;
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
  const opened: CaseId[] = [];
  const merged = new Set<CaseId>();
  let expired = 0;
  for (;;) {
    const page = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const due = await stores.expectations.findDue(clinicId, now, deps.settings.sweepBatchSize);
      const sweep = new Sweep(stores, deps, catalog, clinicId, now);
      for (const expectation of due) {
        const outcome = await sweep.expire(expectation);
        if (outcome.opened) {
          opened.push(outcome.caseId);
        } else {
          merged.add(outcome.caseId);
        }
      }
      return due.length;
    });
    expired += page;
    if (page < deps.settings.sweepBatchSize) {
      break;
    }
  }
  return {
    clinicId,
    expired,
    casesOpened: opened,
    casesMerged: [...merged].filter((id) => !opened.includes(id)),
  };
}

class Sweep {
  readonly #stores: TransactionalStores;
  readonly #deps: WatcherDeps;
  readonly #catalog: Catalog;
  readonly #clinicId: ClinicId;
  readonly #now: Date;
  readonly #writer: CaseWriter;
  readonly #patients = new Map<PatientId, PatientContext>();

  constructor(
    stores: TransactionalStores,
    deps: WatcherDeps,
    catalog: Catalog,
    clinicId: ClinicId,
    now: Date,
  ) {
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
    const active = await this.#stores.cases.findActiveByDedupKey(this.#clinicId, dedupKey);
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
    const followUpCase: FollowUpCase = {
      id: caseId(this.#deps.ids.next('case')),
      clinicId: this.#clinicId,
      patientId: expectation.patientId,
      dedupKey,
      reasons: [{ expectationId: expectation.id, reasonCode: expectation.reason.code }],
      status: 'open',
      priority: this.#priority([expectation], patient),
      assignee: caseOwner(expectation, patient.timeline, this.#deps.settings.frontDeskOwner),
      escalationStep: 0,
      nextActionAt: addDays(
        this.#now,
        this.#catalog.definition(expectation.ruleId)?.escalationPolicy.steps[0]?.afterDays ?? 0,
      ),
      origin: expectation.origin,
      createdAt: this.#now,
      updatedAt: this.#now,
    };
    await this.#writer.create(followUpCase, actor, {
      expectationId: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
    });
    await this.#writer.emit('case.opened', this.#now, {
      caseId: followUpCase.id,
      patientId: followUpCase.patientId,
      reasons: [expectation.reason],
      priority: followUpCase.priority,
      origin: followUpCase.origin,
    });
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
    const grouped = await Promise.all(
      active.reasons.map((reason) =>
        this.#stores.expectations.get(this.#clinicId, reason.expectationId),
      ),
    );
    const reasons = [
      ...grouped.filter((item): item is Expectation => item !== undefined),
      expectation,
    ];
    return this.#writer.update(
      {
        ...active,
        reasons: [
          ...active.reasons,
          { expectationId: expectation.id, reasonCode: expectation.reason.code },
        ],
        priority: Math.max(active.priority, this.#priority(reasons, patient)),
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
  }

  #priority(reasons: readonly Expectation[], patient: PatientContext): number {
    return computeCasePriority({
      reasons: reasons.map((expectation) => ({
        expectation,
        definition: this.#catalog.definition(expectation.ruleId),
      })),
      chronic: patient.chronic,
      now: this.#now,
    });
  }

  async #patient(patientId: PatientId): Promise<PatientContext> {
    const cached = this.#patients.get(patientId);
    if (cached !== undefined) {
      return cached;
    }
    const [events, conditions] = await Promise.all([
      this.#stores.clinicalRecords.listEventsForPatient(this.#clinicId, patientId),
      this.#stores.conditions.listByPatient(this.#clinicId, patientId),
    ]);
    const context: PatientContext = {
      timeline: new PatientTimeline(events),
      chronic: this.#catalog.protocols.some(
        (protocol) => enrollingConditions(protocol, conditions).length > 0,
      ),
    };
    this.#patients.set(patientId, context);
    return context;
  }
}
