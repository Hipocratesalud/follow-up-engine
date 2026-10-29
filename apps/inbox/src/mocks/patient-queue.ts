import { LAYERS, type CaseStatus, type CaseView, type Page } from '../api/contract.ts';
import type {
  PatientQueueFacets,
  PatientQueueItem,
  PatientQueuePage,
  PatientQueueQuery,
} from '../api/patient-queue-contract.ts';
import {
  PLAN_ITEM_KINDS,
  type PlanItemView,
  type PlanItemViewKind,
} from '../api/plan-item-contract.ts';
import type { Locale } from '../i18n/index.ts';
import { mockProtocolCatalog } from './seed.ts';

/** The reason-type chip labels the mock API answers with, by locale (tests read these too). */
export const LAYER_LABELS: Readonly<Record<Locale, Record<(typeof LAYERS)[number], string>>> = {
  en: {
    universal: 'Orders and results',
    doctor_plan: "Doctor's plan",
    cadence: 'Visit frequency',
    protocol: 'Protocol',
  },
  es: {
    universal: 'Órdenes y resultados',
    doctor_plan: 'Plan del médico',
    cadence: 'Frecuencia de visitas',
    protocol: 'Protocolo',
  },
};

/*
 * The mock API's patient queue and plan item review (HIP-141), built the way
 * apps/api builds them: cards from the case views, grouped by patient.
 */

const ACTIVE: ReadonlySet<CaseStatus> = new Set(['open', 'notified', 'snoozed', 'escalated']);

const STATUS_RANK: Readonly<Record<CaseStatus, number>> = {
  escalated: 0,
  notified: 1,
  open: 2,
  snoozed: 3,
  lost_to_follow_up: 4,
  resolved: 5,
  dismissed: 6,
};

/** `closedReason` of a plan item a clinician corrected or rejected (as the engine names them). */
export const CORRECTED_BY_CLINICIAN = 'corrected_by_clinician';
export const REJECTED_BY_CLINICIAN = 'rejected_by_clinician';

/** The engine's case group of a rule: pending results apart, everything else one follow-up. */
export function mockCaseGroup(ruleId: string): 'pending_results' | 'follow_up' {
  return ruleId.endsWith('_result_pending') ? 'pending_results' : 'follow_up';
}

/** The kind of a mock plan item (`doctor_plan_<kind>`; a referral is a visit). */
export function mockPlanKind(ruleId: string): PlanItemViewKind {
  const kind = ruleId.replace(/^doctor_plan_/, '');
  return PLAN_ITEM_KINDS.find((candidate) => candidate === kind) ?? 'follow_up_visit';
}

export interface MockPlanItemFields {
  readonly ruleId: string;
  readonly layer: string;
  readonly status: string;
  readonly kind?: PlanItemViewKind;
  readonly closedReason?: string;
  readonly confirmedBy?: string;
  readonly confirmedAt?: Date;
  readonly correctionOf?: string;
}

/** The review view of a mock doctor's-plan expectation; `undefined` for other layers. */
export function mockPlanItemView(
  expectation: MockPlanItemFields,
  kindLabel: (kind: PlanItemViewKind) => string,
): PlanItemView | undefined {
  if (expectation.layer !== 'doctor_plan') return undefined;
  const kind = expectation.kind ?? mockPlanKind(expectation.ruleId);
  const closedByClinician =
    expectation.closedReason === CORRECTED_BY_CLINICIAN ||
    expectation.closedReason === REJECTED_BY_CLINICIAN;
  return {
    kind,
    kindLabel: kindLabel(kind),
    review:
      expectation.closedReason === CORRECTED_BY_CLINICIAN
        ? 'corrected'
        : expectation.closedReason === REJECTED_BY_CLINICIAN
          ? 'rejected'
          : expectation.confirmedBy === undefined
            ? 'pending'
            : 'confirmed',
    ...(expectation.confirmedBy === undefined ? {} : { confirmedBy: expectation.confirmedBy }),
    ...(expectation.confirmedAt === undefined
      ? {}
      : { confirmedAt: expectation.confirmedAt.toISOString() }),
    ...(expectation.correctionOf === undefined ? {} : { correctionOf: expectation.correctionOf }),
    actionable:
      !closedByClinician && (expectation.status === 'open' || expectation.status === 'expired'),
  };
}

function distinct<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const value of values) if (!seen.has(key(value))) seen.set(key(value), value);
  return [...seen.values()];
}

