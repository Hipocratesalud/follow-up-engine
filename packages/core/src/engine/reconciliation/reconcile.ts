import { ACTIVE_CASE_STATUSES, type CaseEvent, type FollowUpCase } from '../../domain/case.ts';
import type { Origin } from '../../domain/common.ts';
import type { PatientCondition } from '../../domain/condition.ts';
import { ValidationError } from '../../domain/errors.ts';
import type { Expectation, ExpectationStatus } from '../../domain/expectation.ts';
import type { ClinicId, ExpectationId, PatientId } from '../../domain/ids.ts';
import {
  addReconciliationCounts,
  RECONCILIATION_ACTOR,
  RECONCILIATION_REASON,
  RECONCILIATION_SCOPES,
  type ReconciliationCounts,
  type ReconciliationRepair,
  type ReconciliationRepairKind,
  type ReconciliationRun,
  type ReconciliationScope,
  type RepairCounts,
  ZERO_RECONCILIATION_COUNTS,
} from '../../domain/reconciliation.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { IngestDeps } from '../application/ingest.ts';
import { applyInTransaction } from '../application/ingest.ts';
import { isClosedByClinician } from '../application/plan-item-commands.ts';
import {
  bookingOriginsOf,
  bookingsClosing,
  recordCaseBookings,
} from '../attribution/attribution.ts';
import { replayBatches } from '../backfill/backfill.ts';
import { planBackfillRelease } from '../backfill/release.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import {
  closeExpectation,
  type ClosingStatus,
  reopened,
  resolveSatisfiedCases,
} from '../case-manager/reconcile.ts';
import type { Catalog } from '../catalog.ts';
import { listPatientCases } from '../patient-state.ts';
import { expirePatient, recheckPatientBookings } from '../watcher/watcher.ts';
import { PAST_RELEVANCE_HORIZON } from '../annotator/acuity.ts';
import { DEFAULT_RECONCILIATION_SCHEDULE, nextReconciliationRun } from './schedule.ts';

/** Job of the nightly reconciliation of one clinic (enqueued by {@link scheduleReconciliation}). */
export const RECONCILIATION_JOB = 'reconciliation.run';

/** Attempts of a reconciliation job; each retry resumes the run where it stopped. */
export const RECONCILIATION_MAX_ATTEMPTS = 5;

/** Payload of a {@link RECONCILIATION_JOB}. */
export interface ReconciliationJobPayload {
  readonly scope: ReconciliationScope;
  /** The scheduled instant (ISO 8601): names the run, so a retry resumes the same one. */
  readonly scheduledFor: string;
}

export interface ReconciliationDeps extends IngestDeps {
  readonly clinics: ClinicDirectory;
}

export interface ReconciliationOptions {
  /** Id of a new run; default `reconciliation-<ISO instant>`. Ignored when an unfinished run resumes. */
  readonly runId?: string;
  /** Default `recent`. */
  readonly scope?: ReconciliationScope;
  /** Patients per page; default `EngineSettings.backfillPageSize`. */
  readonly pageSize?: number;
}

/** What one call to {@link runReconciliation} did. */
export interface ReconciliationReport {
  /** The run made (or, when `idle`, the previous one). */
  readonly run: ReconciliationRun;
  /** True when an unfinished (crashed) run was continued. */
  readonly resumed: boolean;
  /**
   * A `recent` run with no event stored since the previous run: nothing to
   * look at, so no run was recorded and nothing was sent.
   */
  readonly idle?: true;
  /** The repairs this call made, in order. */
  readonly repairs: readonly ReconciliationRepair[];
}

/** Thrown inside a transaction to roll it back while handing its result out. */
class DryRun<TResult> extends Error {
  override readonly name = 'DryRun';
  readonly result: TResult;

  constructor(result: TResult) {
    super('dry run: rolled back on purpose');
    this.result = result;
  }
}

/** Runs `work` in a transaction that is always rolled back, and returns what it computed. */
async function dryRun<TResult>(
  unitOfWork: UnitOfWork,
  clinicId: ClinicId,
  work: (stores: TransactionalStores) => Promise<TResult>,
): Promise<TResult> {
  try {
    await unitOfWork.withTransaction(clinicId, async (stores) => {
      throw new DryRun(await work(stores));
    });
  } catch (error) {
    if (error instanceof DryRun) {
      return (error as DryRun<TResult>).result;
    }
    throw error;
  }
  throw new Error('unreachable: a dry run always rolls back');
}

