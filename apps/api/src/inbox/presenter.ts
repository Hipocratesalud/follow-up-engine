import {
  CALL_OUTCOMES,
  type CaseEvent,
  type Catalog,
  type ClinicId,
  conditionId,
  type ContactCommunication,
  type ContactRequest,
  type PatientContactFlag,
  type RuleSuppression,
  summarizeAttempt,
  SUPPRESSIBLE_LAYERS,
  UNREACHED_OUTCOMES,
  type EscalationPolicy,
  type Expectation,
  type FhirResourceJson,
  type FollowUpCase,
  isActiveCaseStatus,
  isUnscheduledRelease,
  type NoteReceivedEvent,
  type PatientCondition,
  type PatientContactStatus,
  type PatientId,
  policyOf,
  practitionerId,
} from '@follow-up-engine/core';
import { taskPriority } from '@follow-up-engine/fhir';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type {
  CallTaskView,
  CaseDetail,
  CaseReasonView,
  CaseTimelineEntry,
  CaseView,
  ConditionView,
  ContactAttemptView,
  ContactFlagView,
  DismissalView,
  EscalationView,
  PatientContact,
  PatientDetail,
  PatientExpectationView,
  SuppressionView,
} from '../http/schemas.ts';
import { excerptAround, humanName, patientSummary, sourceDisplay } from './fhir-display.ts';
import {
  ATTEMPT_STATUS_LABELS,
  type AttemptStatus,
  CALL_OUTCOME_LABELS,
  channelLabel,
  closedReasonLabel,
  CONTACT_FLAG_LABEL,
  COORDINATOR_LABEL,
  DISMISS_REASON_LABELS,
  OUTCOME_LABELS,
  DEFAULT_SUGGESTED_ACTION,
  escalationStepLabel,
  eventNote,
  FRONT_DESK_LABEL,
  LAYER_FALLBACK_LABELS,
  planItemLabel,
  QUALITY_FINDING_LABELS,
  timelineLabel,
} from './labels.ts';
import { icd10Label, loincLabel } from './terminology.ts';

const MS_PER_DAY = 86_400_000;

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = DAY_FORMATS.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      });
    } catch {
      // An unknown zone in the clinic settings: count UTC days rather than fail the inbox.
      format = dayFormat('UTC');
    }
    DAY_FORMATS.set(timeZone, format);
  }
  return format;
}

