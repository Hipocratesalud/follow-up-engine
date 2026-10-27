import { createReviewerMock, type ReviewerMock } from './reviewer.ts';
import {
  type ApiFieldError,
  ACTIVE_CASE_STATUSES,
  LAYERS,
  type ActorType,
  type CallOutcome,
  type CallOutcomeRequest,
  type CallTaskView,
  CALL_OUTCOMES,
  type CalibrationReportView,
  type CaseActionRequest,
  type CaseDetail,
  type CaseFeedbackView,
  type CaseListQuery,
  type CaseReasonView,
  type CaseStatus,
  type CaseView,
  type ClinicInfo,
  type ConditionView,
  type ContactAttemptStatus,
  type ContactAttemptView,
  type ContactChannel,
  type ContactOutcome,
  type CreatedExpectation,
  DISMISS_REASONS,
  type DismissReason,
  type DismissalView,
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
  type PatientExpectationView,
  type PatientSummary,
  type PriorityLabel,
  type ProtocolRef,
  type RecoveryPage,
  type Sex,
  type SuppressionView,
  type WebhookDelivery,
} from '../api/contract.ts';
import {
  DEFAULT_LOCALE,
  INTL_LOCALES,
  type Locale,
  type Messages,
  messagesFor,
} from '../i18n/index.ts';
import { type MockApiCopy, mockApiCopy } from './api-copy.ts';
import type {
  PatientQueueItem,
  PatientQueuePage,
  PatientQueueQuery,
  PlanItemReviewResponse,
} from '../api/patient-queue-contract.ts';
import type {
  PlanItemCommand,
  PlanItemCorrectionRequest,
  PlanItemView,
  PlanItemViewKind,
} from '../api/plan-item-contract.ts';
import {
  allViews,
  CORRECTED_BY_CLINICIAN,
  mockCaseGroup,
  mockPatientQueueItem,
  mockPatientQueuePage,
  mockPlanItemView,
  mockPlanKind,
  REJECTED_BY_CLINICIAN,
} from './patient-queue.ts';
import { detectNoteLanguage, extractFromNote, MOCK_MODEL } from './extraction.ts';
import { localized, type Text } from './localized.ts';
import { mockDocuments, mockNoteRef, mockWhy } from './why.ts';
import type { PatientDocumentView, ReasonWhyView } from '../api/why-contract.ts';
import {
  ASSIGNEES,
  CLINIC_NAME,
  DEFAULT_SUGGESTED_ACTION,
  mockProtocolRef,
  SEED_PATIENTS,
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
  /** Preferred language (BCP-47), as the host's `Patient.communication` states it. */
  language?: string;
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
  label: Text;
  dueAt: Date;
  status: ExpectationStatus;
  source: { resourceType: string; id: string; display: Text };
  evidence?: { quote: string; documentId: string };
  caseId?: string;
  origin: 'live' | 'backfill';
  /** Doctor's-plan items (HIP-141): a corrected kind, the review and its closure. */
  kind?: PlanItemViewKind;
  closedReason?: string;
  confirmedBy?: string;
  confirmedAt?: Date;
  correctionOf?: string;
}

interface TimelineEntry {
  at: Date;
  type: string;
  actor: { type: ActorType; id?: string };
  label: Text;
  note?: string;
}

interface MockCommunication {
  id: string;
  at: Date;
  status: string;
  outcome?: ContactOutcome;
  sender: 'host' | 'user';
  senderName?: string;
}

interface MockAttempt {
  id: string;
  attempt: number;
  channel?: ContactChannel;
  trigger: 'policy' | 'user' | 'wrong_number';
  requestedAt: Date;
  dueBy: Date;
  requestedBy?: string;
  communications: MockCommunication[];
}

interface MockSuppression {
  id: string;
  patientId: string;
  ruleId: string;
  label: Text;
  dismissReason: DismissReason;
  note?: string;
  caseId?: string;
  createdAt: Date;
  createdBy?: string;
  revokedAt?: Date;
  revokedBy?: string;
}

interface MockDismissal {
  reason: DismissReason;
  note?: string;
  by?: string;
  at: Date;
  suppressionIds: string[];
}

/** How strongly an outcome speaks for its attempt (higher wins), as the engine ranks it. */
const OUTCOME_RANK: Record<ContactOutcome, number> = {
  delivered: 1,
  read: 2,
  no_answer: 3,
  wrong_number: 4,
  replied: 5,
  booked: 6,
  declined: 6,
  treated_elsewhere: 6,
};
/** Only protocol items and the visit pattern can be stopped for one patient (as the API decides). */
function isSuppressible(layer: Layer): boolean {
  return layer === 'protocol' || layer === 'cadence';
}

const ANSWERED: readonly ContactOutcome[] = ['replied', 'booked', 'declined', 'treated_elsewhere'];
const UNREACHED: readonly ContactOutcome[] = ['wrong_number', 'no_answer'];

interface MockCase {
  contactAttempts: MockAttempt[];
  dismissal?: MockDismissal;
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

/** `{ protocol }` for a protocol layer rule id, as the API adds it; `{}` otherwise. */
function protocolOf(ruleId: string, locale: Locale): { protocol?: ProtocolRef } {
  const protocol = mockProtocolRef(ruleId, locale);
  return protocol === undefined ? {} : { protocol };
}

const CLOSED_STATUSES: readonly CaseStatus[] = ['resolved', 'dismissed', 'lost_to_follow_up'];
const ACTIVE: readonly CaseStatus[] = ACTIVE_CASE_STATUSES;

const LAYER_WEIGHT: Record<Layer, number> = {
  doctor_plan: 34,
  universal: 30,
  protocol: 22,
  cadence: 16,
};

/** The mock's escalation policy, shaped like the engine's (`afterDays` from the case opening). */
const MOCK_POLICY: readonly { action: EscalationAction; afterDays: number }[] = [
  { action: 'notify_clinic', afterDays: 7 },
  { action: 'raise_priority', afterDays: 21 },
  { action: 'escalate_to_coordinator', afterDays: 51 },
  { action: 'mark_lost_to_follow_up', afterDays: 111 },
];

/** Timeline label of the escalation step a case reached (1-based), as the API writes it. */
function escalationLabel(step: number): Text {
  const action = MOCK_POLICY[step - 1]?.action;
  return (at) =>
    action === undefined
      ? mockApiCopy(at).timeline.escalated
      : mockApiCopy(at).escalationActions[action];
}

/** Owner of a case escalated to coordination: a role, named in the request's language. */
const COORDINATION = 'coordinator';

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
  /**
   * The language of the request being answered (its `Accept-Language`):
   * every label of the next views is written in it.
   */
  setLocale(locale: Locale): void;
  now(): Date;
  clinic(): ClinicInfo;
  listCases(query: CaseListQuery): Page<CaseView>;
  listOwners(): { items: OwnerView[] };
  listPatients(query?: string, limit?: number): { items: PatientSummary[] };
  getCase(id: string): CaseDetail;
  act(id: string, request: CaseActionRequest, actorId?: string): CaseDetail;
  recordCallOutcome(id: string, request: CallOutcomeRequest, actorId?: string): CaseDetail;
  reactivateSuppression(id: string, actorId?: string): SuppressionView;
  calibration(): CalibrationReportView;
  feedback(id: string, request: FeedbackRequest, actorId?: string): CaseFeedbackView;
  getPatient(id: string): PatientDetail;
  /** The patient's documents for the "View documents" drawer (HIP-142). */
  getPatientDocuments(id: string): { items: PatientDocumentView[] };
  reviewCondition(id: string, decision: 'confirm' | 'reject'): ConditionView;
  listRecovery(query: { cursor?: string; limit?: number }): RecoveryPage;
  stats(): InboxStats;
  clock(): { now: string; fake: boolean };
  advance(days: number): { now: string };
  createConsultation(request: DemoConsultationRequest): DemoConsultationResponse;
  listWebhooks(limit?: number, type?: string): { items: WebhookDelivery[] };
  /** The clinical reviewer's findings and flags. */
  readonly reviewer: ReviewerMock;
  /** HIP-141: one card per patient. */
  listPatientQueue(query: PatientQueueQuery): PatientQueuePage;
  getPatientCard(patientId: string): PatientQueueItem;
  requestPatientContact(patientId: string, note?: string, actorId?: string): PatientQueueItem;
  reviewPlanItem(
    expectationId: string,
    command: PlanItemCommand,
    correction?: PlanItemCorrectionRequest,
    actorId?: string,
  ): PlanItemReviewResponse;
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
  const suppressions = new Map<string, MockSuppression>();
  const counters = {
    patient: 0,
    doc: 0,
    exp: 0,
    case: 0,
    cond: 0,
    finding: 0,
    attempt: 0,
    comm: 0,
    sup: 0,
  };
  let locale: Locale = DEFAULT_LOCALE;
  const reviewer = createReviewerMock(
    () => now,
    () => locale,
  );