/** Someone changed the patient while the run compared it: leave it to the next run. */
class ConcurrentChange extends Error {
  override readonly name = 'ConcurrentChange';
}

/** Expired and open are one state for the comparison: expiry is the watcher's, on its own clock. */
type StatusClass = 'unmet' | Exclude<ExpectationStatus, 'open' | 'expired'>;

function statusClass(status: ExpectationStatus): StatusClass {
  return status === 'open' || status === 'expired' ? 'unmet' : status;
}

/**
 * The watcher's decision, like expiry: an unmet expectation that would have
 * opened its case long after the episode it belonged to was over was closed
 * when due, which a replay of the record (that never expires) cannot see.
 */
function closedByTheWatcher(stored: Expectation, replayed: Expectation): boolean {
  return (
    stored.status === 'cancelled' &&
    stored.closedReason === PAST_RELEVANCE_HORIZON &&
    statusClass(replayed.status) === 'unmet'
  );
}

function conditionKey(condition: PatientCondition): string {
  return `${condition.code.system}|${condition.code.code}`;
}

/** What the record says the patient's state should be, against what is stored. */
interface PatientPlan {
  /** Expectations the replay created: their events were never annotated. Final replay state. */
  readonly created: readonly Expectation[];
  /** Stored expectations whose status the replay changed: the stored one and the replay's. */
  readonly changed: readonly { readonly stored: Expectation; readonly replayed: Expectation }[];
  readonly conditions: readonly PatientCondition[];
  /** Expired expectations grouped into a case that does not exist (or into none). */
  readonly orphans: readonly Expectation[];
  /** Active cases whose every reason is closed. */
  readonly satisfiedCases: readonly FollowUpCase[];
}

function isEmpty(plan: PatientPlan): boolean {
  return (
    plan.created.length === 0 &&
    plan.changed.length === 0 &&
    plan.conditions.length === 0 &&
    plan.orphans.length === 0 &&
    plan.satisfiedCases.length === 0
  );
}

/** When each rule's per-clinic configuration last changed: nothing is applied retroactively. */
async function ruleConfigChanges(
  stores: TransactionalStores,
  clinicId: ClinicId,
): Promise<ReadonlyMap<string, Date>> {
  const changes = new Map<string, Date>();
  for (const change of await stores.ruleOverrides.history(clinicId)) {
    const known = changes.get(change.ruleId);
    if (known === undefined || known.getTime() < change.at.getTime()) {
      changes.set(change.ruleId, change.at);
    }
  }
  return changes;
}

