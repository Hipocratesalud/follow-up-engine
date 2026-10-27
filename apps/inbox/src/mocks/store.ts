import {
  type ApiFieldError,
  ACTIVE_CASE_STATUSES,
  LAYERS,
  type ActorType,
  type CaseAction,
  type CaseActionRequest,
  type CaseDetail,
  type CaseFeedbackView,
  type CaseListQuery,
  type CaseReasonView,
  type CaseStatus,
  type CaseView,
  type ClinicInfo,
  type ConditionView,
  type CreatedExpectation,
  type DemoConsultationRequest,
  type DemoConsultationResponse,
  type EscalationAction,
  type EscalationView,
  type ExpectationStatus,
  type FeedbackRequest,
  type InboxStats,
  type Layer,
  type OwnerView,
  type Page,
  type PatientContact,
  type PatientDetail,
  type PatientSummary,
  type PriorityLabel,
  type RecoveryPage,
  type Sex,
  type WebhookDelivery,
} from '../api/contract.ts';
import { extractFromNote, MOCK_MODEL } from './extraction.ts';
import {
  ASSIGNEES,
  CLINIC_NAME,
  DEFAULT_SUGGESTED_ACTION,
  SEED_PATIENTS,
  SPECIALTY_LABELS,
  SUGGESTED_ACTIONS,
  type SeedPatient,
  type Specialty,
} from './seed.ts';

/**
 * Stateful in-memory stand-in for apps/api, used in mock mode and in tests.
 * It mimics the engine's observable behaviour (one case per patient, reasons
 * merged, escalation over time, staggered backfill release, outbound
 * webhooks) closely enough to tell the product story end to end.
 */

export const MOCK_START = new Date('2026-10-27T13:00:00.000Z');
const DAY_MS = 86_400_000;

/** Days after which an unanswered case moves to the next escalation step. */
const ESCALATION_DELAYS_DAYS = [7, 14, 30] as const;
/** After the last step, days until the case is declared lost to follow-up. */
const LOST_AFTER_DAYS = 60;
const MAX_SNOOZE_DAYS = 90;

