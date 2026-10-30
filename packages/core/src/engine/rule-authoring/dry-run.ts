import type {
  AuthoredDefinition,
  DryRunExample,
  RuleDryRunReport,
} from '../../domain/authored-rule.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { applyInTransaction, type IngestDeps } from '../application/ingest.ts';
import { replayBatches } from '../backfill/backfill.ts';
import { type Catalog, protocolRuleId } from '../catalog.ts';
import { parseCodeMatchKey } from '../matching/match-key.ts';
import { testGroupOfCoding } from '../terminology/test-names.ts';

function withoutRank(example: DryRunExample & { readonly rank: number }): DryRunExample {
  return {
    patientRef: example.patientRef,
    status: example.status,
    dueInDays: example.dueInDays,
    overlapsWith: example.overlapsWith,
  };
}

/** Patients a dry run replays at most; the report says when there were more. */
export const DRY_RUN_MAX_PATIENTS = 500;

/** Pseudonymous examples a report lists. */
export const DRY_RUN_EXAMPLES = 6;

const MS_PER_DAY = 86_400_000;
const PAGE_SIZE = 100;

export interface DryRunDeps extends IngestDeps {
  /** The clinic's catalog as it would be with `extra` enabled. */
  readonly catalogWith: (clinicId: ClinicId, extra: AuthoredDefinition) => Promise<Catalog>;
}

export interface DryRunOptions {
  /** The instant counted up to: the clinic's own "today" (a lab clinic has its own clock). */
  readonly now: Date;
  readonly maxPatients?: number;
}

/** Rule ids of the expectations a definition creates (a protocol: one per item). */
export function authoredRuleIds(definition: AuthoredDefinition): readonly string[] {
  return definition.kind === 'rule'
    ? [definition.rule.id]
    : definition.protocol.items.map((item) => protocolRuleId(definition.protocol, item));
}

/** Thrown inside a transaction to roll it back while handing its result out. */
class RolledBack<TResult> extends Error {
  override readonly name = 'RolledBack';
  readonly result: TResult;

  constructor(result: TResult) {
    super('dry run: rolled back on purpose');
    this.result = result;
  }
}

async function rolledBack<TResult>(
  unitOfWork: UnitOfWork,
  clinicId: ClinicId,
  work: (stores: TransactionalStores) => Promise<TResult>,
): Promise<TResult> {
  try {
    await unitOfWork.withTransaction(clinicId, async (stores) => {
      throw new RolledBack(await work(stores));
    });
  } catch (error) {
    if (error instanceof RolledBack) {
      return (error as RolledBack<TResult>).result;
    }
    throw error;
  }
  throw new Error('unreachable: a dry run always rolls back');
}

/**
 * `P-3f2a9c`: a short FNV-1a hash of the clinic and patient ids. Stable,
 * not reversible by reading it, never the host's id or the patient's name.
 */