async function orphansOf(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<Expectation[]> {
  const orphans: Expectation[] = [];
  for (const expectation of await stores.expectations.listByPatient(clinicId, patientId, [
    'expired',
  ])) {
    if (
      expectation.caseId === undefined ||
      (await stores.cases.get(clinicId, expectation.caseId)) === undefined
    ) {
      orphans.push(expectation);
    }
  }
  return orphans;
}

async function satisfiedCasesOf(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
): Promise<FollowUpCase[]> {
  const satisfied: FollowUpCase[] = [];
  for (const followUpCase of await listPatientCases(stores, clinicId, patientId, {
    statuses: ACTIVE_CASE_STATUSES,
  })) {
    let unmet = false;
    for (const reason of followUpCase.reasons) {
      const expectation = await stores.expectations.get(clinicId, reason.expectationId);
      if (expectation !== undefined && statusClass(expectation.status) === 'unmet') {
        unmet = true;
        break;
      }
    }
    if (!unmet) {
      satisfied.push(followUpCase);
    }
  }
  return satisfied;
}

/**
 * Computes what the patient's stored record calls for, in a transaction
 * that is always rolled back:
 *
 * 1. the watcher's own pending work (bookings whose date passed) is done
 *    first, so it is not mistaken for a repair;
 * 2. every stored event is replayed, step by step "as of" its own time,
 *    through the same annotator as live ingestion (`applyInTransaction`,
 *    the backfill's replay), and the bookings are rechecked again;
 * 3. the stored expectations and conditions are compared before and after:
 *    what the replay created, and what it moved to another status class
 *    (open and expired are one), is what a lost or out-of-order event left
 *    out. Cosmetic differences (a closing time, a case link the replay never
 *    sets) are not repairs.
 *
 * Read-only checks of the stored state come with it: expired expectations
 * whose case is gone, active cases with every reason closed.
 */
async function planPatient(
  deps: ReconciliationDeps,
  input: {
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly catalog: Catalog;
    readonly now: Date;
  },
): Promise<PatientPlan> {
  const { clinicId, patientId, catalog, now } = input;
  return dryRun(deps.unitOfWork, clinicId, async (stores) => {
    const orphans = await orphansOf(stores, clinicId, patientId);
    const satisfiedCases = await satisfiedCasesOf(stores, clinicId, patientId);
    const configChanges = await ruleConfigChanges(stores, clinicId);
    const recheck = { stores, settings: deps.settings, catalog, clinicId, patientId, now };
    await recheckPatientBookings(recheck);
    const before = await stores.expectations.listByPatient(clinicId, patientId);
    const conditionsBefore = new Set(
      (await stores.conditions.listByPatient(clinicId, patientId)).map(conditionKey),
    );
    const events = await stores.clinicalRecords.listEventsForPatient(clinicId, patientId);
    for (const batch of replayBatches(events)) {
      await applyInTransaction(deps, stores, {
        clinicId,
        patientId,
        catalog,
        events: batch.events,
        derived: [],
        now: batch.at,
        origin: 'live',
        asOf: batch.at,
      });
    }
    await recheckPatientBookings(recheck);
    const after = await stores.expectations.listByPatient(clinicId, patientId);
    const byKey = new Map(before.map((expectation) => [expectation.idempotencyKey, expectation]));
    const created: Expectation[] = [];
    const changed: { stored: Expectation; replayed: Expectation }[] = [];
    for (const replayed of after) {
      const stored = byKey.get(replayed.idempotencyKey);
      if (stored === undefined) {
        // A rule whose configuration changed after this trigger is not
        // applied retroactively (re-enabling a rule does not create what
        // it would have created while it was off).
        const changedAt = configChanges.get(replayed.ruleId);
        if (changedAt === undefined || changedAt.getTime() <= replayed.createdAt.getTime()) {
          created.push(replayed);
        }
      } else if (
        statusClass(stored.status) !== statusClass(replayed.status) &&
        !closedByTheWatcher(stored, replayed) &&
        // A plan item a clinician corrected or rejected is their decision, not
        // the record's: the replay never reopens or recloses it (HIP-141).
        !isClosedByClinician(stored)
      ) {
        changed.push({ stored, replayed });
      }
    }
    const conditions = (await stores.conditions.listByPatient(clinicId, patientId)).filter(
      (condition) => !conditionsBefore.has(conditionKey(condition)),
    );
    return { created, changed, conditions, orphans, satisfiedCases };
  });
}

/**
 * Every audit entry written while repairing is the reconciliation's:
 * actor `system`, reason `reconciliation` (whatever engine code path wrote it).
 */
function attributedToReconciliation(stores: TransactionalStores): TransactionalStores {
  const audit = stores.audit;
  return {
    ...stores,
    audit: {
      append: (clinicId: ClinicId, event: CaseEvent) =>
        audit.append(clinicId, {
          ...event,
          actor: RECONCILIATION_ACTOR,
          payload: { ...event.payload, reason: RECONCILIATION_REASON },
        }),
      listForCase: (clinicId, caseId) => audit.listForCase(clinicId, caseId),
    },
  };
}

const MS_PER_DAY = 86_400_000;

function closingKind(status: ClosingStatus): ReconciliationRepairKind {
  switch (status) {
    case 'fulfilled':
      return 'expectation_fulfilled';
    case 'superseded':
      return 'expectation_superseded';
    case 'cancelled':
      return 'expectation_cancelled';
  }
}

/**
 * Applies a patient's plan in one transaction, with every audit entry
 * attributed to the reconciliation, and returns the repairs made. Throws
 * {@link ConcurrentChange} (nothing written) when the patient changed since
 * the plan was made.
 */
async function repairPatient(
  deps: ReconciliationDeps,
  raw: TransactionalStores,
  input: {
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly runId: string;
    readonly catalog: Catalog;
    readonly now: Date;
    readonly plan: PatientPlan;
  },
): Promise<{ readonly repairs: ReconciliationRepair[]; readonly heldForRelease: boolean }> {
  const { clinicId, patientId, runId, catalog, now, plan } = input;
  const stores = attributedToReconciliation(raw);
  const repairs: ReconciliationRepair[] = [];
  const repair = (
    kind: ReconciliationRepairKind,
    entityId: string,
    fields: Partial<Pick<ReconciliationRepair, 'ruleId' | 'from' | 'to' | 'detail'>> = {},
  ): void => {
    repairs.push({
      clinicId,
      runId,
      patientId,
      kind,
      entityId,
      ...fields,
      actor: RECONCILIATION_ACTOR,
      reason: RECONCILIATION_REASON,
      at: now,
    });
  };
  const unchanged = async (expectation: Expectation): Promise<void> => {
    const current = await stores.expectations.get(clinicId, expectation.id);
    if (current?.updatedAt.getTime() !== expectation.updatedAt.getTime()) {
      throw new ConcurrentChange();
    }
  };
  /** Repaired expectations still unmet, by the origin of the case they open. */
  const toExpire: Record<Origin, Set<ExpectationId>> = { live: new Set(), backfill: new Set() };
  const expireLater = (expectation: Expectation): void => {
    toExpire[expectation.origin].add(expectation.id);
  };

  const known = new Set(
    (await stores.conditions.listByPatient(clinicId, patientId)).map(conditionKey),
  );
  for (const condition of plan.conditions) {
    if (known.has(conditionKey(condition))) {
      throw new ConcurrentChange();
    }
    await stores.conditions.upsert(clinicId, condition);
    repair('condition_recorded', conditionKey(condition), { to: condition.status });
  }

  for (const replayed of plan.created) {
    // A lost event older than the late-history window is old history: like
    // the backfill, its overdue expectation never contacts the patient and
    // is released in the clinic's daily batches.
    const oldHistory =
      now.getTime() - replayed.createdAt.getTime() > deps.settings.lateHistoryDays * MS_PER_DAY &&
      replayed.dueAt.getTime() <= now.getTime();
    const origin: Origin = oldHistory ? 'backfill' : 'live';
    const { created, expectation } = await stores.expectations.upsertByIdempotencyKey(clinicId, {
      ...replayed,
      origin,
    });
    if (!created) {
      throw new ConcurrentChange();
    }
    repair('expectation_created', expectation.id, {
      ruleId: expectation.ruleId,
      to: expectation.status,
      ...(expectation.closedReason === undefined ? {} : { detail: expectation.closedReason }),
    });
    if (expectation.status === 'open') {
      expireLater(expectation);
    }
  }

  /** Expectations this repair closed: a booking among their causes goes on the case trail. */
  const closedNow: Expectation[] = [];
  for (const { stored, replayed } of plan.changed) {
    await unchanged(stored);
    const to = statusClass(replayed.status);
    if (to === 'unmet') {
      const open = reopened(stored, now);
      await stores.expectations.update(clinicId, open);
      repair('expectation_reopened', stored.id, {
        ruleId: stored.ruleId,
        from: stored.status,
        to: 'open',
      });
      expireLater(open);
      continue;
    }
    const closed = await closeExpectation(
      stores,
      stored,
      to,
      replayed.closedReason ?? to,
      now,
      replayed.closedBy,
      replayed.recheckAt,
    );
    closedNow.push(closed);
    repair(closingKind(to), stored.id, {
      ruleId: stored.ruleId,
      from: stored.status,
      to: closed.status,
      detail: closed.closedReason ?? to,
    });
  }

  for (const orphan of plan.orphans) {
    await unchanged(orphan);
    const open = reopened(orphan, now);
    await stores.expectations.update(clinicId, open);
    repair('expectation_unlinked', orphan.id, {
      ruleId: orphan.ruleId,
      from: orphan.status,
      to: 'open',
      ...(orphan.caseId === undefined ? {} : { detail: `case_missing:${orphan.caseId}` }),
    });
    expireLater(open);
  }

  // What a repair left unmet and overdue opens (or joins) a case now, as
  // the watcher would have. Old history opens a held backfill case.
  for (const origin of ['live', 'backfill'] as const) {
    if (toExpire[origin].size === 0) {
      continue;
    }
    const outcome = await expirePatient(
      {
        stores,
        deps: { ...deps, clinics: deps.clinics },
        catalog,
        clinicId,
        patientId,
        now,
        only: toExpire[origin],
      },
      origin,
    );
    for (const caseId of outcome.opened) {
      repair('case_opened', caseId, {
        to: 'open',
        ...(origin === 'live' ? {} : { detail: origin }),
      });
    }
  }

  // A booking that fulfilled a repaired expectation goes on the case trail
  // with its verified origin, as live ingestion records it, before the case
  // resolves (the trail reads "booked", then "resolved"; the metrics count it).
  const bookings = await bookingsClosing(stores, clinicId, patientId, closedNow);
  await recordCaseBookings({
    stores,
    clinicId,
    events: bookings,
    closed: closedNow.map((expectation) => ({ expectation })),
    now,
  });

  // Every active case of the patient whose reasons are all closed now.
  const active = await listPatientCases(stores, clinicId, patientId, {
    statuses: ACTIVE_CASE_STATUSES,
  });
  const statusBefore = new Map(
    active.map((followUpCase) => [followUpCase.id, followUpCase.status]),
  );
  const resolved = await resolveSatisfiedCases({
    stores,
    writer: new CaseWriter(stores, deps.ids, clinicId),
    clinicId,
    caseIds: active.map((followUpCase) => followUpCase.id),
    actor: RECONCILIATION_ACTOR,
    now,
    bookingOrigins: bookingOriginsOf(bookings),
  });
  for (const caseId of resolved) {
    const from = statusBefore.get(caseId);
    repair('case_resolved', caseId, { ...(from === undefined ? {} : { from }), to: 'resolved' });
  }
  await raw.reconciliation.recordRepairs(clinicId, repairs);
  return { repairs, heldForRelease: toExpire.backfill.size > 0 };
}

function countsOf(repairs: readonly ReconciliationRepair[]): RepairCounts {
  const counts: Partial<Record<ReconciliationRepairKind, number>> = {};
  for (const repair of repairs) {
    counts[repair.kind] = (counts[repair.kind] ?? 0) + 1;
  }
  return counts;
}

async function reconcilePatient(
  deps: ReconciliationDeps,
  input: {
    readonly clinicId: ClinicId;
    readonly patientId: PatientId;
    readonly runId: string;
    readonly catalog: Catalog;
  },
): Promise<{
  readonly run: ReconciliationRun;
  readonly repairs: readonly ReconciliationRepair[];
  readonly heldForRelease: boolean;
}> {
  const { clinicId, patientId, runId } = input;
  const now = deps.clock.now();
  const plan = await planPatient(deps, { ...input, now });
  const advance = (stores: TransactionalStores, delta: ReconciliationCounts) =>
    stores.reconciliation.advance(clinicId, runId, { cursor: patientId, delta, now });
  const scanned = { ...ZERO_RECONCILIATION_COUNTS, patientsScanned: 1 };
  if (isEmpty(plan)) {
    return {
      run: await deps.unitOfWork.withTransaction(clinicId, (stores) => advance(stores, scanned)),
      repairs: [],
      heldForRelease: false,
    };
  }
  try {
    return await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const { repairs, heldForRelease } = await repairPatient(deps, stores, {
        ...input,
        now,
        plan,
      });
      const run = await advance(stores, {
        ...scanned,
        patientsRepaired: repairs.length > 0 ? 1 : 0,
        repairs: repairs.length,
        repairsByKind: countsOf(repairs),
      });
      return { run, repairs, heldForRelease };
    });
  } catch (error) {
    if (!(error instanceof ConcurrentChange)) {
      throw error;
    }
    return {
      run: await deps.unitOfWork.withTransaction(clinicId, (stores) =>
        advance(stores, { ...scanned, patientsSkipped: 1 }),
      ),
      repairs: [],
      heldForRelease: false,
    };
  }
}