  /** A stored label in the request's language. */
  function say(text: Text): string {
    return text(locale);
  }
  /** The inbox catalog of the request's language (enumerated labels the API shares). */
  function ui(): Messages {
    return messagesFor(locale);
  }
  /** The mock API's own copy in the request's language. */
  function api(): MockApiCopy {
    return mockApiCopy(locale);
  }
  /** Text from the mock API's copy, resolved when a view is built. */
  function apiText(render: (copy: MockApiCopy) => string): Text {
    return (at) => render(mockApiCopy(at));
  }
  /** An owner's display name: people as they are, roles in the request's language. */
  function ownerName(assignee: string): string {
    if (assignee === ASSIGNEES.reception) return api().people.frontDesk;
    if (assignee === COORDINATION) return api().people.coordinator;
    return assignee;
  }
  /** Owner ids as the API's (`front_desk`, `dra-lucia-paredes`). */
  function ownerId(assignee: string): string {
    return assignee === ASSIGNEES.reception || assignee === COORDINATION
      ? assignee
      : mockOwnerId(assignee);
  }

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
      // The synthetic clinic's patients speak Spanish (Venezuela).
      language: 'es-VE',
      contact: {
        allowed: !(seed.contact?.optedOut ?? false),
        optedOut: seed.contact?.optedOut ?? false,
        ...(seed.contact?.lastContactDaysAgo === undefined
          ? {}
          : { lastContactAt: addDays(now, -seed.contact.lastContactDaysAgo).toISOString() }),
        ...(seed.contact?.wrongNumberDaysAgo === undefined
          ? {}
          : {
              contactDataInvalid: true,
              contactFlag: {
                issue: 'wrong_number' as const,
                label: '',
                raisedAt: addDays(now, -seed.contact.wrongNumberDaysAgo).toISOString(),
                channel: 'whatsapp' as const,
              },
            }),
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
        label: localized(reason.label),
        dueAt: addDays(now, -reason.overdueDays),
        status: caseId ? (closed ? 'fulfilled' : 'expired') : 'open',
        source: {
          resourceType: reason.source.resourceType,
          id:
            reason.source.resourceType === 'DocumentReference' && documentId
              ? documentId
              : `${reason.source.resourceType.toLowerCase()}-${id}`,
          display: localized(reason.source.display),
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
        label: localized(past.label),
        dueAt: addDays(now, -past.daysAgo),
        status: past.status,
        source: {
          resourceType: 'ServiceRequest',
          id: `servicerequest-${id}`,
          display: localized(past.label),
        },
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
      label: (at: Locale) =>
        mockApiCopy(at).timeline.opened(firstReason ? firstReason.label[at] : ''),
    });
    for (const reason of seed.reasons.slice(1)) {
      timeline.push({
        at: addDays(now, -Math.max(0, reason.overdueDays - 1)),
        type: 'reason_added',
        actor: { type: 'rule', id: reason.ruleId },
        label: (at: Locale) => mockApiCopy(at).timeline.reasonAdded(reason.label[at]),
      });
    }
    if (caseSeed.origin === 'backfill') {
      timeline.push({
        at: addDays(now, -Math.max(0, maxOverdue - 1)),
        type: 'backfill_found',
        actor: { type: 'system' },
        label: apiText((copy) => copy.timeline.backfillFound),
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
        label: escalationLabel(step),
      });
    }
    const lastContact = patients.get(patientId)?.contact.lastContactAt;
    if (caseSeed.status === 'notified' && lastContact) {
      timeline.push({
        at: new Date(lastContact),
        type: 'patient_contact_requested',
        actor: { type: 'user', id: seed.assignee },
        label: apiText((copy) => copy.timeline.contactRequested),
      });
    }
    let snoozedUntil: Date | undefined;
    if (caseSeed.status === 'snoozed' && caseSeed.snoozeDays) {
      snoozedUntil = addDays(now, caseSeed.snoozeDays);
      timeline.push({
        at: addDays(now, -2),
        type: 'snoozed',
        actor: { type: 'user', id: seed.assignee },
        label: apiText((copy) =>
          copy.timeline.snoozedAtPatientRequest((caseSeed.snoozeDays ?? 0) + 2),
        ),
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
            ? apiText((copy) => copy.timeline.resolvedAttended)
            : caseSeed.status === 'dismissed'
              ? (at: Locale) =>
                  mockApiCopy(at).timeline.dismissedBecause(
                    messagesFor(at).labels.dismissReasons[
                      caseSeed.dismissal?.reason ?? 'already_done'
                    ],
                  )
              : apiText((copy) => copy.timeline.lostToFollowUp),
      });
    }
    if (caseSeed.feedback) {
      timeline.push({
        at: addDays(now, -1),
        type: 'feedback_recorded',
        actor: { type: 'user', id: seed.assignee },
        label: apiText((copy) =>
          caseSeed.feedback?.useful === true ? copy.timeline.useful : copy.timeline.notUseful,
        ),
      });
    }
    timeline.sort((a, b) => a.at.getTime() - b.at.getTime());