export function pseudonymousRef(clinicId: ClinicId, patientId: PatientId): string {
  let hash = 0x811c9dc5;
  for (const char of `${clinicId}|${patientId}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `P-${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

const LIVE = new Set<Expectation['status']>(['open', 'expired']);

/** Whether two expectations ask for the same thing: same match key, or tests of the same group. */
function sameAsk(left: Expectation, right: Expectation): boolean {
  if (left.matchKey === right.matchKey) {
    return true;
  }
  const leftCode = parseCodeMatchKey(left.matchKey);
  const rightCode = parseCodeMatchKey(right.matchKey);
  if (leftCode === undefined || rightCode === undefined) {
    return false;
  }
  const group = testGroupOfCoding(leftCode);
  return group !== undefined && group === testGroupOfCoding(rightCode);
}

interface PatientOutcome {
  readonly patientId: PatientId;
  readonly drafted: readonly Expectation[];
  readonly overlaps: ReadonlyMap<string, readonly string[]>;
}

/** Replays one patient's stored history with the draft in the catalog; always rolled back. */
async function replayPatient(
  deps: DryRunDeps,
  clinicId: ClinicId,
  patientId: PatientId,
  catalog: Catalog,
  draftIds: ReadonlySet<string>,
): Promise<PatientOutcome> {
  return rolledBack(deps.unitOfWork, clinicId, async (stores) => {
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
    const after = await stores.expectations.listByPatient(clinicId, patientId);
    const drafted = after.filter((expectation) => draftIds.has(expectation.ruleId));
    const others = after.filter(
      (expectation) => !draftIds.has(expectation.ruleId) && LIVE.has(expectation.status),
    );
    const overlaps = new Map<string, readonly string[]>();
    for (const expectation of drafted) {
      if (!LIVE.has(expectation.status)) continue;
      const covering = [
        ...new Set(others.filter((other) => sameAsk(expectation, other)).map((o) => o.ruleId)),
      ].sort();
      if (covering.length > 0) overlaps.set(expectation.id, covering);
    }
    return { patientId, drafted, overlaps };
  });
}

/**
 * What a clinic-authored draft would do to the clinic's current records,
 * computed by the real engine: every patient's stored events are replayed
 * step by step "as of" their own time through the same annotator as live
 * ingestion (the reconciliation's replay), with the draft added to the
 * clinic's catalog, inside a transaction that is always rolled back.
 * Nothing is stored, nothing is sent, no model is called (the plans read
 * from notes are stored events, replayed as they are).
 */
export async function dryRunAuthoredDefinition(
  deps: DryRunDeps,
  clinicId: ClinicId,
  definition: AuthoredDefinition,
  options: DryRunOptions,
): Promise<RuleDryRunReport> {
  const maxPatients = options.maxPatients ?? DRY_RUN_MAX_PATIENTS;
  const catalog = await deps.catalogWith(clinicId, definition);
  const draftIds = new Set(authoredRuleIds(definition));
  const patientIds: PatientId[] = [];
  let truncated = false;
  let after: PatientId | undefined;
  for (;;) {
    const page = await deps.unitOfWork.withTransaction(clinicId, (stores) =>
      stores.clinicalRecords.listPatientIds(clinicId, {
        limit: PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      }),
    );
    for (const id of page.patientIds) {
      if (patientIds.length >= maxPatients) {
        truncated = true;
        break;
      }
      patientIds.push(id);
    }
    if (truncated || page.next === undefined) break;
    after = page.next;
  }

  const now = options.now.getTime();
  let total = 0;
  let open = 0;
  let overdue = 0;
  let closed = 0;
  let overlapping = 0;
  const overlapPatients = new Set<PatientId>();
  const byRule = new Map<string, number>();
  const matched = new Set<PatientId>();
  const examples: (DryRunExample & { readonly rank: number })[] = [];
  for (const patientId of patientIds) {
    const outcome = await replayPatient(deps, clinicId, patientId, catalog, draftIds);
    if (outcome.drafted.length === 0) continue;
    matched.add(patientId);
    let best: (DryRunExample & { readonly rank: number }) | undefined;
    for (const expectation of outcome.drafted) {
      total += 1;
      const live = LIVE.has(expectation.status);
      const isOverdue = live && expectation.dueAt.getTime() <= now;
      if (!live) closed += 1;
      else if (isOverdue) overdue += 1;
      else open += 1;
      const covering = outcome.overlaps.get(expectation.id) ?? [];
      if (covering.length > 0) {
        overlapping += 1;
        overlapPatients.add(patientId);
        for (const ruleId of covering) byRule.set(ruleId, (byRule.get(ruleId) ?? 0) + 1);
      }
      const example = {
        patientRef: pseudonymousRef(clinicId, patientId),
        status: !live ? ('closed' as const) : isOverdue ? ('overdue' as const) : ('open' as const),
        dueInDays: Math.round((expectation.dueAt.getTime() - now) / MS_PER_DAY),
        overlapsWith: covering,
        rank: !live ? 2 : isOverdue ? 0 : 1,
      };
      // One example per patient: the most actionable of their expectations.
      if (best === undefined || example.rank < best.rank) best = example;
    }
    if (best !== undefined) examples.push(best);
  }
  return {
    asOf: options.now.toISOString(),
    patientsScanned: patientIds.length,
    truncated,
    patientsMatched: matched.size,
    expectations: { total, open, overdue, closed },
    overlaps: {
      expectations: overlapping,
      patients: overlapPatients.size,
      byRule: [...byRule.entries()]
        .map(([ruleId, count]) => ({ ruleId, count }))
        .sort((left, right) => right.count - left.count || left.ruleId.localeCompare(right.ruleId)),
    },
    examples: examples
      .sort((left, right) => left.rank - right.rank || left.dueInDays - right.dueInDays)
      .slice(0, DRY_RUN_EXAMPLES)
      .map(withoutRank),
  };
}