/** The calendar day of `date` in `timeZone`, as a day number (days since the epoch). */
function calendarDay(date: Date, timeZone: string): number {
  const parts = dayFormat(timeZone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / MS_PER_DAY;
}

/**
 * Calendar days from `from` to `to` in the clinic's time zone: what the team
 * counts on the dates the inbox prints ("antes del 19 ene" is one day late
 * on the 20th, whatever the hour of either instant).
 */
export function calendarDaysBetween(from: Date, to: Date, timeZone: string): number {
  return calendarDay(to, timeZone) - calendarDay(from, timeZone);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

const PRIORITY_LABELS = {
  stat: 'urgente',
  asap: 'alta',
  urgent: 'media',
  routine: 'baja',
} as const;

/** Owner ids the engine uses when no practitioner is known (`EngineSettings`). */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  front_desk: FRONT_DESK_LABEL,
  coordinator: COORDINATOR_LABEL,
};

function memo<TKey, TValue>(load: (key: TKey) => Promise<TValue>): (key: TKey) => Promise<TValue> {
  const cache = new Map<TKey, Promise<TValue>>();
  return (key) => {
    let found = cache.get(key);
    if (found === undefined) {
      found = load(key);
      cache.set(key, found);
    }
    return found;
  };
}

function flagView(flag: PatientContactFlag): ContactFlagView {
  return {
    issue: flag.issue,
    label: CONTACT_FLAG_LABEL,
    raisedAt: flag.raisedAt.toISOString(),
    ...(flag.channel === undefined ? {} : { channel: flag.channel }),
  };
}

function contactView(
  status: PatientContactStatus,
  flags: readonly PatientContactFlag[] = [],
): PatientContact {
  const standing = flags.find((flag) => flag.clearedAt === undefined);
  return {
    allowed: status.allowed,
    optedOut: status.optedOut,
    ...(status.lastContactAt === undefined
      ? {}
      : { lastContactAt: status.lastContactAt.toISOString() }),
    contactDataInvalid: status.contactDataInvalid,
    ...(standing === undefined ? {} : { contactFlag: flagView(standing) }),
  };
}

/** A patient's contact attempts, their reports and contact data flags. */
interface PatientContacts {
  readonly requests: readonly ContactRequest[];
  readonly communications: readonly ContactCommunication[];
  readonly flags: readonly PatientContactFlag[];
}

export function conditionView(condition: PatientCondition): ConditionView {
  return {
    id: conditionId(condition),
    code: condition.code.code,
    display: icd10Label(condition.code.code, condition.code.display),
    status: condition.status,
    ...(condition.status === 'rejected'
      ? { rejectedBy: condition.confirmedBy === undefined ? 'host' : 'clinician' }
      : {}),
    confidence: condition.confidence,
    sourceType: condition.sourceType,
    ...(condition.evidence === undefined
      ? {}
      : {
          evidence: {
            quote: condition.evidence.quote,
            documentId: condition.evidence.sourceDocumentId,
          },
        }),
  };
}

/**
 * Hides a probable condition when the clinician already recorded or confirmed
 * one of the same ICD-10 category (the note says "DM2", the record has
 * E11.9): asking to confirm what the chart already states is noise.
 */
export function withoutConfirmedDuplicates(
  conditions: readonly PatientCondition[],
): PatientCondition[] {
  const confirmed = new Set(
    conditions
      .filter((condition) => condition.status === 'confirmed')
      .map((condition) => condition.code.code.slice(0, 3)),
  );
  return conditions.filter(
    (condition) =>
      condition.status !== 'probable' || !confirmed.has(condition.code.code.slice(0, 3)),
  );
}

/** Rules whose reason is a result that came back abnormal: the most urgent thing to act on. */
const ABNORMAL_RESULT_RULES = new Set(['abnormal_result_followup']);
/** Rules waiting for the result of an order. */
const PENDING_RESULT_RULES = new Set(['lab_order_result_pending', 'imaging_order_result_pending']);

/**
 * How actionable a reason is, lower first: an abnormal result to follow up,
 * then pending lab or imaging results, then what the doctor planned, then
 * other orders, then a break in the visit pattern, and protocol controls last
 * (guideline gaps nobody asked for yet).
 */
function actionability(expectation: Expectation): number {
  if (ABNORMAL_RESULT_RULES.has(expectation.ruleId)) {
    return 0;
  }
  if (PENDING_RESULT_RULES.has(expectation.ruleId)) {
    return 1;
  }
  switch (expectation.layer) {
    case 'doctor_plan':
      return 2;
    case 'universal':
      return 3;
    case 'cadence':
      return 4;
    case 'protocol':
      return 5;
  }
}

/** A case's reasons, most actionable first (then the longest overdue): the first one titles the case. */
export function byActionability(expectations: readonly Expectation[]): Expectation[] {
  return [...expectations].sort(
    (left, right) =>
      actionability(left) - actionability(right) ||
      left.dueAt.getTime() - right.dueAt.getTime() ||
      left.id.localeCompare(right.id),
  );
}

/**
 * When each pending escalation step of an active case runs if nobody acts,
 * the way the engine counts (`nextActionAfter`): the next step at the case's
 * `nextActionAt`, each later one the policy's gap after the previous. A
 * snoozed case does not move until the snooze ends, so its wait counts from
 * `snoozedUntil`; a held backfill case's, from its release day. Empty for
 * closed cases and held cases with no release day.
 */
export function projectedSchedule(
  policy: EscalationPolicy,
  followUpCase: FollowUpCase,
): Map<number, Date> {
  const schedule = new Map<number, Date>();
  const first = followUpCase.escalationStep;
  const gap = (index: number) =>
    (policy.steps[index]?.afterDays ?? 0) - (policy.steps[index - 1]?.afterDays ?? 0);
  if (!isActiveCaseStatus(followUpCase.status) || policy.steps[first] === undefined) {
    return schedule;
  }
  const { releaseAt, snoozedUntil, nextActionAt } = followUpCase;
  let at: Date | undefined;
  if (followUpCase.status === 'snoozed' && snoozedUntil !== undefined) {
    at = addDays(snoozedUntil, gap(first));
  } else if (releaseAt !== undefined && nextActionAt === undefined) {
    // Held until its release day, when escalation starts.
    at = isUnscheduledRelease(releaseAt) ? undefined : addDays(releaseAt, gap(first));
  } else if (nextActionAt !== undefined) {
    at = nextActionAt;
  }
  if (at === undefined) {
    return schedule;
  }
  schedule.set(first, at);
  for (let index = first + 1; index < policy.steps.length; index += 1) {
    at = addDays(at, gap(index));
    schedule.set(index, at);
  }
  return schedule;
}

/**
 * Turns engine objects into the inbox contract (Spanish labels, display
 * names, evidence with the surrounding note). One presenter per request:
 * it caches what several cases of the same patient share.
 */
export class InboxPresenter {
  readonly #runtime: EngineRuntime;
  readonly #clinicId: ClinicId;
  readonly #catalog: Catalog;
  readonly #timeZone: string;
  readonly now: Date;
  readonly #expectations = new Map<string, Expectation>();
  readonly resource: (key: string) => Promise<FhirResourceJson | undefined>;
  readonly #notes: (patientId: PatientId) => Promise<readonly NoteReceivedEvent[]>;
  readonly #contact: (patientId: PatientId) => Promise<PatientContactStatus>;
  readonly #contacts: (patientId: PatientId) => Promise<PatientContacts>;

  private constructor(
    runtime: EngineRuntime,
    clinicId: ClinicId,
    catalog: Catalog,
    timeZone: string,
  ) {
    this.#runtime = runtime;
    this.#clinicId = clinicId;
    this.#catalog = catalog;
    this.#timeZone = timeZone;
    this.now = runtime.clock.now();
    const { stores } = runtime.storage;
    this.resource = memo(async (key: string) => {
      const [resourceType = '', id = ''] = key.split('/');
      const stored = await stores.clinicalRecords.getResource(clinicId, { resourceType, id });
      return stored?.resource;
    });
    this.#notes = memo(async (patientId: PatientId) =>
      (
        await stores.clinicalRecords.listEventsForPatient(clinicId, patientId, {
          types: ['note.received'],
        })
      ).filter((event): event is NoteReceivedEvent => event.type === 'note.received'),
    );
    this.#contact = memo((patientId: PatientId) =>
      runtime.engine.patientContactStatus(clinicId, patientId),
    );
    this.#contacts = memo((patientId: PatientId) =>
      runtime.engine.contacts.forPatient(clinicId, patientId),
    );
  }

  static async create(runtime: EngineRuntime, clinicId: ClinicId): Promise<InboxPresenter> {
    const [catalog, clinic] = await Promise.all([
      runtime.engine.catalog(clinicId),
      runtime.storage.clinics.get(clinicId),
    ]);
    return new InboxPresenter(runtime, clinicId, catalog, clinic?.settings.timezone ?? 'UTC');
  }

  /** Loads the expectations behind every reason of these cases in one query. */
  async prefetch(cases: readonly FollowUpCase[]): Promise<void> {
    const missing = cases
      .flatMap((item) => item.reasons.map((reason) => reason.expectationId))
      .filter((id) => !this.#expectations.has(id));
    if (missing.length === 0) {
      return;
    }
    const { expectations } = this.#runtime.storage.stores;
    const found = await Promise.all(
      [...new Set(missing)].map((id) => expectations.get(this.#clinicId, id)),
    );
    for (const expectation of found) {
      if (expectation !== undefined) {
        this.#expectations.set(expectation.id, expectation);
      }
    }
  }

  /** The expectations behind a case's reasons, most actionable first. */
  expectationsOf(followUpCase: FollowUpCase): readonly Expectation[] {
    return byActionability(
      followUpCase.reasons.flatMap((reason) => {
        const expectation = this.#expectations.get(reason.expectationId);
        return expectation === undefined ? [] : [expectation];
      }),
    );
  }

  /** Spanish reason label of a rule, from the catalog. Never contains a day count. */
  reasonLabel(ruleId: string | undefined, fallback?: Expectation): string {
    if (fallback?.layer === 'doctor_plan') {
      return planItemLabel(fallback.matchKey, loincLabel);
    }
    const definition = ruleId === undefined ? undefined : this.#catalog.definition(ruleId);
    return (
      definition?.reason.label ??
      fallback?.reason.label ??
      (fallback === undefined ? 'Seguimiento pendiente' : LAYER_FALLBACK_LABELS[fallback.layer])
    );
  }

  async personName(id: string | undefined): Promise<string> {
    if (id === undefined) {
      return FRONT_DESK_LABEL;
    }
    const role = ROLE_LABELS[id];
    if (role !== undefined) {
      return role;
    }
    const practitioner = await this.resource(`Practitioner/${practitionerId(id)}`);
    return humanName(practitioner) ?? FRONT_DESK_LABEL;
  }

  async caseViews(cases: readonly FollowUpCase[]): Promise<CaseView[]> {
    await this.prefetch(cases);
    return Promise.all(cases.map((item) => this.caseView(item)));
  }

  async caseView(followUpCase: FollowUpCase, withExcerpts = false): Promise<CaseView> {
    await this.prefetch([followUpCase]);
    const expectations = this.expectationsOf(followUpCase);
    const [patientResource, contact, contacts, assignee, reasons] = await Promise.all([
      this.resource(`Patient/${followUpCase.patientId}`),
      this.#contact(followUpCase.patientId),
      this.#contacts(followUpCase.patientId),
      this.personName(followUpCase.assignee),
      Promise.all(expectations.map((item) => this.reasonView(item, withExcerpts))),
    ]);
    const patient = patientSummary(followUpCase.patientId, patientResource, this.now);
    return {
      id: followUpCase.id,
      patient: {
        id: patient.id,
        name: patient.name,
        ...(patient.age === undefined ? {} : { age: patient.age }),
        ...(patient.sex === undefined ? {} : { sex: patient.sex }),
      },
      status: followUpCase.status,
      priority: followUpCase.priority,
      priorityLabel: PRIORITY_LABELS[taskPriority(followUpCase.priority)],
      escalationStep: followUpCase.escalationStep,
      escalation: this.escalationView(followUpCase),
      assignee,
      ...(followUpCase.assignee === undefined ? {} : { assigneeId: followUpCase.assignee }),
      origin: followUpCase.origin,
      openedAt: followUpCase.createdAt.toISOString(),
      ...(followUpCase.nextActionAt === undefined
        ? {}
        : { nextActionAt: followUpCase.nextActionAt.toISOString() }),
      // A held case too old to notify has no release day (the engine stores a sentinel).
      ...(followUpCase.releaseAt === undefined || isUnscheduledRelease(followUpCase.releaseAt)
        ? {}
        : { releaseAt: followUpCase.releaseAt.toISOString() }),
      ...(followUpCase.snoozedUntil === undefined
        ? {}
        : { snoozedUntil: followUpCase.snoozedUntil.toISOString() }),
      reasons,
      suggestedAction: this.#suggestedAction(expectations),
      patientContact: contactView(contact, contacts.flags),
    };
  }

  /**
   * The case's escalation policy (the engine's own choice, `policyOf`) as
   * the inbox meter shows it: one labelled step per policy step, how many
   * already passed, and the next one with its date. With the case's events
   * (detail), each passed step says whether it ran or was skipped.
   */
  escalationView(followUpCase: FollowUpCase, events?: readonly CaseEvent[]): EscalationView {
    const policy: EscalationPolicy = policyOf(
      this.#catalog,
      followUpCase.reasons.flatMap((reason) => {
        const expectation = this.#expectations.get(reason.expectationId);
        return expectation === undefined ? [] : [expectation];
      }),
      followUpCase,
    );
    const passed = followUpCase.escalationStep;
    const ran = new Map<number, Date>();
    for (const event of events ?? []) {
      const step = event.payload['step'];
      if (
        event.actor.type === 'system' &&
        event.type !== 'contact_attempt_skipped' &&
        typeof step === 'number' &&
        !ran.has(step)
      ) {
        ran.set(step, event.at);
      }
    }
    const nextStep = policy.steps[passed];
    const next =
      nextStep !== undefined &&
      followUpCase.nextActionAt !== undefined &&
      isActiveCaseStatus(followUpCase.status) &&
      followUpCase.status !== 'snoozed'
        ? {
            action: nextStep.action,
            label: escalationStepLabel(nextStep),
            at: followUpCase.nextActionAt.toISOString(),
          }
        : undefined;
    const scheduled = projectedSchedule(policy, followUpCase);
    return {
      policyId: policy.id ?? 'policy',
      currentStep: passed,
      steps: policy.steps.map((step, index) => {
        const at = ran.get(index);
        const scheduledAt = scheduled.get(index);
        return {
          action: step.action,
          label: escalationStepLabel(step),
          afterDays: step.afterDays,
          ...(events === undefined || index >= passed
            ? {}
            : at === undefined
              ? { outcome: 'skipped' as const }
              : { outcome: 'done' as const, at: at.toISOString() }),
          ...(scheduledAt === undefined ? {} : { scheduledAt: scheduledAt.toISOString() }),
        };
      }),
      ...(next === undefined ? {} : { next }),
    };
  }

  async caseDetail(followUpCase: FollowUpCase): Promise<CaseDetail> {
    const { stores } = this.#runtime.storage;
    const [view, events, feedback, contacts] = await Promise.all([
      this.caseView(followUpCase, true),
      stores.audit.listForCase(this.#clinicId, followUpCase.id),
      stores.feedback.listForCase(this.#clinicId, followUpCase.id),
      this.#contacts(followUpCase.patientId),
    ]);
    const names = new Map<string, string>();
    for (const event of events) {
      const assignee = event.payload['assignee'];
      if (event.type === 'assigned' && typeof assignee === 'string') {
        names.set(assignee, await this.personName(assignee));
      }
    }
    const timeline: CaseTimelineEntry[] = events.map((event) => {
      const note = eventNote(event) ?? this.#resolutionNote(followUpCase, event);
      return {
        at: event.at.toISOString(),
        type: event.type,
        actor: {
          type: event.actor.type,
          ...(event.actor.id === undefined ? {} : { id: event.actor.id }),
        },
        label: timelineLabel(
          event,
          ({ expectationId, ruleId }) => {
            // The same label as the reason card: the expectation decides it
            // (a doctor's plan item reads by what it waits for).
            const expectation =
              expectationId === undefined ? undefined : this.#expectations.get(expectationId);
            return this.reasonLabel(expectation?.ruleId ?? ruleId, expectation);
          },
          (id) => (id === undefined ? FRONT_DESK_LABEL : (names.get(id) ?? id)),
        ),
        ...(note === undefined ? {} : { note }),
      };
    });
    const latest = feedback.at(-1);
    // Attempt order: two attempts can share an instant (a wrong number brings the call forward).
    const requests = contacts.requests
      .filter((request) => request.caseId === followUpCase.id)
      .sort((left, right) => left.attempt - right.attempt);
    const contactAttempts = await Promise.all(
      requests.map((request) => this.#attemptView(followUpCase, request, contacts.communications)),
    );
    const callTask = this.#callTask(followUpCase, requests, contactAttempts);
    const dismissal = await this.#dismissal(followUpCase);
    return {
      ...view,
      escalation: this.escalationView(followUpCase, events),
      timeline,
      contactAttempts,
      ...(callTask === undefined ? {} : { callTask }),
      ...(dismissal === undefined ? {} : { dismissal }),
      ...(latest === undefined
        ? {}
        : {
            feedback: {
              useful: latest.useful,
              ...(latest.reason === undefined ? {} : { reason: latest.reason }),
              ...(latest.comment === undefined ? {} : { comment: latest.comment }),
            },
          }),
    };
  }

  /** A host user (or practitioner) by id: the practitioner's name when the host sent it, else the id. */
  async userName(id: string): Promise<string> {
    const role = ROLE_LABELS[id];
    if (role !== undefined) {
      return role;
    }
    const practitioner = await this.resource(`Practitioner/${practitionerId(id)}`);
    return humanName(practitioner) ?? id;
  }

  /**
   * One contact attempt as the case detail shows it: the channel, its
   * deadline, where it stands and every report on it.
   */
  async #attemptView(
    followUpCase: FollowUpCase,
    request: ContactRequest,
    communications: readonly ContactCommunication[],
  ): Promise<ContactAttemptView> {
    const summary = summarizeAttempt(request, communications);
    const active = isActiveCaseStatus(followUpCase.status);
    const status: AttemptStatus = summary.answered
      ? 'answered'
      : summary.outcome !== undefined && UNREACHED_OUTCOMES.has(summary.outcome)
        ? 'unreached'
        : !active
          ? 'closed'
          : request.channel === 'phone_call'
            ? 'pending_call'
            : request.dueBy.getTime() <= this.now.getTime()
              ? 'unanswered'
              : 'waiting';
    const reports = await Promise.all(
      summary.communications.map(async (communication) => ({
        id: communication.id,
        at: communication.recordedAt.toISOString(),
        status: communication.status,
        ...(communication.outcome === undefined
          ? {}
          : {
              outcome: communication.outcome,
              outcomeLabel: OUTCOME_LABELS[communication.outcome],
            }),
        sender: communication.sender.type,
        ...(communication.sender.id === undefined
          ? {}
          : { senderName: await this.userName(communication.sender.id) }),
      })),
    );
    return {
      id: request.id,
      attempt: request.attempt,
      ...(request.channel === undefined ? {} : { channel: request.channel }),
      channelLabel: channelLabel(request.channel),
      trigger: request.trigger,
      requestedAt: request.requestedAt.toISOString(),
      dueBy: request.dueBy.toISOString(),
      ...(request.requestedBy === undefined
        ? {}
        : { requestedBy: await this.userName(request.requestedBy) }),
      status,
      statusLabel: ATTEMPT_STATUS_LABELS[status],
      ...(summary.outcome === undefined
        ? {}
        : { outcome: summary.outcome, outcomeLabel: OUTCOME_LABELS[summary.outcome] }),
      ...(summary.outcomeAt === undefined ? {} : { outcomeAt: summary.outcomeAt.toISOString() }),
      communications: reports,
    };
  }

  /** The call the team has to make now: the case's latest call nobody recorded yet. */
  #callTask(
    followUpCase: FollowUpCase,
    requests: readonly ContactRequest[],
    attempts: readonly ContactAttemptView[],
  ): CallTaskView | undefined {
    if (!isActiveCaseStatus(followUpCase.status)) {
      return undefined;
    }
    const pending = attempts.filter((attempt) => attempt.status === 'pending_call').at(-1);
    const request = requests.find((candidate) => candidate.id === pending?.id);
    if (pending === undefined || request === undefined) {
      return undefined;
    }
    return {
      requestId: request.id,
      dueBy: request.dueBy.toISOString(),
      overdue: request.dueBy.getTime() < this.now.getTime(),
      trigger: request.trigger,
      outcomes: CALL_OUTCOMES.map((outcome) => ({ outcome, label: CALL_OUTCOME_LABELS[outcome] })),
    };
  }

  async suppressionView(suppression: RuleSuppression): Promise<SuppressionView> {
    const definition = this.#catalog.definition(suppression.ruleId);
    return {
      id: suppression.id,
      ruleId: suppression.ruleId,
      label: definition?.reason.label ?? suppression.reason.label,
      dismissReason: suppression.dismissReason,
      dismissReasonLabel: DISMISS_REASON_LABELS[suppression.dismissReason],
      ...(suppression.note === undefined ? {} : { note: suppression.note }),
      ...(suppression.caseId === undefined ? {} : { caseId: suppression.caseId }),
      createdAt: suppression.createdAt.toISOString(),
      ...(suppression.createdBy === undefined
        ? {}
        : { createdBy: await this.userName(suppression.createdBy) }),
      active: suppression.revokedAt === undefined,
      ...(suppression.revokedAt === undefined
        ? {}
        : { revokedAt: suppression.revokedAt.toISOString() }),
      ...(suppression.revokedBy === undefined
        ? {}
        : { revokedBy: await this.userName(suppression.revokedBy) }),
    };
  }

  async #suppressions(patientId: PatientId): Promise<RuleSuppression[]> {
    const all = await this.#runtime.engine.suppressions.list(this.#clinicId, patientId);
    // Active first, each group newest first (the store's order).
    return [
      ...all.filter((suppression) => suppression.revokedAt === undefined),
      ...all.filter((suppression) => suppression.revokedAt !== undefined),
    ];
  }

  /** Why the team dismissed the case, with the rules it stopped for the patient. */
  async #dismissal(followUpCase: FollowUpCase): Promise<DismissalView | undefined> {
    const resolution = followUpCase.resolution;
    if (followUpCase.status !== 'dismissed' || resolution?.dismissReason === undefined) {
      return undefined;
    }
    const suppressions = (await this.#suppressions(followUpCase.patientId)).filter(
      (suppression) => suppression.caseId === followUpCase.id,
    );
    return {
      reason: resolution.dismissReason,
      reasonLabel: DISMISS_REASON_LABELS[resolution.dismissReason],
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
      ...(resolution.resolvedBy === undefined
        ? {}
        : { by: await this.userName(resolution.resolvedBy) }),
      at: resolution.resolvedAt.toISOString(),
      suppressions: await Promise.all(
        suppressions.map((suppression) => this.suppressionView(suppression)),
      ),
    };
  }

  /**
   * The note a user left when closing the case, for events recorded before
   * notes were kept on the event itself.
   */
  #resolutionNote(followUpCase: FollowUpCase, event: CaseEvent): string | undefined {
    const note = followUpCase.resolution?.note?.trim();
    const closing = event.type === 'resolved' || event.type === 'dismissed';
    return closing && event.actor.type === 'user' && note !== undefined && note !== ''
      ? note
      : undefined;
  }

  async reasonView(expectation: Expectation, withExcerpt: boolean): Promise<CaseReasonView> {
    const [source, evidence] = await Promise.all([
      this.resource(`${expectation.source.resourceType}/${expectation.source.id}`),
      this.#evidence(expectation, withExcerpt),
    ]);
    return {
      expectationId: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: this.reasonLabel(expectation.ruleId, expectation),
      dueAt: expectation.dueAt.toISOString(),
      overdueDays: Math.max(0, calendarDaysBetween(expectation.dueAt, this.now, this.#timeZone)),
      suppressible: SUPPRESSIBLE_LAYERS.has(expectation.layer),
      source: {
        resourceType: expectation.source.resourceType,
        id: expectation.source.id,
        display: sourceDisplay(expectation.source.resourceType, source),
      },
      ...(evidence === undefined ? {} : { evidence }),
    };
  }

  async #evidence(
    expectation: Expectation,
    withExcerpt: boolean,
  ): Promise<CaseReasonView['evidence']> {
    if (expectation.evidence === undefined) {
      return undefined;
    }
    const { quote, sourceDocumentId } = expectation.evidence;
    const note = (await this.#notes(expectation.patientId)).findLast(
      (event) => event.documentId === sourceDocumentId,
    );
    return {
      quote,
      documentId: sourceDocumentId,
      authoredAt: (note?.authoredAt ?? expectation.createdAt).toISOString(),
      ...(withExcerpt && note !== undefined
        ? { noteExcerpt: excerptAround(note.text, quote) }
        : {}),
    };
  }

  /** The suggested action of the most actionable reason (the one that titles the case). */
  #suggestedAction(expectations: readonly Expectation[]): string {
    const definition = expectations
      .map((expectation) => this.#catalog.definition(expectation.ruleId))
      .find((item) => item !== undefined);
    return definition?.suggestedAction.label ?? DEFAULT_SUGGESTED_ACTION;
  }

  expectationView(expectation: Expectation): PatientExpectationView {
    const closedLabel = closedReasonLabel(expectation.closedReason);
    return {
      id: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: this.reasonLabel(expectation.ruleId, expectation),
      status: expectation.status,
      dueAt: expectation.dueAt.toISOString(),
      ...(closedLabel === undefined ? {} : { closedReason: closedLabel }),
      ...(expectation.evidence === undefined
        ? {}
        : {
            evidence: {
              quote: expectation.evidence.quote,
              documentId: expectation.evidence.sourceDocumentId,
            },
          }),
    };
  }

  /** `undefined` when the clinic has nothing at all for this patient. */
  async patientDetail(patientId: PatientId): Promise<PatientDetail | undefined> {
    const { stores } = this.#runtime.storage;
    const [resource, conditions, ascending, findings, contact, contacts, suppressions] =
      await Promise.all([
        this.resource(`Patient/${patientId}`),
        stores.conditions.listByPatient(this.#clinicId, patientId),
        stores.expectations.listByPatient(this.#clinicId, patientId),
        stores.qualityFindings.listByPatient(this.#clinicId, patientId),
        this.#contact(patientId),
        this.#contacts(patientId),
        this.#suppressions(patientId),
      ]);
    // Newest deadline first.
    const expectations = [...ascending].reverse();
    if (resource === undefined && expectations.length === 0 && conditions.length === 0) {
      const events = await stores.clinicalRecords.listEventsForPatient(this.#clinicId, patientId);
      if (events.length === 0) {
        return undefined;
      }
    }
    const summary = patientSummary(patientId, resource, this.now);
    const contactInfo = contactView(contact, contacts.flags);
    return {
      patient: { ...summary, contact: contactInfo },
      contact: contactInfo,
      // A condition entered in error (or moved to another patient) was never the patient's.
      conditions: withoutConfirmedDuplicates(conditions)
        .filter((condition) => condition.status !== 'entered_in_error')
        .map(conditionView),
      expectations: expectations.map((expectation) => this.expectationView(expectation)),
      qualityFindings: findings.map((finding) => ({
        id: finding.id,
        code: finding.kind,
        documentId: finding.source.id,
        at: finding.detectedAt.toISOString(),
        label: QUALITY_FINDING_LABELS[finding.kind],
      })),
      suppressions: await Promise.all(
        suppressions.map((suppression) => this.suppressionView(suppression)),
      ),
    };
  }
}