/** One card: the patient's case views summarized as the API does. */
export function mockPatientQueueItem(views: readonly CaseView[]): PatientQueueItem {
  const cases = [...views].sort(
    (left, right) => right.priority - left.priority || left.openedAt.localeCompare(right.openedAt),
  );
  const active = cases.filter((view) => ACTIVE.has(view.status));
  const summarized = active.length > 0 ? active : cases;
  const top = summarized[0];
  if (top === undefined) throw new Error('a card needs a case');
  const reasons = summarized.flatMap((view) => view.reasons);
  const live = summarized.filter((view) => view.origin === 'live');
  const next = summarized
    .flatMap((view) =>
      view.escalation.next === undefined ? [] : [{ caseId: view.id, ...view.escalation.next }],
    )
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  return {
    patient: top.patient,
    priority: top.priority,
    priorityBand: top.priorityBand,
    priorityLabel: top.priorityLabel,
    status:
      summarized
        .map((view) => view.status)
        .sort((left, right) => STATUS_RANK[left] - STATUS_RANK[right])[0] ?? top.status,
    caseCount: summarized.length,
    reasonCount: reasons.length,
    ...(top.reasons[0] === undefined ? {} : { topReason: top.reasons[0] }),
    layers: distinct(
      reasons.map((reason) => reason.layer),
      (layer) => layer,
    ),
    protocols: distinct(
      reasons.flatMap((reason) => (reason.protocol === undefined ? [] : [reason.protocol])),
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
    openedAt: summarized.map((view) => view.openedAt).sort()[0] ?? top.openedAt,
    latestOpenedAt:
      (live.length > 0 ? live : summarized)
        .map((view) => view.openedAt)
        .sort()
        .at(-1) ?? top.openedAt,
    assignees: distinct(
      summarized.flatMap((view) => (view.assignee === undefined ? [] : [view.assignee])),
      (name) => name,
    ),
    patientContact: top.patientContact,
    cases: [...active, ...cases.filter((view) => !ACTIVE.has(view.status))],
  };
}

/** `value` is absent, or one of `present` is in it (comma-separated, OR within one filter). */
function csvMatches(value: string | undefined, present: readonly string[]): boolean {
  if (value === undefined || value.trim() === '') return true;
  const selected = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return present.some((candidate) => selected.includes(candidate));
}

/**
 * A page of the patient queue from every matching case view (offset cursor,
 * like the mock's), filtered by `layer` and `protocol` and with their facet
 * counts (each ignoring only its own filter), as the API does.
 */
export function mockPatientQueuePage(
  views: readonly CaseView[],
  query: PatientQueueQuery,
  locale: Locale,
): PatientQueuePage {
  const byPatient = new Map<string, CaseView[]>();
  for (const view of views) {
    byPatient.set(view.patient.id, [...(byPatient.get(view.patient.id) ?? []), view]);
  }
  const entries = [...byPatient.values()]
    .map((cases) => ({ item: mockPatientQueueItem(cases), cases: cases.length }))
    .sort(
      (left, right) =>
        right.item.priority - left.item.priority ||
        left.item.patient.name.localeCompare(right.item.patient.name),
    );
  const matchesLayer = (item: PatientQueueItem) => csvMatches(query.layer, item.layers);
  const matchesProtocol = (item: PatientQueueItem) =>
    csvMatches(
      query.protocol,
      item.protocols.map((protocol) => protocol.id),
    );
  const matching = entries.filter(
    (entry) => matchesLayer(entry.item) && matchesProtocol(entry.item),
  );
  const layers = LAYERS.map((layer) => ({
    layer,
    label: LAYER_LABELS[locale][layer],
    count: entries.filter(
      (entry) => matchesProtocol(entry.item) && entry.item.layers.includes(layer),
    ).length,
  }));
  const protocols = mockProtocolCatalog(locale).map((protocol) => ({
    id: protocol.id,
    label: protocol.name,
    count: entries.filter(
      (entry) =>
        matchesLayer(entry.item) && entry.item.protocols.some((ref) => ref.id === protocol.id),
    ).length,
  }));
  const offset = query.cursor === undefined ? 0 : Number(query.cursor) || 0;
  const limit = query.limit ?? 50;
  const page = matching.slice(offset, offset + limit);
  const next = offset + page.length;
  const facets: PatientQueueFacets = { layers, protocols };
  return {
    items: page.map((entry) => entry.item),
    total: matching.length,
    totalCases: matching.reduce((sum, entry) => sum + entry.cases, 0),
    ...(next < matching.length ? { nextCursor: String(next) } : {}),
    facets,
  };
}

/** Every case view of a listing, across its pages. */
export function allViews(list: (cursor?: string) => Page<CaseView>): CaseView[] {
  const views: CaseView[] = [];
  let cursor: string | undefined;
  do {
    const page = list(cursor);
    views.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return views;
}