/** `base`, or `base-2`, `base-3`, ... when runs already took it (two runs at one instant). */
async function freeRunId(
  stores: TransactionalStores,
  clinicId: ClinicId,
  base: string,
): Promise<string> {
  let candidate = base;
  for (
    let attempt = 2;
    (await stores.reconciliation.get(clinicId, candidate)) !== undefined;
    attempt += 1
  ) {
    candidate = `${base}-${String(attempt)}`;
  }
  return candidate;
}

async function startOrResume(
  deps: ReconciliationDeps,
  clinicId: ClinicId,
  options: ReconciliationOptions,
): Promise<{ readonly run: ReconciliationRun; readonly resumed: boolean }> {
  const now = deps.clock.now();
  const scope = options.scope ?? 'recent';
  if (!RECONCILIATION_SCOPES.includes(scope)) {
    throw new ValidationError('scope', `Unknown reconciliation scope ${scope}`);
  }
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const unfinished = await stores.reconciliation.findRunning(clinicId);
    if (unfinished !== undefined) {
      return { run: unfinished, resumed: true };
    }
    const previous = await stores.reconciliation.lastCompleted(clinicId);
    const watermark = await stores.clinicalRecords.eventWatermark(clinicId);
    const since = scope === 'recent' ? previous?.watermark : undefined;
    const run = await stores.reconciliation.start(
      clinicId,
      options.runId ?? (await freeRunId(stores, clinicId, `reconciliation-${now.toISOString()}`)),
      {
        scope,
        now,
        ...(since === undefined ? {} : { since }),
        ...(watermark === undefined ? {} : { watermark }),
      },
    );
    return { run, resumed: false };
  });
}