export class MockHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: readonly ApiFieldError[];

  constructor(
    status: number,
    code: string,
    message: string,
    fields: readonly ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'MockHttpError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

interface MockPatient {
  id: string;
  name: string;
  age?: number;
  sex: Sex;
  contact: PatientContact;
}

interface MockDocument {
  id: string;
  patientId: string;
  authoredAt: Date;
  specialty: string;
  text: string;
}

interface MockExpectation {
  id: string;
  patientId: string;
  ruleId: string;
  layer: Layer;
  label: string;
  dueAt: Date;
  status: ExpectationStatus;
  source: { resourceType: string; id: string; display: string };
  evidence?: { quote: string; documentId: string };
  caseId?: string;
  origin: 'live' | 'backfill';
}

interface TimelineEntry {
  at: Date;
  type: string;
  actor: { type: ActorType; id?: string };
  label: string;
  note?: string;
}

interface MockCase {
  id: string;
  patientId: string;
  status: CaseStatus;
  escalationStep: number;
  assignee?: string;
  origin: 'live' | 'backfill';
  openedAt: Date;
  nextActionAt?: Date;
  releaseAt?: Date;
  snoozedUntil?: Date;
  expectationIds: string[];
  timeline: TimelineEntry[];
  feedback?: CaseFeedbackView;
}

interface MockCondition {
  id: string;
  patientId: string;
  code: string;
  display: string;
  status: 'confirmed' | 'probable' | 'resolved' | 'rejected';
  confidence: number;
  sourceType: string;
  evidence?: { quote: string; documentId: string };
  rejected: boolean;
}

interface MockQualityFinding {
  id: string;
  patientId: string;
  documentId: string;
  at: Date;
}

interface MockLlmCall {
  at: Date;
  costUsd: number;
}

const CLOSED_STATUSES: readonly CaseStatus[] = ['resolved', 'dismissed', 'lost_to_follow_up'];
const ACTIVE: readonly CaseStatus[] = ACTIVE_CASE_STATUSES;

const LAYER_WEIGHT: Record<Layer, number> = {
  doctor_plan: 34,
  universal: 30,
  protocol: 22,
  cadence: 16,
};

/** Timeline label of each escalation step the mock runs (index = step reached - 1). */
const ESCALATION_LABELS = [
  'Aviso al responsable del caso',
  'Prioridad aumentada por falta de respuesta',
  'Escalado a coordinación del consultorio',
] as const;

/** The mock's escalation policy, shaped like the engine's (`afterDays` from the case opening). */
const MOCK_POLICY: readonly { action: EscalationAction; afterDays: number }[] = [
  { action: 'notify_clinic', afterDays: 7 },
  { action: 'raise_priority', afterDays: 21 },
  { action: 'escalate_to_coordinator', afterDays: 51 },
  { action: 'mark_lost_to_follow_up', afterDays: 111 },
];

/** Same step labels as the API. */
const ESCALATION_STEP_LABELS: Record<EscalationAction, string> = {
  notify_clinic: 'Aviso al responsable',
  raise_priority: 'Aumento de prioridad',
  request_patient_contact: 'Pedido de contacto al paciente',
  escalate_to_coordinator: 'Paso a coordinación',
  mark_lost_to_follow_up: 'Cierre como perdido en seguimiento',
};

const COORDINATION = 'Coordinación';

/** Owner id of a display name, as the API's owner ids (`recepcion`, `dra-lucia-paredes`). */
export function mockOwnerId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalized(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Learned from the clinic's earlier work, so the stats are not empty on day one. */
const BASELINE_FEEDBACK = { total: 34, useful: 29 };
const BASELINE_LLM = { calls: 143, costUsd: 0.1573 };

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function pad(value: number): string {
  return String(value).padStart(3, '0');
}

function priorityLabel(priority: number): PriorityLabel {
  if (priority >= 75) return 'urgente';
  if (priority >= 55) return 'alta';
  if (priority >= 35) return 'media';
  return 'baja';
}

function excerptAround(text: string, quote: string, radius = 220): string {
  const index = text.indexOf(quote);
  if (index < 0 || text.length <= radius * 2 + quote.length) return text;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + quote.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export interface MockStoreOptions {
  readonly now?: Date;
}

const SPECIALTY_ASSIGNEES: Record<Specialty, string> = {
  diabetology: ASSIGNEES.paredes,
  internal_medicine: ASSIGNEES.rivas,
  psychology: ASSIGNEES.medina,
  gynecology: ASSIGNEES.ibarra,
};

const CADENCE_DAYS: Record<Specialty, number> = {
  diabetology: 90,
  internal_medicine: 90,
  psychology: 14,
  gynecology: 365,
};

function isSpecialty(value: string): value is Specialty {
  return value in CADENCE_DAYS;
}

/** The mock API surface: one method per contract endpoint. */
export interface MockStore {
  now(): Date;
  clinic(): ClinicInfo;
  listCases(query: CaseListQuery): Page<CaseView>;
  listOwners(): { items: OwnerView[] };
  listPatients(query?: string, limit?: number): { items: PatientSummary[] };
  getCase(id: string): CaseDetail;
  act(id: string, request: CaseActionRequest, actorId?: string): CaseDetail;
  feedback(id: string, request: FeedbackRequest, actorId?: string): CaseFeedbackView;
  getPatient(id: string): PatientDetail;
  reviewCondition(id: string, decision: 'confirm' | 'reject'): ConditionView;
  listRecovery(query: { cursor?: string; limit?: number }): RecoveryPage;
  stats(): InboxStats;
  clock(): { now: string; fake: boolean };
  advance(days: number): { now: string };
  createConsultation(request: DemoConsultationRequest): DemoConsultationResponse;
  listWebhooks(limit?: number, type?: string): { items: WebhookDelivery[] };
}

export function createMockStore(options: MockStoreOptions = {}): MockStore {
  let now = new Date(options.now ?? MOCK_START);
  const patients = new Map<string, MockPatient>();
  const documents = new Map<string, MockDocument>();
  const expectations = new Map<string, MockExpectation>();
  const cases = new Map<string, MockCase>();
  const conditions = new Map<string, MockCondition>();
  const findings: MockQualityFinding[] = [];
  const webhooks: WebhookDelivery[] = [];
  const llmCalls: MockLlmCall[] = [];
  const counters = { patient: 0, doc: 0, exp: 0, case: 0, cond: 0, finding: 0 };

  function nextId(kind: keyof typeof counters, prefix: string): string {
    counters[kind] += 1;
    return `${prefix}-${pad(counters[kind])}`;
  }

  function emit(type: string, payload: Record<string, unknown>, at: Date = now): void {
    webhooks.push({ at: at.toISOString(), type, payload, signatureValid: true, delivered: true });
  }

  function webhookCasePayload(followUpCase: MockCase): Record<string, unknown> {
    return {
      resourceType: 'Task',
      id: followUpCase.id,
      status: followUpCase.status,
      escalationStep: followUpCase.escalationStep,
      patient: { reference: `Patient/${followUpCase.patientId}` },
      reasons: followUpCase.expectationIds.map((id) => expectations.get(id)?.ruleId),
      ...(followUpCase.assignee ? { owner: followUpCase.assignee } : {}),
    };
  }

  // ---------------------------------------------------------------- seeding

  function seedPatient(seed: SeedPatient): void {
    const patientId = nextId('patient', 'pat');
    patients.set(patientId, {
      id: patientId,
      name: seed.name,
      age: seed.age,
      sex: seed.sex,
      contact: {
        allowed: !(seed.contact?.optedOut ?? false),
        optedOut: seed.contact?.optedOut ?? false,
        ...(seed.contact?.lastContactDaysAgo === undefined
          ? {}
          : { lastContactAt: addDays(now, -seed.contact.lastContactDaysAgo).toISOString() }),
      },
    });

    let documentId: string | undefined;
    if (seed.note) {
      documentId = nextId('doc', 'doc');
      documents.set(documentId, {
        id: documentId,
        patientId,
        authoredAt: addDays(now, -seed.note.daysAgo),
        specialty: seed.specialty,
        text: seed.note.text,
      });
      if (!seed.reasons.some((reason) => reason.quote)) {
        findings.push({
          id: nextId('finding', 'qf'),
          patientId,
          documentId,
          at: addDays(now, -seed.note.daysAgo),
        });
      }
    }

    for (const condition of seed.conditions ?? []) {
      const id = nextId('cond', 'cond');
      conditions.set(id, {
        id,
        patientId,
        code: condition.code,
        display: condition.display,
        status: condition.status,
        confidence: condition.confidence,
        sourceType: condition.sourceType,
        rejected: false,
        ...(condition.quote && documentId
          ? { evidence: { quote: condition.quote, documentId } }
          : {}),
      });
    }

    const caseSeed = seed.case;
    const caseId = caseSeed ? nextId('case', 'case') : undefined;
    const expectationIds: string[] = [];
    for (const reason of seed.reasons) {
      const id = nextId('exp', 'exp');
      expectationIds.push(id);
      const closed = caseSeed && CLOSED_STATUSES.includes(caseSeed.status);
      expectations.set(id, {
        id,
        patientId,
        ruleId: reason.ruleId,
        layer: reason.layer,
        label: reason.label,
        dueAt: addDays(now, -reason.overdueDays),
        status: caseId ? (closed ? 'fulfilled' : 'expired') : 'open',
        source: {
          resourceType: reason.source.resourceType,
          id:
            reason.source.resourceType === 'DocumentReference' && documentId
              ? documentId
              : `${reason.source.resourceType.toLowerCase()}-${id}`,
          display: reason.source.display,
        },
        origin: caseSeed?.origin ?? 'live',
        ...(caseId ? { caseId } : {}),
        ...(reason.quote && documentId ? { evidence: { quote: reason.quote, documentId } } : {}),
      });
    }

    for (const past of seed.history ?? []) {
      const id = nextId('exp', 'exp');
      expectations.set(id, {
        id,
        patientId,
        ruleId: past.ruleId,
        layer: past.layer,
        label: past.label,
        dueAt: addDays(now, -past.daysAgo),
        status: past.status,
        source: { resourceType: 'ServiceRequest', id: `servicerequest-${id}`, display: past.label },
        origin: 'live',
      });
    }

    if (!caseSeed || !caseId) return;
    const maxOverdue = Math.max(...seed.reasons.map((reason) => reason.overdueDays));
    const openedAt = addDays(now, -Math.max(1, maxOverdue));
    const timeline: TimelineEntry[] = [];
    const firstReason = seed.reasons[0];
    timeline.push({
      at: openedAt,
      type: 'opened',
      actor: { type: 'rule', id: firstReason?.ruleId ?? 'rule' },
      label: `Caso abierto: ${firstReason?.label ?? 'expectativa vencida'}`,
    });
    for (const reason of seed.reasons.slice(1)) {
      timeline.push({
        at: addDays(now, -Math.max(0, reason.overdueDays - 1)),
        type: 'reason_added',
        actor: { type: 'rule', id: reason.ruleId },
        label: `Motivo agregado: ${reason.label}`,
      });
    }
    if (caseSeed.origin === 'backfill') {
      timeline.push({
        at: addDays(now, -Math.max(0, maxOverdue - 1)),
        type: 'backfill_found',
        actor: { type: 'system' },
        label: 'Encontrado al revisar el historial del consultorio',
      });
    }
    for (let step = 1; step <= caseSeed.escalationStep; step += 1) {
      timeline.push({
        at: addDays(
          openedAt,
          ESCALATION_DELAYS_DAYS.slice(0, step).reduce((a, b) => a + b, 0),
        ),
        type: 'escalated',
        actor: { type: 'system' },
        label: ESCALATION_LABELS[step - 1] ?? 'Escalado',
      });
    }
    const lastContact = patients.get(patientId)?.contact.lastContactAt;
    if (caseSeed.status === 'notified' && lastContact) {
      timeline.push({
        at: new Date(lastContact),
        type: 'patient_contact_requested',
        actor: { type: 'user', id: seed.assignee },
        label: 'Se pidió al sistema del consultorio contactar al paciente',
      });
    }
    let snoozedUntil: Date | undefined;
    if (caseSeed.status === 'snoozed' && caseSeed.snoozeDays) {
      snoozedUntil = addDays(now, caseSeed.snoozeDays);
      timeline.push({
        at: addDays(now, -2),
        type: 'snoozed',
        actor: { type: 'user', id: seed.assignee },
        label: `Pospuesto ${String(caseSeed.snoozeDays + 2)} días: el paciente pidió que lo llamen después`,
      });
    }
    if (CLOSED_STATUSES.includes(caseSeed.status)) {
      const closedAt = addDays(now, -Math.max(1, Math.floor(maxOverdue / 3)));
      timeline.push({
        at: closedAt,
        type: caseSeed.status,
        actor:
          caseSeed.status === 'lost_to_follow_up'
            ? { type: 'system' }
            : { type: 'user', id: seed.assignee },
        label:
          caseSeed.status === 'resolved'
            ? 'Resuelto: el paciente asistió y se cargó el resultado'
            : caseSeed.status === 'dismissed'
              ? 'Descartado: el control ya estaba agendado en otra sede'
              : 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
      });
    }
    if (caseSeed.feedback) {
      timeline.push({
        at: addDays(now, -1),
        type: 'feedback_recorded',
        actor: { type: 'user', id: seed.assignee },
        label: caseSeed.feedback.useful ? 'Marcado como útil' : 'Marcado como no útil',
      });
    }
    timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

    const step = caseSeed.escalationStep;
    const nextDelay = ESCALATION_DELAYS_DAYS[step];
    cases.set(caseId, {
      id: caseId,
      patientId,
      status: caseSeed.status,
      escalationStep: step,
      assignee: seed.assignee,
      origin: caseSeed.origin,
      openedAt,
      expectationIds,
      timeline,
      ...(caseSeed.feedback ? { feedback: { ...caseSeed.feedback } } : {}),
      ...(snoozedUntil ? { snoozedUntil } : {}),
      ...(caseSeed.releaseInDays === undefined
        ? {}
        : { releaseAt: addDays(now, caseSeed.releaseInDays) }),
      ...(ACTIVE.includes(caseSeed.status) && caseSeed.releaseInDays === undefined
        ? { nextActionAt: addDays(now, nextDelay === undefined ? 5 : Math.min(nextDelay, 6)) }
        : {}),
    });
  }

  for (const seed of SEED_PATIENTS) seedPatient(seed);
  for (const followUpCase of cases.values()) {
    if (followUpCase.releaseAt) continue;
    emit('case.opened', webhookCasePayload(followUpCase), followUpCase.openedAt);
  }
  webhooks.sort((a, b) => a.at.localeCompare(b.at));
  webhooks.splice(0, Math.max(0, webhooks.length - 6));

  // ------------------------------------------------------------------ views

  function isReleased(followUpCase: MockCase): boolean {
    return !followUpCase.releaseAt || followUpCase.releaseAt.getTime() <= now.getTime();
  }

  function reasonView(expectation: MockExpectation): CaseReasonView {
    const document = expectation.evidence
      ? documents.get(expectation.evidence.documentId)
      : undefined;
    return {
      expectationId: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: expectation.label,
      dueAt: expectation.dueAt.toISOString(),
      overdueDays: Math.max(0, daysBetween(expectation.dueAt, now)),
      source: { ...expectation.source },
      ...(expectation.evidence && document
        ? {
            evidence: {
              quote: expectation.evidence.quote,
              documentId: document.id,
              authoredAt: document.authoredAt.toISOString(),
              noteExcerpt: excerptAround(document.text, expectation.evidence.quote),
            },
          }
        : {}),
    };
  }

  function computePriority(followUpCase: MockCase, reasons: readonly CaseReasonView[]): number {
    if (reasons.length === 0) return 0;
    const top = Math.max(
      ...reasons.map(
        (reason) => LAYER_WEIGHT[reason.layer] + Math.min(reason.overdueDays, 60) * 0.55,
      ),
    );
    const score = top + followUpCase.escalationStep * 9 + (reasons.length - 1) * 6;
    return Math.min(100, Math.round(score));
  }

  function caseView(followUpCase: MockCase): CaseView {
    const patient = patients.get(followUpCase.patientId);
    if (!patient) throw new MockHttpError(500, 'patient_missing', 'Paciente no encontrado');
    const reasons = followUpCase.expectationIds
      .map((id) => expectations.get(id))
      .filter((expectation): expectation is MockExpectation => expectation !== undefined)
      .map(reasonView)
      .sort(
        (a, b) =>
          LAYER_WEIGHT[b.layer] +
          b.overdueDays * 0.55 -
          (LAYER_WEIGHT[a.layer] + a.overdueDays * 0.55),
      );
    const priority = computePriority(followUpCase, reasons);
    const topRule = reasons[0]?.ruleId ?? '';
    return {
      id: followUpCase.id,
      patient: { id: patient.id, name: patient.name, sex: patient.sex, ...ageOf(patient) },
      status: followUpCase.status,
      priority,
      priorityLabel: priorityLabel(priority),
      escalationStep: followUpCase.escalationStep,
      escalation: escalationView(followUpCase, false),
      origin: followUpCase.origin,
      openedAt: followUpCase.openedAt.toISOString(),
      reasons,
      suggestedAction: SUGGESTED_ACTIONS[topRule] ?? DEFAULT_SUGGESTED_ACTION,
      patientContact: { ...patient.contact },
      ...(followUpCase.assignee
        ? { assignee: followUpCase.assignee, assigneeId: mockOwnerId(followUpCase.assignee) }
        : {}),
      ...(followUpCase.nextActionAt && ACTIVE.includes(followUpCase.status)
        ? { nextActionAt: followUpCase.nextActionAt.toISOString() }
        : {}),
      ...(followUpCase.releaseAt ? { releaseAt: followUpCase.releaseAt.toISOString() } : {}),
      ...(followUpCase.snoozedUntil && followUpCase.status === 'snoozed'
        ? { snoozedUntil: followUpCase.snoozedUntil.toISOString() }
        : {}),
    };
  }

  /** When each pending step runs if nobody acts, as the mock's own escalation counts (see the API presenter). */
  function projectedSchedule(followUpCase: MockCase): Map<number, Date> {
    const schedule = new Map<number, Date>();
    const current = followUpCase.escalationStep;
    if (!ACTIVE.includes(followUpCase.status)) return schedule;
    let at =
      followUpCase.status === 'snoozed' && followUpCase.snoozedUntil
        ? addDays(followUpCase.snoozedUntil, ESCALATION_DELAYS_DAYS[0])
        : !isReleased(followUpCase) && followUpCase.releaseAt
          ? addDays(followUpCase.releaseAt, ESCALATION_DELAYS_DAYS[0])
          : followUpCase.nextActionAt;
    if (!at) return schedule;
    for (let index = current; index < MOCK_POLICY.length; index += 1) {
      if (index > current) at = addDays(at, ESCALATION_DELAYS_DAYS[index] ?? LOST_AFTER_DAYS);
      schedule.set(index, at);
    }
    return schedule;
  }

  function escalationView(followUpCase: MockCase, detail: boolean): EscalationView {
    const current = followUpCase.escalationStep;
    const nextStep = MOCK_POLICY[current];
    const active = followUpCase.status !== 'snoozed' && ACTIVE.includes(followUpCase.status);
    const schedule = projectedSchedule(followUpCase);
    return {
      policyId: 'mock_v1',
      currentStep: current,
      steps: MOCK_POLICY.map((step, index) => {
        const scheduledAt = schedule.get(index);
        return {
          action: step.action,
          label: ESCALATION_STEP_LABELS[step.action],
          afterDays: step.afterDays,
          ...(detail && index < current ? { outcome: 'done' as const } : {}),
          ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}),
        };
      }),
      ...(active && nextStep && followUpCase.nextActionAt && isReleased(followUpCase)
        ? {
            next: {
              action: nextStep.action,
              label: ESCALATION_STEP_LABELS[nextStep.action],
              at: followUpCase.nextActionAt.toISOString(),
            },
          }
        : {}),
    };
  }

  function ageOf(patient: MockPatient): { age?: number } {
    return patient.age === undefined ? {} : { age: patient.age };
  }

  function caseDetail(followUpCase: MockCase): CaseDetail {
    return {
      ...caseView(followUpCase),
      escalation: escalationView(followUpCase, true),
      timeline: [...followUpCase.timeline]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .map((entry) => ({
          at: entry.at.toISOString(),
          type: entry.type,
          actor: { ...entry.actor },
          label: entry.label,
          ...(entry.note ? { note: entry.note } : {}),
        })),
      ...(followUpCase.feedback ? { feedback: { ...followUpCase.feedback } } : {}),
    };
  }

  function getCaseOrThrow(id: string): MockCase {
    const followUpCase = cases.get(id);
    if (!followUpCase) throw new MockHttpError(404, 'case_not_found', 'No encontramos ese caso.');
    return followUpCase;
  }

  function paginate<T>(items: readonly T[], cursor?: string, limit = 50): Page<T> {
    const start = cursor ? Number(cursor) : 0;
    const safeStart = Number.isFinite(start) && start > 0 ? start : 0;
    const page = items.slice(safeStart, safeStart + limit);
    const next = safeStart + limit;
    return {
      items: [...page],
      total: items.length,
      ...(next < items.length ? { nextCursor: String(next) } : {}),
    };
  }

  // ----------------------------------------------------------- engine-like

  function openOrMergeCase(expectation: MockExpectation): void {
    const existing = [...cases.values()].find(
      (candidate) =>
        candidate.patientId === expectation.patientId &&
        ACTIVE.includes(candidate.status) &&
        isReleased(candidate),
    );
    expectation.status = 'expired';
    if (existing) {
      existing.expectationIds.push(expectation.id);
      expectation.caseId = existing.id;
      existing.timeline.push({
        at: expectation.dueAt,
        type: 'reason_added',
        actor: { type: 'rule', id: expectation.ruleId },
        label: `Motivo agregado: ${expectation.label}`,
      });
      emit('case.reason_added', webhookCasePayload(existing), expectation.dueAt);
      return;
    }
    const patient = patients.get(expectation.patientId);
    const caseId = nextId('case', 'case');
    const followUpCase: MockCase = {
      id: caseId,
      patientId: expectation.patientId,
      status: 'open',
      escalationStep: 0,
      origin: expectation.origin,
      openedAt: expectation.dueAt,
      nextActionAt: addDays(expectation.dueAt, ESCALATION_DELAYS_DAYS[0]),
      expectationIds: [expectation.id],
      timeline: [
        {
          at: expectation.dueAt,
          type: 'opened',
          actor: { type: 'rule', id: expectation.ruleId },
          label: `Caso abierto: ${expectation.label}`,
        },
      ],
      ...(patient ? { assignee: assigneeFor(patient.id) } : {}),
    };
    expectation.caseId = caseId;
    cases.set(caseId, followUpCase);
    emit('case.opened', webhookCasePayload(followUpCase), expectation.dueAt);
  }

  function assigneeFor(patientId: string): string {
    const previous = [...cases.values()].find(
      (candidate) => candidate.patientId === patientId && candidate.assignee,
    );
    if (previous?.assignee) return previous.assignee;
    const document = [...documents.values()].find((doc) => doc.patientId === patientId);
    const specialty = document && isSpecialty(document.specialty) ? document.specialty : undefined;
    return specialty ? SPECIALTY_ASSIGNEES[specialty] : ASSIGNEES.reception;
  }

  function runWatcher(): void {
    const due = [...expectations.values()]
      .filter((expectation) => expectation.status === 'open' && expectation.dueAt <= now)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
    for (const expectation of due) openOrMergeCase(expectation);
  }

  function releaseBackfill(): void {
    for (const followUpCase of cases.values()) {
      if (!followUpCase.releaseAt || followUpCase.releaseAt > now) continue;
      if (followUpCase.timeline.some((entry) => entry.type === 'released')) continue;
      followUpCase.timeline.push({
        at: followUpCase.releaseAt,
        type: 'released',
        actor: { type: 'system' },
        label: 'Entró a la bandeja desde la revisión del historial',
      });
      followUpCase.nextActionAt = addDays(followUpCase.releaseAt, ESCALATION_DELAYS_DAYS[0]);
      emit('case.opened', webhookCasePayload(followUpCase), followUpCase.releaseAt);
    }
  }

  function wakeSnoozed(): void {
    for (const followUpCase of cases.values()) {
      if (followUpCase.status !== 'snoozed' || !followUpCase.snoozedUntil) continue;
      if (followUpCase.snoozedUntil > now) continue;
      const at = followUpCase.snoozedUntil;
      followUpCase.status = 'open';
      followUpCase.nextActionAt = addDays(at, ESCALATION_DELAYS_DAYS[0]);
      delete followUpCase.snoozedUntil;
      followUpCase.timeline.push({
        at,
        type: 'reopened',
        actor: { type: 'system' },
        label: 'Volvió a la bandeja al terminar el plazo pospuesto',
      });
    }
  }

  function runEscalation(): void {
    for (const followUpCase of cases.values()) {
      while (
        followUpCase.nextActionAt &&
        followUpCase.nextActionAt <= now &&
        isReleased(followUpCase) &&
        (followUpCase.status === 'open' ||
          followUpCase.status === 'notified' ||
          followUpCase.status === 'escalated')
      ) {
        const at = followUpCase.nextActionAt;
        if (followUpCase.escalationStep >= ESCALATION_DELAYS_DAYS.length) {
          followUpCase.status = 'lost_to_follow_up';
          delete followUpCase.nextActionAt;
          followUpCase.timeline.push({
            at,
            type: 'lost_to_follow_up',
            actor: { type: 'system' },
            label: 'Sin respuesta tras todos los escalamientos: perdido en seguimiento',
          });
          emit('case.lost_to_follow_up', webhookCasePayload(followUpCase), at);
          break;
        }
        followUpCase.escalationStep += 1;
        followUpCase.status = 'escalated';
        if (MOCK_POLICY[followUpCase.escalationStep - 1]?.action === 'escalate_to_coordinator') {
          followUpCase.assignee = COORDINATION;
        }
        const nextDelay = ESCALATION_DELAYS_DAYS[followUpCase.escalationStep] ?? LOST_AFTER_DAYS;
        followUpCase.nextActionAt = addDays(at, nextDelay);
        followUpCase.timeline.push({
          at,
          type: 'escalated',
          actor: { type: 'system' },
          label: ESCALATION_LABELS[followUpCase.escalationStep - 1] ?? 'Escalado',
        });
        emit('case.escalated', webhookCasePayload(followUpCase), at);
      }
    }
  }

  // ---------------------------------------------------------------- commands

  const ACTION_LABELS: Record<CaseAction, string> = {
    notify: 'Se pidió al sistema del consultorio contactar al paciente',
    snooze: 'Pospuesto',
    resolve: 'Resuelto por el equipo',
    dismiss: 'Descartado por el equipo',
  };

  function act(id: string, request: CaseActionRequest, actorId = 'Dra. Lucía Paredes'): CaseDetail {
    const followUpCase = getCaseOrThrow(id);
    if (!ACTIVE.includes(followUpCase.status)) {
      throw new MockHttpError(
        409,
        'invalid_transition',
        `No se puede cambiar este caso: ya está ${followUpCase.status === 'resolved' ? 'resuelto' : 'cerrado'}.`,
      );
    }
    const patient = patients.get(followUpCase.patientId);
    const note = request.note?.trim();
    const withNote = note ? { note } : {};
    switch (request.action) {
      case 'notify': {
        if (!patient?.contact.allowed || patient.contact.optedOut) {
          throw new MockHttpError(
            409,
            'patient_contact_not_allowed',
            'El paciente no acepta mensajes del consultorio. Contáctalo por otra vía.',
          );
        }
        followUpCase.status = 'notified';
        followUpCase.nextActionAt = addDays(now, ESCALATION_DELAYS_DAYS[0]);
        patient.contact.lastContactAt = now.toISOString();
        followUpCase.timeline.push({
          at: now,
          type: 'patient_contact_requested',
          actor: { type: 'user', id: actorId },
          label: ACTION_LABELS.notify,
          ...withNote,
        });
        emit('case.patient_contact_requested', {
          ...webhookCasePayload(followUpCase),
          contact: {
            channel: 'host_default',
            template: 'follow_up_reminder',
            variables: { patientFirstName: patient.name.split(' ')[0], clinicName: CLINIC_NAME },
          },
        });
        break;
      }
      case 'snooze': {
        const days = request.snoozeDays;
        if (days === undefined || !Number.isInteger(days) || days < 1 || days > MAX_SNOOZE_DAYS) {
          throw new MockHttpError(
            422,
            'invalid_snooze_days',
            `Indica entre 1 y ${String(MAX_SNOOZE_DAYS)} días.`,
          );
        }
        followUpCase.status = 'snoozed';
        followUpCase.snoozedUntil = addDays(now, days);
        delete followUpCase.nextActionAt;
        followUpCase.timeline.push({
          at: now,
          type: 'snoozed',
          actor: { type: 'user', id: actorId },
          label: `Pospuesto ${String(days)} ${days === 1 ? 'día' : 'días'}`,
          ...withNote,
        });
        emit('case.snoozed', webhookCasePayload(followUpCase));
        break;
      }
      case 'resolve':
      case 'dismiss': {
        const resolved = request.action === 'resolve';
        followUpCase.status = resolved ? 'resolved' : 'dismissed';
        delete followUpCase.nextActionAt;
        delete followUpCase.snoozedUntil;
        for (const expectationId of followUpCase.expectationIds) {
          const expectation = expectations.get(expectationId);
          if (expectation) expectation.status = resolved ? 'fulfilled' : 'cancelled';
        }
        followUpCase.timeline.push({
          at: now,
          type: followUpCase.status,
          actor: { type: 'user', id: actorId },
          label: ACTION_LABELS[request.action],
          ...withNote,
        });
        emit(`case.${followUpCase.status}`, webhookCasePayload(followUpCase));
        break;
      }
    }
    return caseDetail(followUpCase);
  }

  function feedback(
    id: string,
    request: FeedbackRequest,
    actorId = 'Dra. Lucía Paredes',
  ): CaseFeedbackView {
    const followUpCase = getCaseOrThrow(id);
    if (!request.useful && !request.reason) {
      throw new MockHttpError(
        422,
        'feedback_reason_required',
        'Cuéntanos por qué no fue útil para mejorar las reglas.',
      );
    }
    const comment = request.comment?.trim();
    const value: CaseFeedbackView = {
      useful: request.useful,
      ...(request.useful || !request.reason ? {} : { reason: request.reason }),
      ...(comment ? { comment } : {}),
    };
    followUpCase.feedback = value;
    followUpCase.timeline.push({
      at: now,
      type: 'feedback_recorded',
      actor: { type: 'user', id: actorId },
      label: request.useful ? 'Marcado como útil' : 'Marcado como no útil',
    });
    return value;
  }

  function conditionView(condition: MockCondition): ConditionView {
    return {
      id: condition.id,
      code: condition.code,
      display: condition.display,
      status: condition.status,
      confidence: condition.confidence,
      sourceType: condition.sourceType,
      ...(condition.evidence ? { evidence: { ...condition.evidence } } : {}),
      ...(condition.status === 'rejected' ? { rejectedBy: 'clinician' as const } : {}),
    };
  }

  function reviewCondition(id: string, decision: 'confirm' | 'reject'): ConditionView {
    const condition = conditions.get(id);
    if (!condition || condition.rejected) {
      throw new MockHttpError(404, 'condition_not_found', 'No encontramos esa condición.');
    }
    if (condition.status !== 'probable') {
      throw new MockHttpError(409, 'condition_not_probable', 'Esta condición ya fue revisada.');
    }
    if (decision === 'confirm') {
      condition.status = 'confirmed';
    } else {
      condition.status = 'rejected';
      condition.confidence = 0;
      condition.rejected = true;
    }
    return conditionView(condition);
  }

  // ------------------------------------------------------------------- demo

  function createExpectation(
    patientId: string,
    fields: Omit<MockExpectation, 'id' | 'patientId' | 'status' | 'origin'>,
  ): CreatedExpectation {
    const id = nextId('exp', 'exp');
    expectations.set(id, { id, patientId, status: 'open', origin: 'live', ...fields });
    return {
      id,
      ruleId: fields.ruleId,
      layer: fields.layer,
      label: fields.label,
      dueAt: fields.dueAt.toISOString(),
    };
  }

  function createConsultation(request: DemoConsultationRequest): DemoConsultationResponse {
    const text = request.noteText.trim();
    if (text.length < 20) {
      throw new MockHttpError(422, 'note_too_short', 'Escribe una nota de al menos 20 caracteres.');
    }
    let patient = request.patientId ? patients.get(request.patientId) : undefined;
    if (request.patientId && !patient) {
      throw new MockHttpError(404, 'patient_not_found', 'No encontramos ese paciente.');
    }
    if (!patient) {
      const name = request.patientName?.trim();
      if (!name) {
        throw new MockHttpError(422, 'patient_required', 'Elige un paciente o escribe un nombre.');
      }
      const id = nextId('patient', 'pat');
      patient = { id, name, sex: 'unknown', contact: { allowed: true, optedOut: false } };
      patients.set(id, patient);
    }
    const patientId = patient.id;
    const documentId = nextId('doc', 'doc');
    documents.set(documentId, {
      id: documentId,
      patientId,
      authoredAt: now,
      specialty: request.specialty,
      text,
    });

    const extracted = extractFromNote(text, now);
    const inputTokens = 1150 + Math.round(text.length / 3.6);
    const outputTokens = 180 + extracted.planItems.length * 70 + extracted.conditions.length * 45;
    const costUsd = Number(((inputTokens * 0.35 + outputTokens * 1.4) / 1_000_000).toFixed(6));
    const latencyMs = 900 + ((text.length * 7) % 900);
    llmCalls.push({ at: now, costUsd });

    const created: CreatedExpectation[] = [];
    const orders = request.orders ?? [];
    for (const order of orders) {
      created.push(
        createExpectation(patientId, {
          ruleId: 'lab_order_result_pending',
          layer: 'universal',
          label: `Resultado de ${order.display} pendiente`,
          dueAt: addDays(now, 21),
          source: {
            resourceType: 'ServiceRequest',
            id: `sr-${order.loinc}-${documentId}`,
            display: order.display,
          },
        }),
      );
    }
    const planLabels = {
      follow_up_visit: 'Consulta de control indicada en la nota',
      lab: 'Exámenes indicados en el plan',
      imaging: 'Estudio de imagen indicado en el plan',
      session: 'Sesión de seguimiento indicada en la nota',
      other: 'Indicación del plan pendiente',
    } as const;
    for (const item of extracted.planItems) {
      created.push(
        createExpectation(patientId, {
          ruleId: `doctor_plan_${item.kind}`,
          layer: 'doctor_plan',
          label: planLabels[item.kind],
          dueAt: new Date(item.dueAt),
          source: {
            resourceType: 'DocumentReference',
            id: documentId,
            display: 'Nota de la consulta',
          },
          evidence: { quote: item.evidenceQuote, documentId },
        }),
      );
    }
    const specialty = isSpecialty(request.specialty) ? request.specialty : undefined;
    const plansVisit = extracted.planItems.some(
      (item) => item.kind === 'follow_up_visit' || item.kind === 'session',
    );
    if (!plansVisit && specialty) {
      created.push(
        createExpectation(patientId, {
          ruleId: `cadence_${specialty}_visit`,
          layer: 'cadence',
          label: `Próxima consulta de ${SPECIALTY_LABELS[specialty].toLowerCase()} según la frecuencia habitual`,
          dueAt: addDays(now, CADENCE_DAYS[specialty]),
          source: {
            resourceType: 'Encounter',
            id: `enc-${documentId}`,
            display: 'Consulta de hoy',
          },
        }),
      );
    }
    const coversHba1c =
      extracted.planItems.some((item) => /hba1c/i.test(item.evidenceQuote)) ||
      orders.some((order) => /hba1c|4548-4/i.test(`${order.display} ${order.loinc}`));
    if (extracted.conditions.some((condition) => condition.code.code === 'E11') && !coversHba1c) {
      created.push(
        createExpectation(patientId, {
          ruleId: 'protocol_hba1c_quarterly',
          layer: 'protocol',
          label: 'HbA1c trimestral (protocolo DM2)',
          dueAt: addDays(now, 90),
          source: {
            resourceType: 'PlanDefinition',
            id: 'protocol-dm2',
            display: 'Protocolo de diabetes tipo 2',
          },
        }),
      );
    }
    if (extracted.conditions.some((condition) => condition.code.code === 'D25.1')) {
      created.push(
        createExpectation(patientId, {
          ruleId: 'protocol_fibroid_ultrasound',
          layer: 'protocol',
          label: 'Ecografía de control de mioma (protocolo)',
          dueAt: addDays(now, 180),
          source: {
            resourceType: 'PlanDefinition',
            id: 'protocol-fibroid',
            display: 'Seguimiento de miomatosis uterina',
          },
        }),
      );
    }

    for (const condition of extracted.conditions) {
      const known = [...conditions.values()].some(
        (existing) =>
          existing.patientId === patientId &&
          existing.code === condition.code.code &&
          !existing.rejected,
      );
      if (known) continue;
      const id = nextId('cond', 'cond');
      conditions.set(id, {
        id,
        patientId,
        code: condition.code.code,
        display: condition.code.display ?? condition.code.code,
        status: 'probable',
        confidence: condition.confidence,
        sourceType: 'extracted_from_note',
        evidence: { quote: condition.evidenceQuote, documentId },
        rejected: false,
      });
    }
    if (!extracted.hasPlan) {
      findings.push({ id: nextId('finding', 'qf'), patientId, documentId, at: now });
    }

    emit('consultation.processed', {
      documentReference: { reference: `DocumentReference/${documentId}` },
      patient: { reference: `Patient/${patientId}` },
      expectationsCreated: created.length,
      qualityFindings: extracted.hasPlan ? [] : ['note_without_plan'],
    });

    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: patientId } },
        {
          resource: {
            resourceType: 'Encounter',
            id: `enc-${documentId}`,
            status: 'finished',
            subject: { reference: `Patient/${patientId}` },
            serviceType: { text: request.specialty },
            period: { start: now.toISOString(), end: now.toISOString() },
          },
        },
        {
          resource: {
            resourceType: 'DocumentReference',
            id: documentId,
            status: 'current',
            subject: { reference: `Patient/${patientId}` },
            date: now.toISOString(),
            content: [{ attachment: { contentType: 'text/plain; charset=utf-8', language: 'es' } }],
          },
        },
        ...orders.map((order) => ({
          resource: {
            resourceType: 'ServiceRequest',
            id: `sr-${order.loinc}-${documentId}`,
            status: 'active',
            intent: 'order',
            subject: { reference: `Patient/${patientId}` },
            code: {
              coding: [{ system: 'http://loinc.org', code: order.loinc, display: order.display }],
            },
            authoredOn: now.toISOString(),
          },
        })),
      ],
    };

    return {
      bundle,
      extraction: {
        model: MOCK_MODEL,
        hasPlan: extracted.hasPlan,
        conditions: extracted.conditions,
        medications: extracted.medications,
        planItems: extracted.planItems,
        costUsd,
        latencyMs,
      },
      expectationsCreated: created,
    };
  }

  // --------------------------------------------------------------- queries

  return {
    now: (): Date => new Date(now),

    listCases(query: CaseListQuery): Page<CaseView> {
      const view = query.view ?? 'active';
      const words = normalized(query.q ?? '')
        .split(/\s+/)
        .filter(Boolean);
      const items = [...cases.values()]
        .filter(isReleased)
        .filter((followUpCase) => !query.patient || followUpCase.patientId === query.patient)
        .filter((followUpCase) => {
          if (words.length === 0) return true;
          const patient = patients.get(followUpCase.patientId);
          const haystack = normalized(`${followUpCase.patientId} ${patient?.name ?? ''}`);
          return words.every((word) => haystack.includes(word));
        })
        .filter((followUpCase) => {
          if (view === 'active') return ACTIVE.includes(followUpCase.status);
          if (view === 'closed') return CLOSED_STATUSES.includes(followUpCase.status);
          return true;
        })
        .filter((followUpCase) => !query.origin || followUpCase.origin === query.origin)
        .filter(
          (followUpCase) =>
            !query.assignee ||
            (followUpCase.assignee !== undefined &&
              mockOwnerId(followUpCase.assignee) === query.assignee),
        )
        .map(caseView)
        .sort((a, b) => b.priority - a.priority || a.patient.name.localeCompare(b.patient.name));
      return paginate(items, query.cursor, query.limit);
    },

    listOwners(): { items: OwnerView[] } {
      const owners = new Map<string, OwnerView>();
      for (const followUpCase of cases.values()) {
        if (!isReleased(followUpCase) || !followUpCase.assignee) continue;
        const id = mockOwnerId(followUpCase.assignee);
        const owner = owners.get(id) ?? { id, name: followUpCase.assignee, activeCases: 0 };
        if (ACTIVE.includes(followUpCase.status)) owner.activeCases += 1;
        owners.set(id, owner);
      }
      return {
        items: [...owners.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      };
    },

    listPatients(query?: string, limit = 20): { items: PatientSummary[] } {
      const words = normalized(query ?? '')
        .split(/\s+/)
        .filter(Boolean);
      return {
        items: [...patients.values()]
          .filter((patient) =>
            words.every((word) => normalized(`${patient.id} ${patient.name}`).includes(word)),
          )
          .slice(0, limit)
          .map((patient) => ({
            id: patient.id,
            name: patient.name,
            sex: patient.sex,
            ...ageOf(patient),
          })),
      };
    },

    getCase(id: string): CaseDetail {
      return caseDetail(getCaseOrThrow(id));
    },

    act,
    feedback,

    getPatient(id: string): PatientDetail {
      const patient = patients.get(id);
      if (!patient)
        throw new MockHttpError(404, 'patient_not_found', 'No encontramos ese paciente.');
      return {
        patient: {
          id: patient.id,
          name: patient.name,
          sex: patient.sex,
          ...ageOf(patient),
          contact: { ...patient.contact },
        },
        conditions: [...conditions.values()]
          .filter((condition) => condition.patientId === id)
          .sort((a, b) => (a.status === b.status ? 0 : a.status === 'probable' ? -1 : 1))
          .map(conditionView),
        expectations: [...expectations.values()]
          .filter((expectation) => expectation.patientId === id)
          .sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime())
          .map((expectation) => ({
            id: expectation.id,
            ruleId: expectation.ruleId,
            layer: expectation.layer,
            label: expectation.label,
            status: expectation.status,
            dueAt: expectation.dueAt.toISOString(),
            ...(expectation.evidence ? { evidence: { ...expectation.evidence } } : {}),
          })),
        qualityFindings: findings
          .filter((finding) => finding.patientId === id)
          .map((finding) => ({
            id: finding.id,
            code: 'note_without_plan' as const,
            documentId: finding.documentId,
            at: finding.at.toISOString(),
            label: 'Nota sin plan de seguimiento',
          })),
      };
    },

    reviewCondition,

    listRecovery(query: { cursor?: string; limit?: number }): RecoveryPage {
      const items = [...cases.values()]
        .filter((followUpCase) => !isReleased(followUpCase) && ACTIVE.includes(followUpCase.status))
        .map(caseView)
        .sort((a, b) => b.priority - a.priority);
      return paginate(items, query.cursor, query.limit);
    },

    clinic(): ClinicInfo {
      return { id: 'clinic-mock', name: CLINIC_NAME };
    },

    stats(): InboxStats {
      const active = [...cases.values()].filter(
        (followUpCase) => isReleased(followUpCase) && ACTIVE.includes(followUpCase.status),
      );
      const byLayer = Object.fromEntries(LAYERS.map((layer) => [layer, 0])) as Record<
        Layer,
        number
      >;
      const byStatus: Record<string, number> = {};
      for (const followUpCase of active) {
        byStatus[followUpCase.status] = (byStatus[followUpCase.status] ?? 0) + 1;
        const layers = new Set(
          followUpCase.expectationIds
            .map((id) => expectations.get(id)?.layer)
            .filter((layer): layer is Layer => layer !== undefined),
        );
        for (const layer of layers) byLayer[layer] += 1;
      }
      const rated = [...cases.values()].filter((followUpCase) => followUpCase.feedback);
      const total = BASELINE_FEEDBACK.total + rated.length;
      const useful =
        BASELINE_FEEDBACK.useful +
        rated.filter((followUpCase) => followUpCase.feedback?.useful).length;
      const calls = BASELINE_LLM.calls + llmCalls.length;
      const monthCostUsd =
        BASELINE_LLM.costUsd + llmCalls.reduce((sum, call) => sum + call.costUsd, 0);
      return {
        activeCases: active.length,
        byLayer,
        byStatus,
        feedback: { total, usefulRate: total === 0 ? 0 : useful / total },
        llm: {
          monthCostUsd: Number(monthCostUsd.toFixed(4)),
          calls,
          avgCostPerNoteUsd: calls === 0 ? 0 : Number((monthCostUsd / calls).toFixed(6)),
          provider: 'meta',
          model: MOCK_MODEL,
        },
      };
    },

    clock(): { now: string; fake: boolean } {
      return { now: now.toISOString(), fake: true };
    },

    advance(days: number): { now: string } {
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new MockHttpError(422, 'invalid_days', 'Indica entre 1 y 365 días.');
      }
      now = addDays(now, days);
      releaseBackfill();
      wakeSnoozed();
      runWatcher();
      runEscalation();
      return { now: now.toISOString() };
    },

    createConsultation,

    listWebhooks(limit = 30, type?: string): { items: WebhookDelivery[] } {
      return {
        items: webhooks
          .filter((item) => type === undefined || item.type === type)
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, limit),
      };
    },
  };
}
