import type { CaseStatus, PatientCases } from '@follow-up-engine/core';
import type { PatientQueueItem } from '../http/patient-queue-schemas.ts';
import type { CaseView, ProtocolRefView } from '../http/schemas.ts';
import type { InboxPresenter } from './presenter.ts';

/**
 * Which status speaks for the card when the cases differ, most pressing
 * first: a case at the coordinator, then one the team was told about, an
 * open one, a snoozed one; closed statuses only when nothing is active.
 */
const STATUS_RANK: Readonly<Record<CaseStatus, number>> = {
  escalated: 0,
  notified: 1,
  open: 2,
  snoozed: 3,
  lost_to_follow_up: 4,
  resolved: 5,
  dismissed: 6,
};

const ACTIVE: ReadonlySet<CaseStatus> = new Set(['open', 'notified', 'snoozed', 'escalated']);

function distinct<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const value of values) {
    if (!seen.has(key(value))) {
      seen.set(key(value), value);
    }
  }
  return [...seen.values()];
}

function byPriority(left: CaseView, right: CaseView): number {
  return (
    right.priority - left.priority ||
    left.openedAt.localeCompare(right.openedAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * One card of the patient queue: the patient's cases (case views, most
 * urgent first) and what the card shows for all of them together. The
 * summary reads the active cases; a patient whose cases are all closed (the
 * "closed" view) is summarized from those.
 */
export function patientQueueItem(views: readonly CaseView[]): PatientQueueItem {
  const cases = [...views].sort(byPriority);
  const active = cases.filter((view) => ACTIVE.has(view.status));
  const summarized = active.length > 0 ? active : cases;
  const [top] = summarized;
  if (top === undefined) {
    throw new Error('A patient queue item needs at least one case');
  }
  const reasons = summarized.flatMap((view) => view.reasons);
  const live = summarized.filter((view) => view.origin === 'live');
  const opened = summarized.map((view) => view.openedAt).sort();
  const latest = (live.length > 0 ? live : summarized).map((view) => view.openedAt).sort();
  const next = summarized
    .flatMap((view) =>
      view.escalation.next === undefined ? [] : [{ caseId: view.id, ...view.escalation.next }],
    )
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  const status = summarized
    .map((view) => view.status)
    .sort((left, right) => STATUS_RANK[left] - STATUS_RANK[right])[0];
  return {
    patient: top.patient,
    priority: top.priority,
    priorityLabel: top.priorityLabel,
    status: status ?? top.status,
    caseCount: summarized.length,
    reasonCount: reasons.length,
    ...(top.reasons[0] === undefined ? {} : { topReason: top.reasons[0] }),
    layers: distinct(
      reasons.map((reason) => reason.layer),
      (layer) => layer,
    ),
    protocols: distinct(
      reasons.flatMap((reason): ProtocolRefView[] =>
        reason.protocol === undefined ? [] : [reason.protocol],
      ),
      (protocol) => protocol.id,
    ),
    escalation: {
      currentStep: Math.max(...summarized.map((view) => view.escalationStep)),
      escalated: summarized.some((view) => view.status === 'escalated'),
      ...(next === undefined
        ? {}
        : { next: { caseId: next.caseId, label: next.label, at: next.at } }),
    },
    nextAction: { caseId: top.id, label: top.suggestedAction },
    origin: live.length > 0 ? 'live' : 'backfill',
    openedAt: opened[0] ?? top.openedAt,
    latestOpenedAt: latest.at(-1) ?? top.openedAt,
    assignees: distinct(
      summarized.flatMap((view) => (view.assignee === undefined ? [] : [view.assignee])),
      (name) => name,
    ),
    patientContact: top.patientContact,
    // Active cases first (most urgent first), then the closed ones.
    cases: [...active, ...cases.filter((view) => !ACTIVE.has(view.status))],
  };
}

/** The cards of a page of the patient queue. */
export async function patientQueueItems(
  presenter: InboxPresenter,
  page: readonly PatientCases[],
): Promise<PatientQueueItem[]> {
  const views = await presenter.caseViews(page.flatMap((item) => item.cases));
  const byPatient = new Map<string, CaseView[]>();
  for (const view of views) {
    byPatient.set(view.patient.id, [...(byPatient.get(view.patient.id) ?? []), view]);
  }
  return page.map((item) => patientQueueItem(byPatient.get(item.patientId) ?? []));
}