/**
 * The previous completed run when no event was stored since it (and no run
 * is unfinished): a quiet night needs no run of its own.
 */
async function idleSince(
  deps: ReconciliationDeps,
  clinicId: ClinicId,
): Promise<ReconciliationRun | undefined> {
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    if ((await stores.reconciliation.findRunning(clinicId)) !== undefined) {
      return undefined;
    }
    const previous = await stores.reconciliation.lastCompleted(clinicId);
    if (previous?.watermark === undefined) {
      return undefined;
    }
    const watermark = await stores.clinicalRecords.eventWatermark(clinicId);
    return watermark === previous.watermark ? previous : undefined;
  });
}

/** The counters of a run, without its identity. */
function runCounts(run: ReconciliationRun): ReconciliationCounts {
  return addReconciliationCounts(ZERO_RECONCILIATION_COUNTS, run);
}

/**
 * The nightly reconciliation of a clinic: a safety net for lost or
 * out-of-order events. For every patient in scope (`recent`: events stored
 * since the previous completed run, the whole clinic the first time; `all`:
 * everyone), the stored record is replayed through the same annotator as
 * live ingestion in a rolled-back transaction ({@link planPatient}); only the
 * differences are then repaired ({@link repairPatient}):
 *
 * - a missing expectation is created (the replay's own, with its state);
 * - an expectation the record closes is fulfilled, superseded or cancelled;
 *   one whose closure no longer stands is open again;
 * - an expired expectation whose case is gone is open again and, overdue,
 *   opens a new case; an active case with every reason closed is resolved.
 *
 * Never duplicates (keys by source and rule; a patient changed meanwhile is
 * skipped, not overwritten), never applies a rule change retroactively, and
 * a clean clinic is a no-op: nothing is written but the run's own record.
 * Every repair is audited (actor `system`, reason `reconciliation`), in the
 * case trail when it touches a case and in the run's repair log always.
 * Resumable: one transaction per patient carries its repairs and the
 * cursor; calling it again continues an unfinished run. Emits
 * `reconciliation.completed` with the counts (unless it had nobody to look
 * at) and, when it repaired anything, the `reconciliation.repairs_found`
 * alert. A `recent` run with no event stored since the previous run is idle:
 * it records nothing and returns the previous run.
 */