    const contactAttempts: MockAttempt[] = (caseSeed.contact ?? []).map((seedAttempt, index) => {
      const requestedAt = addDays(now, -seedAttempt.daysAgo);
      timeline.push({
        at: requestedAt,
        type: 'patient_contact_requested',
        actor:
          seedAttempt.trigger === 'user'
            ? { type: 'user', id: seed.assignee }
            : { type: 'system', id: 'default_v2' },
        label: (at: Locale) =>
          seedAttempt.channel === 'phone_call'
            ? mockApiCopy(at).timeline.call
            : mockApiCopy(at).timeline.contactRequestedVia(
                seedAttempt.channel
                  ? messagesFor(at).labels.channels[seedAttempt.channel]
                  : messagesFor(at).labels.hostChannel,
              ),
      });
      return {
        id: nextId('attempt', 'cr'),
        attempt: index + 1,
        ...(seedAttempt.channel ? { channel: seedAttempt.channel } : {}),
        trigger: seedAttempt.trigger ?? 'policy',
        requestedAt,
        dueBy: addDays(requestedAt, seedAttempt.windowDays),
        ...(seedAttempt.trigger === 'user' ? { requestedBy: seed.assignee } : {}),
        communications: (seedAttempt.outcomes ?? []).map((reported) => {
          const at = addDays(now, -reported.daysAgo);
          timeline.push({
            at,
            type: 'contact_outcome_recorded',
            actor: { type: 'patient' },
            label: (at: Locale) =>
              mockApiCopy(at).timeline.contactOutcome(
                messagesFor(at).labels.contactOutcomes[reported.outcome],
              ),
          });
          return {
            id: nextId('comm', 'comm'),
            at,
            status: UNREACHED.includes(reported.outcome) ? 'not-done' : 'completed',
            outcome: reported.outcome,
            sender: reported.sender ?? 'host',
          };
        }),
      };
    });
    timeline.sort((a, b) => a.at.getTime() - b.at.getTime());
    let dismissal: MockDismissal | undefined;
    if (caseSeed.status === 'dismissed' && caseSeed.dismissal) {
      const at = timeline.find((entry) => entry.type === 'dismissed')?.at ?? addDays(now, -1);
      const suppressionIds: string[] = [];
      if (caseSeed.dismissal.suppress) {
        for (const expectationId of expectationIds) {
          const expectation = expectations.get(expectationId);
          if (!expectation || !isSuppressible(expectation.layer)) continue;
          const id = nextId('sup', 'sup');
          suppressions.set(id, {
            id,
            patientId,
            ruleId: expectation.ruleId,
            label: expectation.label,
            dismissReason: caseSeed.dismissal.reason,
            ...(caseSeed.dismissal.note ? { note: caseSeed.dismissal.note } : {}),
            caseId,
            createdAt: at,
            createdBy: seed.assignee,
          });
          suppressionIds.push(id);
        }
      }
      dismissal = {
        reason: caseSeed.dismissal.reason,
        ...(caseSeed.dismissal.note ? { note: caseSeed.dismissal.note } : {}),
        by: seed.assignee,
        at,
        suppressionIds,
      };
    }

    const step = caseSeed.escalationStep;
    const nextDelay = ESCALATION_DELAYS_DAYS[step];
    cases.set(caseId, {
      contactAttempts,
      ...(dismissal ? { dismissal } : {}),
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
      ruleVersion: mockProtocolRef(expectation.ruleId, locale)?.version ?? '1.0.0',
      layer: expectation.layer,
      label: say(expectation.label),
      ...protocolOf(expectation.ruleId, locale),
      dueAt: expectation.dueAt.toISOString(),
      overdueDays: Math.max(0, daysBetween(expectation.dueAt, now)),
      suppressible: isSuppressible(expectation.layer),
      source: { ...expectation.source, display: say(expectation.source.display) },
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
      ...planItemField(expectation),
    };
  }

  function planKindOf(expectation: MockExpectation): PlanItemViewKind {
    return expectation.kind ?? mockPlanKind(expectation.ruleId);
  }

  function planItemField(expectation: MockExpectation): { planItem?: PlanItemView } {
    const planItem = mockPlanItemView(expectation, (kind) => ui().labels.planKinds[kind]);
    return planItem === undefined ? {} : { planItem };
  }

