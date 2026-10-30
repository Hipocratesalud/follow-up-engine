import type { CaseFeedback, CaseFeedbackReason, FollowUpCase } from '../../domain/case.ts';
import { DISMISS_REASONS, type DismissReason } from '../../domain/contact.ts';
import type { Reason } from '../../domain/common.ts';
import type { ExpectationLayer } from '../../domain/expectation.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { Catalog } from '../catalog.ts';

/** How one rule is doing with the clinic team: the ground truth for tuning it. */
export interface RuleCalibration {
  readonly ruleId: string;
  /** The rule's reason (from the catalog, else from its cases). */
  readonly reason: Reason;
  readonly layer?: ExpectationLayer;
  /** Cases of the rule with a verdict (the latest one per case counts). */
  readonly casesWithFeedback: number;
  readonly useful: number;
  readonly notUseful: number;
  /** `useful / casesWithFeedback`, `undefined` without feedback. */
  readonly usefulRate?: number;
  /** Dismissed cases of the rule by reason ("Descartar"). */
  readonly dismissals: Readonly<Record<DismissReason, number>>;
  /** Why the not-useful verdicts said so, by reason (dismissals included). */
  readonly notUsefulReasons: Readonly<Partial<Record<CaseFeedbackReason, number>>>;
}

export interface CalibrationReport {
  readonly clinicId: ClinicId;
  /** Feedback and dismissals since this instant (all time when absent). */
  readonly since?: Date;
  /** Rules with feedback or dismissals, most dismissed first. */
  readonly rules: readonly RuleCalibration[];
}

/** At most this many feedback rows are read per report (a clinic's verdicts are few). */
export const CALIBRATION_FEEDBACK_LIMIT = 10_000;
const CASE_PAGE = 200;

interface MutableRule {
  reason: Reason;
  layer?: ExpectationLayer;
  useful: number;
  notUseful: number;
  dismissals: Record<DismissReason, number>;
  notUsefulReasons: Partial<Record<CaseFeedbackReason, number>>;
}

function emptyDismissals(): Record<DismissReason, number> {
  return Object.fromEntries(DISMISS_REASONS.map((reason) => [reason, 0])) as Record<
    DismissReason,
    number
  >;
}

/**
 * The calibration report of a clinic, per rule: how many of its cases the
 * team found useful (the latest verdict per case) and why it dismissed the
 * others. A case with several reasons counts for each of its rules. A rule
 * dismissed as `wrong_interval` again and again asks for a different
 * deadline; `not_applicable_to_patient`, for a narrower trigger.
 */
export async function calibrationReport(
  deps: {
    readonly unitOfWork: UnitOfWork;
    readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
    /** Test and QA accounts: their verdicts and dismissals are left out. */
    readonly isTestActor?: (actorId: string) => boolean;
  },
  clinicId: ClinicId,
  options: { readonly since?: Date } = {},
): Promise<CalibrationReport> {
  const catalog = await deps.loadCatalog(clinicId);
  const since = options.since ?? new Date(0);
  const isTest = (actorId: string | undefined): boolean =>
    actorId !== undefined && deps.isTestActor?.(actorId) === true;
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const rules = new Map<string, MutableRule>();
    const rulesOfCase = new Map<CaseId, readonly MutableRule[]>();

    /** The rules behind a case's reasons, each counted once. */
    async function rulesOf(followUpCase: FollowUpCase): Promise<readonly MutableRule[]> {
      const known = rulesOfCase.get(followUpCase.id);
      if (known !== undefined) {
        return known;
      }
      const found: MutableRule[] = [];
      for (const reason of followUpCase.reasons) {
        const expectation = await stores.expectations.get(clinicId, reason.expectationId);
        const ruleId = expectation?.ruleId ?? reason.reasonCode;
        let rule = rules.get(ruleId);
        if (rule === undefined) {
          const definition = catalog.definition(ruleId);
          const layer = definition?.layer ?? expectation?.layer;
          rule = {
            reason: definition?.reason ??
              expectation?.reason ?? { code: reason.reasonCode, label: reason.reasonCode },
            ...(layer === undefined ? {} : { layer }),
            useful: 0,
            notUseful: 0,
            dismissals: emptyDismissals(),
            notUsefulReasons: {},
          };
          rules.set(ruleId, rule);
        }
        if (!found.includes(rule)) {
          found.push(rule);
        }
      }
      rulesOfCase.set(followUpCase.id, found);
      return found;
    }

    // Verdicts: the latest per case.
    const latest = new Map<CaseId, CaseFeedback>();
    for (const feedback of await stores.feedback.listSince(
      clinicId,
      since,
      CALIBRATION_FEEDBACK_LIMIT,
    )) {
      if (isTest(feedback.authorId)) continue;
      latest.set(feedback.caseId, feedback);
    }
    for (const feedback of latest.values()) {
      const followUpCase = await stores.cases.get(clinicId, feedback.caseId);
      if (followUpCase === undefined) {
        continue;
      }
      for (const rule of await rulesOf(followUpCase)) {
        if (feedback.useful) {
          rule.useful += 1;
        } else {
          rule.notUseful += 1;
          if (feedback.reason !== undefined) {
            rule.notUsefulReasons[feedback.reason] =
              (rule.notUsefulReasons[feedback.reason] ?? 0) + 1;
          }
        }
      }
    }

    // Dismissals, by the reason the team gave.
    for (const followUpCase of await dismissedCases(stores, clinicId)) {
      const resolution = followUpCase.resolution;
      if (
        resolution === undefined ||
        resolution.resolvedAt.getTime() < since.getTime() ||
        isTest(resolution.resolvedBy)
      ) {
        continue;
      }
      const reason = resolution.dismissReason ?? 'other';
      for (const rule of await rulesOf(followUpCase)) {
        rule.dismissals[reason] += 1;
      }
    }

    const report: RuleCalibration[] = [...rules.entries()].map(([ruleId, rule]) => {
      const casesWithFeedback = rule.useful + rule.notUseful;
      return {
        ruleId,
        reason: rule.reason,
        ...(rule.layer === undefined ? {} : { layer: rule.layer }),
        casesWithFeedback,
        useful: rule.useful,
        notUseful: rule.notUseful,
        ...(casesWithFeedback === 0 ? {} : { usefulRate: rule.useful / casesWithFeedback }),
        dismissals: rule.dismissals,
        notUsefulReasons: rule.notUsefulReasons,
      };
    });
    const dismissalsOf = (rule: RuleCalibration): number =>
      Object.values(rule.dismissals).reduce((total, count) => total + count, 0);
    report.sort(
      (left, right) =>
        dismissalsOf(right) - dismissalsOf(left) ||
        right.casesWithFeedback - left.casesWithFeedback ||
        left.ruleId.localeCompare(right.ruleId),
    );
    return {
      clinicId,
      ...(options.since === undefined ? {} : { since: options.since }),
      rules: report,
    };
  });
}

async function dismissedCases(
  stores: TransactionalStores,
  clinicId: ClinicId,
): Promise<FollowUpCase[]> {
  const cases: FollowUpCase[] = [];
  let cursor: string | undefined;
  do {
    const page = await stores.cases.list(clinicId, {
      statuses: ['dismissed'],
      orderBy: 'created_at',
      limit: CASE_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    cases.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return cases;
}