export async function runReconciliation(
  deps: ReconciliationDeps,
  clinicId: ClinicId,
  options: ReconciliationOptions = {},
): Promise<ReconciliationReport> {
  if ((options.scope ?? 'recent') === 'recent') {
    const previous = await idleSince(deps, clinicId);
    if (previous !== undefined) {
      return { run: previous, resumed: false, repairs: [], idle: true };
    }
  }
  const catalog = await deps.loadCatalog(clinicId);
  const pageSize = options.pageSize ?? deps.settings.backfillPageSize;
  const started = await startOrResume(deps, clinicId, options);
  let run = started.run;
  const repairs: ReconciliationRepair[] = [];
  let heldForRelease = false;
  for (;;) {
    const page = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.clinicalRecords.listPatientIds(clinicId, {
        ...(run.cursor === undefined ? {} : { after: run.cursor }),
        limit: pageSize,
        ...(run.scope === 'recent' && run.since !== undefined ? { changedAfter: run.since } : {}),
      }),
    );
    for (const patientId of page.patientIds) {
      const outcome = await reconcilePatient(deps, {
        clinicId,
        patientId,
        runId: run.runId,
        catalog,
      });
      run = outcome.run;
      repairs.push(...outcome.repairs);
      heldForRelease ||= outcome.heldForRelease;
    }
    if (page.next === undefined) {
      break;
    }
  }
  if (heldForRelease) {
    // Old history a repair brought back is released like the backfill's.
    await planBackfillRelease(deps, clinicId, deps.clock.now());
  }
  const now = deps.clock.now();
  const finished = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const done = await stores.reconciliation.finish(clinicId, run.runId, {
      status: 'completed',
      now,
    });
    const writer = new CaseWriter(stores, deps.ids, clinicId);
    const payload = { runId: done.runId, scope: done.scope, ...runCounts(done) };
    // A run that looked at nobody (stored events, but none of a patient in scope) completes quietly.
    if (done.patientsScanned > 0) {
      await writer.emit('reconciliation.completed', now, payload);
    }
    if (done.repairs > 0) {
      await writer.emit('reconciliation.repairs_found', now, payload);
    }
    return done;
  });
  return { run: finished, resumed: started.resumed, repairs };
}