  function expectationView(expectation: MockExpectation): PatientExpectationView {
    const copy = api().patientQueue;
    const closedLabel =
      expectation.closedReason === CORRECTED_BY_CLINICIAN
        ? copy.correctedByClinician
        : expectation.closedReason === REJECTED_BY_CLINICIAN
          ? copy.rejectedByClinician
          : undefined;
    return {
      id: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: say(expectation.label),
      ...protocolOf(expectation.ruleId, locale),
      status: expectation.status,
      dueAt: expectation.dueAt.toISOString(),
      ...(closedLabel === undefined ? {} : { closedReason: closedLabel }),
      ...(expectation.evidence ? { evidence: { ...expectation.evidence } } : {}),
      ...planItemField(expectation),
      why: whyOf(expectation),
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
    if (!patient) throw new MockHttpError(500, 'patient_missing', api().errors.patientMissing);
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
      suggestedAction: (SUGGESTED_ACTIONS[topRule] ?? DEFAULT_SUGGESTED_ACTION)[locale],
      patientContact: contactView(patient),
      ...(followUpCase.assignee
        ? {
            assignee: ownerName(followUpCase.assignee),
            assigneeId: ownerId(followUpCase.assignee),
          }
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
          label: api().escalationSteps[step.action],
          afterDays: step.afterDays,
          ...(detail && index < current ? { outcome: 'done' as const } : {}),
          ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString() } : {}),
        };
      }),
      ...(active && nextStep && followUpCase.nextActionAt && isReleased(followUpCase)
        ? {
            next: {
              action: nextStep.action,
              label: api().escalationSteps[nextStep.action],
              at: followUpCase.nextActionAt.toISOString(),
            },
          }
        : {}),
    };
  }

  /** The patient's contact status, its flag labelled in the request's language. */
  function contactView(patient: MockPatient): PatientContact {
    const { contactFlag, ...contact } = patient.contact;
    return contactFlag
      ? { ...contact, contactFlag: { ...contactFlag, label: ui().labels.contactFlag } }
      : contact;
  }

  function ageOf(patient: MockPatient): { age?: number } {
    return patient.age === undefined ? {} : { age: patient.age };
  }

  /** The mock "Why this?" of an expectation (HIP-142). */
  function whyOf(expectation: MockExpectation): ReasonWhyView {
    const note = expectation.evidence
      ? documents.get(expectation.evidence.documentId)
      : [...documents.values()]
          .filter((document) => document.patientId === expectation.patientId)
          .sort((a, b) => b.authoredAt.getTime() - a.authoredAt.getTime())[0];
    const protocol = mockProtocolRef(expectation.ruleId, locale);
    const condition = [...conditions.values()].find(
      (candidate) =>
        candidate.patientId === expectation.patientId && candidate.status === 'confirmed',
    );
    return mockWhy({
      locale,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      dueAt: expectation.dueAt,
      source: { ...expectation.source, display: say(expectation.source.display) },
      ...(note === undefined ? {} : { note }),
      ...(expectation.evidence === undefined
        ? {}
        : {
            quote: expectation.evidence.quote,
            ...(note === undefined
              ? {}
              : { noteExcerpt: excerptAround(note.text, expectation.evidence.quote) }),
          }),
      ...(protocol === undefined ? {} : { protocol }),
      ...(condition === undefined
        ? {}
        : { condition: { id: condition.id, code: condition.code, display: condition.display } }),
    });
  }

  function caseDetail(followUpCase: MockCase): CaseDetail {
    const view = caseView(followUpCase);
    return {
      ...view,
      reasons: view.reasons.map((reason) => {
        const expectation = expectations.get(reason.expectationId);
        return expectation === undefined ? reason : { ...reason, why: whyOf(expectation) };
      }),
      escalation: escalationView(followUpCase, true),
      timeline: [...followUpCase.timeline]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .map((entry) => ({
          at: entry.at.toISOString(),
          type: entry.type,
          actor:
            entry.actor.id === undefined
              ? { ...entry.actor }
              : { ...entry.actor, id: ownerName(entry.actor.id) },
          label: say(entry.label),
          ...(entry.note ? { note: entry.note } : {}),
        })),
      ...(followUpCase.feedback ? { feedback: { ...followUpCase.feedback } } : {}),
      contactAttempts: followUpCase.contactAttempts.map((attempt) =>
        attemptView(followUpCase, attempt),
      ),
      ...callTaskOf(followUpCase),
      ...(followUpCase.dismissal ? { dismissal: dismissalView(followUpCase.dismissal) } : {}),
    };
  }

  function bestOutcome(attempt: MockAttempt): MockCommunication | undefined {
    let best: MockCommunication | undefined;
    for (const communication of attempt.communications) {
      if (!communication.outcome) continue;
      if (!best?.outcome || OUTCOME_RANK[communication.outcome] >= OUTCOME_RANK[best.outcome]) {
        best = communication;
      }
    }
    return best;
  }

  function attemptStatus(followUpCase: MockCase, attempt: MockAttempt): ContactAttemptStatus {
    const outcome = bestOutcome(attempt)?.outcome;
    if (outcome && ANSWERED.includes(outcome)) return 'answered';
    if (outcome && UNREACHED.includes(outcome)) return 'unreached';
    if (!ACTIVE.includes(followUpCase.status)) return 'closed';
    if (attempt.channel === 'phone_call') return 'pending_call';
    return attempt.dueBy.getTime() <= now.getTime() ? 'unanswered' : 'waiting';
  }

  function attemptView(followUpCase: MockCase, attempt: MockAttempt): ContactAttemptView {
    const best = bestOutcome(attempt);
    const status = attemptStatus(followUpCase, attempt);
    return {
      id: attempt.id,
      attempt: attempt.attempt,
      ...(attempt.channel ? { channel: attempt.channel } : {}),
      channelLabel: attempt.channel
        ? ui().labels.channels[attempt.channel]
        : ui().labels.hostChannel,
      trigger: attempt.trigger,
      requestedAt: attempt.requestedAt.toISOString(),
      dueBy: attempt.dueBy.toISOString(),
      ...(attempt.requestedBy ? { requestedBy: attempt.requestedBy } : {}),
      status,
      statusLabel: ui().labels.attemptStatuses[status],
      ...(best?.outcome
        ? {
            outcome: best.outcome,
            outcomeLabel: ui().labels.contactOutcomes[best.outcome],
            outcomeAt: best.at.toISOString(),
          }
        : {}),
      communications: attempt.communications.map((communication) => ({
        id: communication.id,
        at: communication.at.toISOString(),
        status: communication.status,
        ...(communication.outcome
          ? {
              outcome: communication.outcome,
              outcomeLabel: ui().labels.contactOutcomes[communication.outcome],
            }
          : {}),
        sender: communication.sender,
        ...(communication.senderName ? { senderName: communication.senderName } : {}),
      })),
    };
  }

  function pendingCall(followUpCase: MockCase): MockAttempt | undefined {
    if (!ACTIVE.includes(followUpCase.status)) return undefined;
    return [...followUpCase.contactAttempts]
      .reverse()
      .find((attempt) => attempt.channel === 'phone_call' && !bestOutcome(attempt));
  }

  function callTaskOf(followUpCase: MockCase): { callTask?: CallTaskView } {
    const call = pendingCall(followUpCase);
    if (!call) return {};
    return {
      callTask: {
        requestId: call.id,
        dueBy: call.dueBy.toISOString(),
        overdue: call.dueBy.getTime() < now.getTime(),
        trigger: call.trigger,
        outcomes: CALL_OUTCOMES.map((outcome) => ({
          outcome,
          label: ui().labels.callOutcomes[outcome],
        })),
      },
    };
  }

  function suppressionView(suppression: MockSuppression): SuppressionView {
    return {
      id: suppression.id,
      ruleId: suppression.ruleId,
      label: say(suppression.label),
      dismissReason: suppression.dismissReason,
      dismissReasonLabel: ui().labels.dismissReasons[suppression.dismissReason],
      ...(suppression.note ? { note: suppression.note } : {}),
      ...(suppression.caseId ? { caseId: suppression.caseId } : {}),
      createdAt: suppression.createdAt.toISOString(),
      ...(suppression.createdBy ? { createdBy: suppression.createdBy } : {}),
      active: suppression.revokedAt === undefined,
      ...(suppression.revokedAt ? { revokedAt: suppression.revokedAt.toISOString() } : {}),
      ...(suppression.revokedBy ? { revokedBy: suppression.revokedBy } : {}),
    };
  }

  function dismissalView(dismissal: MockDismissal): DismissalView {
    return {
      reason: dismissal.reason,
      reasonLabel: ui().labels.dismissReasons[dismissal.reason],
      ...(dismissal.note ? { note: dismissal.note } : {}),
      ...(dismissal.by ? { by: dismissal.by } : {}),
      at: dismissal.at.toISOString(),
      suppressions: dismissal.suppressionIds.flatMap((id) => {
        const suppression = suppressions.get(id);
        return suppression ? [suppressionView(suppression)] : [];
      }),
    };
  }

  function getCaseOrThrow(id: string): MockCase {
    const followUpCase = cases.get(id);
    if (!followUpCase) throw new MockHttpError(404, 'case_not_found', api().errors.caseNotFound);
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
    // One case per patient and case group, as the engine groups them.
    const group = mockCaseGroup(expectation.ruleId);
    const existing = [...cases.values()].find(
      (candidate) =>
        candidate.patientId === expectation.patientId &&
        ACTIVE.includes(candidate.status) &&
        isReleased(candidate) &&
        candidate.expectationIds.some(
          (id) => mockCaseGroup(expectations.get(id)?.ruleId ?? '') === group,
        ),
    );
    expectation.status = 'expired';
    if (existing) {
      existing.expectationIds.push(expectation.id);
      expectation.caseId = existing.id;
      existing.timeline.push({
        at: expectation.dueAt,
        type: 'reason_added',
        actor: { type: 'rule', id: expectation.ruleId },
        label: (at: Locale) => mockApiCopy(at).timeline.reasonAdded(expectation.label(at)),
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
      contactAttempts: [],
      timeline: [
        {
          at: expectation.dueAt,
          type: 'opened',
          actor: { type: 'rule', id: expectation.ruleId },
          label: (at: Locale) => mockApiCopy(at).timeline.opened(expectation.label(at)),
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
        label: apiText((copy) => copy.timeline.released),
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
        label: apiText((copy) => copy.timeline.reopened),
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
            label: apiText((copy) => copy.timeline.lostToFollowUp),
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
          label: escalationLabel(followUpCase.escalationStep),
        });
        emit('case.escalated', webhookCasePayload(followUpCase), at);
      }
    }
  }

  // ---------------------------------------------------------------- commands

  function act(id: string, request: CaseActionRequest, actorId = 'Dra. Lucía Paredes'): CaseDetail {
    const followUpCase = getCaseOrThrow(id);
    if (!ACTIVE.includes(followUpCase.status)) {
      throw new MockHttpError(
        409,
        'invalid_transition',
        api().errors.cannotChange(followUpCase.status === 'resolved'),
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
            api().errors.contactNotAllowed,
          );
        }
        followUpCase.status = 'notified';
        followUpCase.nextActionAt = addDays(now, ESCALATION_DELAYS_DAYS[0]);
        patient.contact.lastContactAt = now.toISOString();
        followUpCase.contactAttempts.push({
          id: nextId('attempt', 'cr'),
          attempt: followUpCase.contactAttempts.length + 1,
          trigger: 'user',
          requestedAt: now,
          dueBy: addDays(now, 7),
          requestedBy: actorId,
          communications: [],
        });
        followUpCase.timeline.push({
          at: now,
          type: 'patient_contact_requested',
          actor: { type: 'user', id: actorId },
          label: apiText((copy) => copy.timeline.contactRequested),
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
            api().errors.snoozeDays(MAX_SNOOZE_DAYS),
          );
        }
        followUpCase.status = 'snoozed';
        followUpCase.snoozedUntil = addDays(now, days);
        delete followUpCase.nextActionAt;
        followUpCase.timeline.push({
          at: now,
          type: 'snoozed',
          actor: { type: 'user', id: actorId },
          label: apiText((copy) => copy.timeline.snoozed(days)),
          ...withNote,
        });
        emit('case.snoozed', webhookCasePayload(followUpCase));
        break;
      }
      case 'dismiss': {
        const reason = validateDismissal(followUpCase, request, note);
        followUpCase.status = 'dismissed';
        delete followUpCase.nextActionAt;
        delete followUpCase.snoozedUntil;
        const suppressionIds: string[] = [];
        for (const expectationId of followUpCase.expectationIds) {
          const expectation = expectations.get(expectationId);
          if (!expectation) continue;
          expectation.status = 'cancelled';
          if (!request.suppress || !isSuppressible(expectation.layer)) continue;
          const active = [...suppressions.values()].find(
            (candidate) =>
              candidate.patientId === followUpCase.patientId &&
              candidate.ruleId === expectation.ruleId &&
              !candidate.revokedAt,
          );
          if (active) {
            suppressionIds.push(active.id);
            continue;
          }
          const id = nextId('sup', 'sup');
          suppressions.set(id, {
            id,
            patientId: followUpCase.patientId,
            ruleId: expectation.ruleId,
            label: expectation.label,
            dismissReason: reason,
            ...withNote,
            caseId: followUpCase.id,
            createdAt: now,
            createdBy: actorId,
          });
          suppressionIds.push(id);
        }
        followUpCase.dismissal = { reason, ...withNote, by: actorId, at: now, suppressionIds };
        followUpCase.timeline.push({
          at: now,
          type: 'dismissed',
          actor: { type: 'user', id: actorId },
          label: (at: Locale) =>
            mockApiCopy(at).timeline.dismissedBecause(
              messagesFor(at).labels.dismissReasons[reason],
            ),
          ...withNote,
        });
        emit('case.dismissed', webhookCasePayload(followUpCase));
        break;
      }
      case 'resolve': {
        followUpCase.status = 'resolved';
        delete followUpCase.nextActionAt;
        delete followUpCase.snoozedUntil;
        for (const expectationId of followUpCase.expectationIds) {
          const expectation = expectations.get(expectationId);
          if (expectation) expectation.status = 'fulfilled';
        }
        followUpCase.timeline.push({
          at: now,
          type: followUpCase.status,
          actor: { type: 'user', id: actorId },
          label: apiText((copy) => copy.timeline.resolvedByTeam),
          ...withNote,
        });
        emit(`case.${followUpCase.status}`, webhookCasePayload(followUpCase));
        break;
      }
    }
    return caseDetail(followUpCase);
  }

  /** The API's 422 for a dismissal: a reason always, a note for "Otro motivo". */
  function validateDismissal(
    followUpCase: MockCase,
    request: CaseActionRequest,
    note: string | undefined,
  ): DismissReason {
    const reason = DISMISS_REASONS.find((candidate) => candidate === request.reason);
    if (!reason) {
      const message = ui().validation.dismissReasonRequired;
      throw new MockHttpError(422, 'invalid_request', message, [{ path: 'reason', message }]);
    }
    if (reason === 'other' && !note) {
      const message = ui().validation.dismissNoteRequired;
      throw new MockHttpError(422, 'invalid_request', message, [{ path: 'note', message }]);
    }
    if (request.suppress && reason !== 'not_applicable_to_patient') {
      const message = ui().validation.suppressOnlyNotApplicable;
      throw new MockHttpError(422, 'invalid_request', message, [{ path: 'suppress', message }]);
    }
    const suppressible = followUpCase.expectationIds.some((id) => {
      const expectation = expectations.get(id);
      return expectation !== undefined && isSuppressible(expectation.layer);
    });
    if (request.suppress && !suppressible) {
      const message = ui().validation.nothingToSuppress;
      throw new MockHttpError(422, 'invalid_request', message, [{ path: 'suppress', message }]);
    }
    return reason;
  }

  function recordCallOutcome(
    id: string,
    request: CallOutcomeRequest,
    actorId = 'Dra. Lucía Paredes',
  ): CaseDetail {
    const followUpCase = getCaseOrThrow(id);
    if (!ACTIVE.includes(followUpCase.status)) {
      throw new MockHttpError(409, 'invalid_transition', ui().validation.caseClosed);
    }
    const call = request.requestId
      ? followUpCase.contactAttempts.find(
          (attempt) => attempt.id === request.requestId && attempt.channel === 'phone_call',
        )
      : pendingCall(followUpCase);
    if (!call) {
      throw new MockHttpError(404, 'not_found', ui().validation.noPendingCall);
    }
    const outcome: CallOutcome = request.outcome;
    call.communications.push({
      id: nextId('comm', 'comm'),
      at: now,
      status: UNREACHED.includes(outcome) ? 'not-done' : 'completed',
      outcome,
      sender: 'user',
      senderName: actorId,
    });
    followUpCase.timeline.push({
      at: now,
      type: 'contact_outcome_recorded',
      actor: { type: 'user', id: actorId },
      label: (at: Locale) =>
        mockApiCopy(at).timeline.callOutcome(messagesFor(at).labels.callOutcomes[outcome]),
    });
    const patient = patients.get(followUpCase.patientId);
    if (patient && ANSWERED.includes(outcome)) {
      delete patient.contact.contactFlag;
      patient.contact.contactDataInvalid = false;
    }
    if (patient && outcome === 'wrong_number') {
      patient.contact.contactDataInvalid = true;
      patient.contact.contactFlag = {
        issue: 'wrong_number',
        label: '',
        raisedAt: now.toISOString(),
        channel: 'phone_call',
      };
    }
    if (outcome === 'treated_elsewhere' || outcome === 'declined') {
      followUpCase.status = 'resolved';
      delete followUpCase.nextActionAt;
      delete followUpCase.snoozedUntil;
      followUpCase.timeline.push({
        at: now,
        type: 'resolved',
        actor: { type: 'user', id: actorId },
        label: apiText((copy) =>
          outcome === 'declined'
            ? copy.timeline.resolvedDeclined
            : copy.timeline.resolvedTreatedElsewhere,
        ),
      });
      emit('case.resolved', webhookCasePayload(followUpCase));
    }
    emit('contact.outcome_recorded', {
      caseId: followUpCase.id,
      patientId: followUpCase.patientId,
      requestId: call.id,
      channel: 'phone_call',
      outcome,
    });
    return caseDetail(followUpCase);
  }

  function reactivateSuppression(id: string, actorId = 'Dra. Lucía Paredes'): SuppressionView {
    const suppression = suppressions.get(id);
    if (!suppression || suppression.revokedAt) {
      throw new MockHttpError(404, 'not_found', ui().validation.suppressionAlreadyActive);
    }
    suppression.revokedAt = now;
    suppression.revokedBy = actorId;
    return suppressionView(suppression);
  }

  function calibration(): CalibrationReportView {
    const rules = new Map<string, CalibrationReportView['rules'][number]>();
    for (const followUpCase of cases.values()) {
      for (const expectationId of followUpCase.expectationIds) {
        const expectation = expectations.get(expectationId);
        if (!expectation) continue;
        const rule = rules.get(expectation.ruleId) ?? {
          ruleId: expectation.ruleId,
          label: say(expectation.label),
          layer: expectation.layer,
          casesWithFeedback: 0,
          useful: 0,
          notUseful: 0,
          dismissals: Object.fromEntries(DISMISS_REASONS.map((reason) => [reason, 0])) as Record<
            DismissReason,
            number
          >,
          notUsefulReasons: {},
        };
        if (followUpCase.dismissal) rule.dismissals[followUpCase.dismissal.reason] += 1;
        const verdict = followUpCase.feedback;
        const notUseful = followUpCase.dismissal !== undefined || verdict?.useful === false;
        if (verdict || followUpCase.dismissal) {
          rule.casesWithFeedback += 1;
          if (notUseful) rule.notUseful += 1;
          else rule.useful += 1;
          rule.usefulRate = rule.useful / rule.casesWithFeedback;
        }
        rules.set(expectation.ruleId, rule);
      }
    }
    return {
      rules: [...rules.values()].filter(
        (rule) => rule.casesWithFeedback > 0 || Object.values(rule.dismissals).some(Boolean),
      ),
    };
  }

  function feedback(
    id: string,
    request: FeedbackRequest,
    actorId = 'Dra. Lucía Paredes',
  ): CaseFeedbackView {
    const followUpCase = getCaseOrThrow(id);
    if (!request.useful && !request.reason) {
      throw new MockHttpError(422, 'feedback_reason_required', api().errors.feedbackReasonRequired);
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
      label: apiText((copy) => (request.useful ? copy.timeline.useful : copy.timeline.notUseful)),
    });
    return value;
  }

  function conditionView(condition: MockCondition): ConditionView {
    return {
      id: condition.id,
      code: condition.code,
      // Named like the API: from its ICD-10 table, in the request's language.
      display: api().conditionNames[condition.code] ?? condition.display,
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
      throw new MockHttpError(404, 'condition_not_found', api().errors.conditionNotFound);
    }
    if (condition.status !== 'probable') {
      throw new MockHttpError(409, 'condition_not_probable', api().errors.conditionReviewed);
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
      label: say(fields.label),
      ...protocolOf(fields.ruleId, locale),
      dueAt: fields.dueAt.toISOString(),
    };
  }

  function createConsultation(request: DemoConsultationRequest): DemoConsultationResponse {
    const text = request.noteText.trim();
    if (text.length < 20) {
      throw new MockHttpError(422, 'note_too_short', api().errors.noteTooShort);
    }
    let patient = request.patientId ? patients.get(request.patientId) : undefined;
    if (request.patientId && !patient) {
      throw new MockHttpError(404, 'patient_not_found', api().errors.patientNotFound);
    }
    if (!patient) {
      const name = request.patientName?.trim();
      if (!name) {
        throw new MockHttpError(422, 'patient_required', api().errors.patientRequired);
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
    const noteLanguage = detectNoteLanguage(text);
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
          label: (at: Locale) =>
            mockApiCopy(at).demo.resultPending(
              messagesFor(at).consultation.labs[order.loinc] ?? order.display,
            ),
          dueAt: addDays(now, 21),
          source: {
            resourceType: 'ServiceRequest',
            id: `sr-${order.loinc}-${documentId}`,
            display: (at: Locale) =>
              messagesFor(at).consultation.labs[order.loinc] ?? order.display,
          },
        }),
      );
    }
    for (const item of extracted.planItems) {
      created.push(
        createExpectation(patientId, {
          ruleId: `doctor_plan_${item.kind}`,
          layer: 'doctor_plan',
          label: apiText((copy) => copy.demo.plan[item.kind]),
          dueAt: new Date(item.dueAt),
          source: {
            resourceType: 'DocumentReference',
            id: documentId,
            display: apiText((copy) => copy.demo.note),
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
          label: (at: Locale) =>
            mockApiCopy(at).demo.nextVisit(
              messagesFor(at).labels.specialties[specialty].toLocaleLowerCase(INTL_LOCALES[at]),
            ),
          dueAt: addDays(now, CADENCE_DAYS[specialty]),
          source: {
            resourceType: 'Encounter',
            id: `enc-${documentId}`,
            display: apiText((copy) => copy.demo.todayVisit),
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
          ruleId: 'protocol_diabetes_hba1c',
          layer: 'protocol',
          label: apiText((copy) => copy.demo.hba1c),
          dueAt: addDays(now, 90),
          source: {
            resourceType: 'PlanDefinition',
            id: 'protocol-dm2',
            display: apiText((copy) => copy.demo.diabetesProtocol),
          },
        }),
      );
    }
    if (extracted.conditions.some((condition) => condition.code.code === 'D25.1')) {
      created.push(
        createExpectation(patientId, {
          ruleId: 'protocol_fibroid_ultrasound',
          layer: 'protocol',
          label: apiText((copy) => copy.demo.fibroid),
          dueAt: addDays(now, 180),
          source: {
            resourceType: 'PlanDefinition',
            id: 'protocol-fibroid',
            display: apiText((copy) => copy.demo.fibroidProtocol),
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
            content: [
              { attachment: { contentType: 'text/plain; charset=utf-8', language: noteLanguage } },
            ],
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
        conditions: extracted.conditions.map((condition) => ({
          ...condition,
          code: {
            ...condition.code,
            display: api().conditionNames[condition.code.code] ?? condition.code.display ?? '',
          },
        })),
        medications: extracted.medications,
        planItems: extracted.planItems,
        costUsd,
        latencyMs,
        noteLanguage,
      },
      expectationsCreated: created,
    };
  }

  // ------------------------------------------------- patient queue (HIP-141)

  /** One message per patient every 14 days, whatever the number of cases (the engine's window). */
  const CONTACT_WINDOW_DAYS = 14;

  /** A plan item review's timeline label, in the request's language. */
  function reviewLabel(
    key: 'planItemConfirmed' | 'planItemCorrected' | 'planItemRejected',
    kind: PlanItemViewKind,
  ): Text {
    return (at) =>
      mockApiCopy(at).patientQueue[key](
        messagesFor(at).labels.planKinds[kind].toLocaleLowerCase(INTL_LOCALES[at]),
      );
  }

  function requestPatientContact(
    patientId: string,
    note?: string,
    actorId = 'Dra. Lucía Paredes',
  ): PatientQueueItem {
    const patient = patients.get(patientId);
    const active = [...cases.values()]
      .filter(
        (followUpCase) =>
          followUpCase.patientId === patientId &&
          isReleased(followUpCase) &&
          ACTIVE.includes(followUpCase.status),
      )
      .map((followUpCase) => ({ followUpCase, view: caseView(followUpCase) }))
      .sort((left, right) => right.view.priority - left.view.priority);
    const primary = active[0];
    if (!patient || !primary) {
      throw new MockHttpError(404, 'not_found', api().patientQueue.noActiveCases);
    }
    if (!patient.contact.allowed || patient.contact.optedOut) {
      throw new MockHttpError(409, 'patient_contact_not_allowed', api().errors.contactNotAllowed);
    }
    const last = patient.contact.lastContactAt;
    if (last !== undefined && daysBetween(new Date(last), now) < CONTACT_WINDOW_DAYS) {
      throw new MockHttpError(409, 'patient_contact_not_allowed', api().patientQueue.contactWindow);
    }
    const trimmed = note?.trim();
    act(
      primary.followUpCase.id,
      { action: 'notify', ...(trimmed ? { note: trimmed } : {}) },
      actorId,
    );
    for (const { followUpCase } of active.slice(1)) {
      followUpCase.timeline.push({
        at: now,
        type: 'patient_contact_requested',
        actor: { type: 'user', id: actorId },
        label: (at: Locale) => mockApiCopy(at).patientQueue.contactRequestedForPatient,
        ...(trimmed ? { note: trimmed } : {}),
      });
      if (followUpCase.status === 'open' || followUpCase.status === 'snoozed') {
        followUpCase.status = 'notified';
        delete followUpCase.snoozedUntil;
        followUpCase.nextActionAt = addDays(now, ESCALATION_DELAYS_DAYS[0]);
      }
    }
    return getPatientCard(patientId);
  }

  function getPatientCard(patientId: string): PatientQueueItem {
    const views = [...cases.values()]
      .filter((followUpCase) => followUpCase.patientId === patientId && isReleased(followUpCase))
      .map(caseView);
    if (views.length === 0) {
      throw new MockHttpError(404, 'not_found', api().patientQueue.noActiveCases);
    }
    return mockPatientQueueItem(views);
  }

  /** Resolves the case of a plan item once none of its reasons is pending. */
  function resolveIfSatisfied(caseId: string | undefined, actorId: string): string[] {
    const followUpCase = caseId === undefined ? undefined : cases.get(caseId);
    if (!followUpCase || !ACTIVE.includes(followUpCase.status)) return [];
    const pending = followUpCase.expectationIds.some((id) => {
      const status = expectations.get(id)?.status;
      return status === 'open' || status === 'expired';
    });
    if (pending) return [];
    followUpCase.status = 'resolved';
    delete followUpCase.nextActionAt;
    followUpCase.timeline.push({
      at: now,
      type: 'resolved',
      actor: { type: 'user', id: actorId },
      label: (at: Locale) => mockApiCopy(at).patientQueue.resolvedNotNeeded,
    });
    emit('case.resolved', webhookCasePayload(followUpCase));
    return [followUpCase.id];
  }

  function reviewPlanItem(
    expectationId: string,
    command: PlanItemCommand,
    correction: PlanItemCorrectionRequest = {},
    actorId = 'Dra. Lucía Paredes',
  ): PlanItemReviewResponse {
    const expectation = expectations.get(expectationId);
    if (!expectation) {
      throw new MockHttpError(404, 'not_found', api().patientQueue.planItemNotFound);
    }
    if (expectation.layer !== 'doctor_plan') {
      const message = api().patientQueue.notAPlanItem;
      throw new MockHttpError(422, 'invalid_request', message, [
        { path: 'expectationId', message },
      ]);
    }
    if (
      expectation.closedReason === CORRECTED_BY_CLINICIAN ||
      expectation.closedReason === REJECTED_BY_CLINICIAN
    ) {
      throw new MockHttpError(409, 'conflict', api().patientQueue.alreadyReviewed);
    }
    const live = expectation.status === 'open' || expectation.status === 'expired';
    const followUpCase =
      expectation.caseId === undefined ? undefined : cases.get(expectation.caseId);
    const activeCase =
      followUpCase && ACTIVE.includes(followUpCase.status) ? followUpCase : undefined;
    if (command === 'confirm') {
      if (expectation.confirmedBy === undefined) {
        expectation.confirmedBy = actorId;
        expectation.confirmedAt = now;
        activeCase?.timeline.push({
          at: now,
          type: 'plan_item_confirmed',
          actor: { type: 'user', id: actorId },
          label: reviewLabel('planItemConfirmed', planKindOf(expectation)),
        });
      }
      return { expectation: expectationView(expectation), casesResolved: [] };
    }
    if (!live) {
      throw new MockHttpError(409, 'conflict', api().patientQueue.planItemClosed);
    }
    if (command === 'reject') {
      expectation.status = 'cancelled';
      expectation.closedReason = REJECTED_BY_CLINICIAN;
      activeCase?.timeline.push({
        at: now,
        type: 'plan_item_rejected',
        actor: { type: 'user', id: actorId },
        label: reviewLabel('planItemRejected', planKindOf(expectation)),
      });
      return {
        expectation: expectationView(expectation),
        casesResolved: resolveIfSatisfied(activeCase?.id, actorId),
      };
    }
    const kind = correction.kind ?? planKindOf(expectation);
    const dueAt =
      correction.dueDate === undefined
        ? expectation.dueAt
        : new Date(`${correction.dueDate}T12:00:00.000Z`);
    if (Number.isNaN(dueAt.getTime())) {
      throw new MockHttpError(422, 'invalid_request', api().patientQueue.invalidDueDate, [
        { path: 'dueDate', message: api().patientQueue.invalidDueDate },
      ]);
    }
    if (kind === planKindOf(expectation) && dueAt.getTime() === expectation.dueAt.getTime()) {
      const message = api().patientQueue.nothingToCorrect;
      throw new MockHttpError(422, 'invalid_request', message, [{ path: 'correction', message }]);
    }
    expectation.status = 'superseded';
    expectation.closedReason = CORRECTED_BY_CLINICIAN;
    const id = nextId('exp', 'exp');
    const joins = activeCase !== undefined && dueAt.getTime() <= now.getTime();
    const replacement: MockExpectation = {
      ...expectation,
      id,
      kind,
      dueAt,
      status: joins ? 'expired' : 'open',
      confirmedBy: actorId,
      confirmedAt: now,
      correctionOf: expectation.id,
    };
    delete replacement.closedReason;
    if (joins) {
      activeCase.expectationIds.push(id);
    } else {
      delete replacement.caseId;
    }
    expectations.set(id, replacement);
    activeCase?.timeline.push({
      at: now,
      type: 'plan_item_corrected',
      actor: { type: 'user', id: actorId },
      label: reviewLabel('planItemCorrected', kind),
    });
    return {
      expectation: expectationView(expectation),
      replacement: expectationView(replacement),
      casesResolved: joins ? [] : resolveIfSatisfied(activeCase?.id, actorId),
    };
  }

  // --------------------------------------------------------------- queries

  return {
    setLocale(next: Locale): void {
      locale = next;
    },

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
              ownerId(followUpCase.assignee) === query.assignee),
        )
        .map(caseView)
        .sort((a, b) => b.priority - a.priority || a.patient.name.localeCompare(b.patient.name));
      return paginate(items, query.cursor, query.limit);
    },

    listOwners(): { items: OwnerView[] } {
      const owners = new Map<string, OwnerView>();
      for (const followUpCase of cases.values()) {
        if (!isReleased(followUpCase) || !followUpCase.assignee) continue;
        const id = ownerId(followUpCase.assignee);
        const owner = owners.get(id) ?? {
          id,
          name: ownerName(followUpCase.assignee),
          activeCases: 0,
        };
        if (ACTIVE.includes(followUpCase.status)) owner.activeCases += 1;
        owners.set(id, owner);
      }
      return {
        items: [...owners.values()].sort((a, b) =>
          a.name.localeCompare(b.name, INTL_LOCALES[locale]),
        ),
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
    recordCallOutcome,
    reactivateSuppression,
    calibration,

    getPatient(id: string): PatientDetail {
      const patient = patients.get(id);
      if (!patient) throw new MockHttpError(404, 'patient_not_found', api().errors.patientNotFound);
      return {
        patient: {
          id: patient.id,
          name: patient.name,
          sex: patient.sex,
          ...ageOf(patient),
          contact: contactView(patient),
        },
        ...(patient.language === undefined ? {} : { language: patient.language }),
        conditions: [...conditions.values()]
          .filter((condition) => condition.patientId === id)
          .sort((a, b) => (a.status === b.status ? 0 : a.status === 'probable' ? -1 : 1))
          .map(conditionView),
        expectations: [...expectations.values()]
          .filter((expectation) => expectation.patientId === id)
          .sort((a, b) => b.dueAt.getTime() - a.dueAt.getTime())
          .map(expectationView),
        qualityFindings: findings
          .filter((finding) => finding.patientId === id)
          .map((finding) => ({
            id: finding.id,
            code: 'note_without_plan' as const,
            documentId: finding.documentId,
            at: finding.at.toISOString(),
            label: api().noteWithoutPlan,
          })),
        suppressions: [...suppressions.values()]
          .filter((suppression) => suppression.patientId === id)
          .sort(
            (a, b) =>
              Number(a.revokedAt !== undefined) - Number(b.revokedAt !== undefined) ||
              b.createdAt.getTime() - a.createdAt.getTime(),
          )
          .map(suppressionView),
      };
    },

    reviewCondition,

    getPatientDocuments(id: string): { items: PatientDocumentView[] } {
      if (!patients.has(id)) {
        throw new MockHttpError(404, 'patient_not_found', api().errors.patientNotFound);
      }
      const cited = [...expectations.values()]
        .filter((expectation) => expectation.patientId === id)
        .flatMap((expectation) => {
          const why = whyOf(expectation);
          return [
            ...(why.due.anchor === undefined ? [] : [why.due.anchor]),
            ...(why.protocol?.enrollment.evidence ?? []),
          ];
        });
      const notes = [...documents.values()]
        .filter((document) => document.patientId === id)
        .map((document) => ({ view: mockNoteRef(locale, document), text: document.text }));
      return { items: mockDocuments(cited, notes) };
    },

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
        activePatients: new Set(active.map((followUpCase) => followUpCase.patientId)).size,
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
        throw new MockHttpError(422, 'invalid_days', api().errors.invalidDays);
      }
      now = addDays(now, days);
      releaseBackfill();
      wakeSnoozed();
      runWatcher();
      runEscalation();
      return { now: now.toISOString() };
    },

    createConsultation,

    reviewer,

    listPatientQueue(query: PatientQueueQuery): PatientQueuePage {
      const views = allViews((cursor) =>
        this.listCases({
          ...(query.view === undefined ? {} : { view: query.view }),
          ...(query.origin === undefined ? {} : { origin: query.origin }),
          ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
          ...(query.q === undefined ? {} : { q: query.q }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: 200,
        }),
      );
      return mockPatientQueuePage(views, query);
    },

    getPatientCard,
    requestPatientContact,
    reviewPlanItem,

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