function parseJobPayload(payload: Readonly<Record<string, unknown>>): ReconciliationJobPayload {
  const { scope, scheduledFor } = payload;
  if (
    typeof scope !== 'string' ||
    !(RECONCILIATION_SCOPES as readonly string[]).includes(scope) ||
    typeof scheduledFor !== 'string' ||
    Number.isNaN(Date.parse(scheduledFor))
  ) {
    throw new ValidationError('payload', `Invalid ${RECONCILIATION_JOB} payload`);
  }
  return { scope: scope as ReconciliationScope, scheduledFor };
}

/** Handler of {@link RECONCILIATION_JOB}: runs (or resumes) the scheduled run. Throws to retry. */
export function runReconciliationJob(
  deps: ReconciliationDeps,
  clinicId: ClinicId,
  rawPayload: Readonly<Record<string, unknown>>,
): Promise<ReconciliationReport> {
  const payload = parseJobPayload(rawPayload);
  return runReconciliation(deps, clinicId, {
    scope: payload.scope,
    runId: `reconciliation-${payload.scheduledFor}`,
  });
}

/**
 * Makes sure the clinic's next nightly run is queued: a
 * {@link RECONCILIATION_JOB} due at the next scheduled hour in the clinic's
 * time zone (`ClinicSettings.reconciliation`, default 03:00, a full sweep on
 * Sundays). Idempotent: called on every sweep, it queues each night once.
 *
 * @returns when the next run is due, or `undefined` when the clinic switched it off.
 */
export async function scheduleReconciliation(
  deps: Pick<ReconciliationDeps, 'unitOfWork' | 'clinics'>,
  clinicId: ClinicId,
  now: Date,
): Promise<{ readonly at: Date; readonly scope: ReconciliationScope } | undefined> {
  const clinic = await deps.clinics.get(clinicId);
  const schedule = clinic?.settings.reconciliation ?? {};
  if (clinic?.active !== true || !(schedule.enabled ?? DEFAULT_RECONCILIATION_SCHEDULE.enabled)) {
    return undefined;
  }
  const next = nextReconciliationRun(now, clinic.settings.timezone, schedule);
  const payload: ReconciliationJobPayload = {
    scope: next.scope,
    scheduledFor: next.at.toISOString(),
  };
  await deps.unitOfWork.withTransaction(clinicId, (stores) =>
    stores.jobs.enqueue(clinicId, {
      type: RECONCILIATION_JOB,
      payload: { ...payload },
      runAt: next.at,
      dedupKey: `${RECONCILIATION_JOB}:${payload.scheduledFor}`,
      maxAttempts: RECONCILIATION_MAX_ATTEMPTS,
    }),
  );
  return next;
}
