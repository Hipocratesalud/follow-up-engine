import type {
  CaseEventActor,
  CaseFeedback,
  CaseFeedbackReason,
  CaseResolutionKind,
  FollowUpCase,
} from '../../domain/case.ts';
import {
  type ContactOutcome,
  type ContactRequest,
  type DismissReason,
  type RuleSuppression,
  SUPPRESSIBLE_LAYERS,
} from '../../domain/contact.ts';
import type { Expectation } from '../../domain/expectation.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import {
  type CaseId,
  type ClinicId,
  type ContactRequestId,
  feedbackId,
  type PatientId,
} from '../../domain/ids.ts';
import { ACTIVE_CASE_STATUSES } from '../../domain/case.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import type { Clock } from '../../ports/clock.ts';
import type { Catalog } from '../catalog.ts';
import {
  caseExpectations,
  nextActionAfter,
  policyOf,
  withNextActionAt,
} from '../escalation/schedule.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import { contactPurpose, openContactAttempt } from '../patient-contact/attempts.ts';
import { hasOptedOut, lastPatientContactAt } from '../patient-contact/history.ts';
import {
  type CommunicationRecordResult,
  recordCommunication,
} from '../patient-contact/outcomes.ts';
import { decidePatientContact, PatientContactNotAllowedError } from '../patient-contact/policy.ts';
import type { EngineSettings } from '../settings.ts';
import { suppressRule } from '../suppression/suppressions.ts';
import { CaseWriter, withoutKey } from './case-writer.ts';
import { resolveCase } from './reconcile.ts';
import { isActiveCaseStatus } from './state-machine.ts';
import { listPatientCases } from '../patient-state.ts';

/**
 * A clinic user's action on a case (the inbox "actions" endpoint). `note` is
 * the team's internal note: kept on the case event so the team sees it in
 * the case history.
 */
export type CaseAction =
  | { readonly type: 'notify' }
  | { readonly type: 'snooze'; readonly until: Date; readonly note?: string }
  | { readonly type: 'resolve'; readonly kind?: CaseResolutionKind; readonly note?: string }
  | {
      readonly type: 'dismiss';
      readonly reason: DismissReason;
      /** Required with `other`. */
      readonly note?: string;
      /**
       * With `not_applicable_to_patient`: stop these rules of the case for
       * the patient ("Dejar de recordarlo para este paciente"). Only rules
       * of `SUPPRESSIBLE_LAYERS` (protocol items, the visit pattern).
       */
      readonly suppressRuleIds?: readonly string[];
    }
  | { readonly type: 'assign'; readonly assignee: string };

/** Outcomes of a call the team made ("Llamar al paciente"). */
export const CALL_OUTCOMES = [
  'booked',
  'treated_elsewhere',
  'no_answer',
  'wrong_number',
  'declined',
] as const satisfies readonly ContactOutcome[];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** The options of a dismissal (see the `dismiss` action). */
export type DismissInput = Omit<Extract<CaseAction, { readonly type: 'dismiss' }>, 'type'>;

/** What a dismissal did besides closing the case. */
export interface DismissResult {
  readonly followUpCase: FollowUpCase;
  readonly feedback: CaseFeedback;
  readonly suppressions: readonly RuleSuppression[];
}

export interface FeedbackInput {
  readonly useful: boolean;
  /** Mandatory when `useful` is false. */
  readonly reason?: CaseFeedbackReason;
  readonly comment?: string;
  readonly authorId?: string;
}

export interface CaseCommandDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly clinics: ClinicDirectory;
  readonly settings: EngineSettings;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

/** What a patient-level contact request did (see `requestPatientContactForPatient`). */
export interface PatientContactRequestResult {
  /** The one attempt opened for the patient. */
  readonly request: ContactRequest;
  /** The case the attempt belongs to: the patient's most urgent active case. */
  readonly primaryCaseId: CaseId;
  /** Every active case of the patient in the inbox, after the request. */
  readonly cases: readonly FollowUpCase[];
}

/** Commands a clinic user runs on a case. Every one is audited with the user as actor. */
export interface CaseCommands {
  /**
   * Applies an action. Invalid transitions (for example snoozing a resolved
   * case) throw `InvalidCaseTransitionError`; unknown cases `NotFoundError`.
   */
  apply(
    clinicId: ClinicId,
    caseId: CaseId,
    action: CaseAction,
    actor: CaseEventActor,
  ): Promise<FollowUpCase>;
  notify(clinicId: ClinicId, caseId: CaseId, actor: CaseEventActor): Promise<FollowUpCase>;
  snooze(
    clinicId: ClinicId,
    caseId: CaseId,
    until: Date,
    actor: CaseEventActor,
  ): Promise<FollowUpCase>;
  resolve(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
    options?: { readonly kind?: CaseResolutionKind; readonly note?: string },
  ): Promise<FollowUpCase>;
  /**
   * "Descartar": closes the case as `not_needed` with a mandatory reason,
   * recorded as the case's feedback too (not useful, same reason and note:
   * one input). `other` needs a note. With `not_applicable_to_patient`,
   * `suppressRuleIds` (rules of the case's reasons) stops those rules for
   * the patient. `ValidationError` (HTTP 422) for a missing or inconsistent
   * input.
   */
  dismiss(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
    input: DismissInput,
  ): Promise<DismissResult>;
  assign(
    clinicId: ClinicId,
    caseId: CaseId,
    assignee: string,
    actor: CaseEventActor,
  ): Promise<FollowUpCase>;
  /**
   * A clinic user asks the host to contact the patient of an active case
   * ("Pedir contacto"): records `patient_contact_requested` and emits
   * `patient_contact.requested` (ids, a generic purpose and a date only).
   * Throws `PatientContactNotAllowedError` when the clinic does not allow
   * patient contact, the patient opted out, or the patient was already asked
   * within the contact window; `ValidationError` for an inactive case. The
   * user decides, so the automatic-only restrictions (backfill cases, cases
   * resting on probable conditions) do not apply. `note` is the team's
   * internal note, kept on the case event (never sent to the host).
   */
  requestPatientContact(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
    note?: string,
  ): Promise<FollowUpCase>;
  /**
   * Records whether the case was useful. A "not useful" verdict needs a
   * reason (`ValidationError` otherwise): it is the ground truth for tuning
   * rules and evaluating extraction.
   */
  recordFeedback(clinicId: ClinicId, caseId: CaseId, input: FeedbackInput): Promise<CaseFeedback>;
  /**
   * The team called the patient ("Llamar al paciente") and records what
   * came of it, as a `Communication` (medium phone, sender the user) on the
   * case's pending call. Reacts like an outcome the host reports. Throws
   * `NotFoundError` when the case has no call to record, `ValidationError`
   * for an inactive case.
   */
  recordCallOutcome(
    clinicId: ClinicId,
    caseId: CaseId,
    input: { readonly outcome: CallOutcome; readonly requestId?: ContactRequestId },
    actor: CaseEventActor,
  ): Promise<CommunicationRecordResult>;
  /** The case's contact attempts, oldest first. */
  contactAttempts(clinicId: ClinicId, caseId: CaseId): Promise<readonly ContactRequest[]>;
  /**
   * "Request contact" for the patient of the inbox card (HIP-141): one
   * attempt for the patient whatever the number of their cases, on the most
   * urgent active case released to the inbox. Every other active case
   * records the request in its history (`patient_contact_requested` with
   * `sharedFromCaseId`), and every open or snoozed case is marked notified
   * (the wait before its next escalation step restarts). The same checks as
   * `requestPatientContact` (one message per patient per contact window,
   * across cases); `NotFoundError` when the patient has no active case in
   * the inbox.
   */
  requestPatientContactForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    actor: CaseEventActor,
    note?: string,
  ): Promise<PatientContactRequestResult>;
}

async function requireCase(
  stores: TransactionalStores,
  clinicId: ClinicId,
  caseId: CaseId,
): Promise<FollowUpCase> {
  // Locked until the command commits: a concurrent command on the same case
  // waits, then sees this one's outcome (and fails as it would afterwards).
  const found = await stores.cases.get(clinicId, caseId, { forUpdate: true });
  if (found === undefined) {
    throw new NotFoundError('FollowUpCase', caseId);
  }
  return found;
}

/** Checks a dismissal's input against the case's reasons. @throws {ValidationError} */
function validateDismissal(input: DismissInput, reasons: readonly Expectation[]): void {
  if ((input.reason as string | undefined) === undefined) {
    throw new ValidationError('reason', 'A reason is required to dismiss a case');
  }
  if (input.reason === 'other' && (input.note ?? '').trim() === '') {
    throw new ValidationError('note', 'Dismissing for another reason needs a note');
  }
  const suppress = input.suppressRuleIds ?? [];
  if (suppress.length > 0 && input.reason !== 'not_applicable_to_patient') {
    throw new ValidationError(
      'suppressRuleIds',
      'Only a case that does not apply to the patient can stop its rules',
    );
  }
  for (const ruleId of suppress) {
    const reason = reasons.find((expectation) => expectation.ruleId === ruleId);
    if (reason === undefined) {
      throw new ValidationError('suppressRuleIds', `Rule ${ruleId} is not a reason of the case`);
    }
    if (!SUPPRESSIBLE_LAYERS.has(reason.layer)) {
      throw new ValidationError(
        'suppressRuleIds',
        `Rule ${ruleId} (${reason.layer}) cannot be stopped for one patient`,
      );
    }
  }
}

export function createCaseCommands(deps: CaseCommandDeps): CaseCommands {
  /**
   * A user acting on the case restarts the wait before the next escalation
   * step. Pending "notify the clinic" steps are skipped: the user has seen it.
   */
  async function restartWait(
    stores: TransactionalStores,
    clinicId: ClinicId,
    followUpCase: FollowUpCase,
    now: Date,
  ): Promise<FollowUpCase> {
    const catalog = await deps.loadCatalog(clinicId);
    const policy = policyOf(catalog, await caseExpectations(stores, clinicId, followUpCase));
    let step = followUpCase.escalationStep;
    while (policy.steps[step]?.action === 'notify_clinic') {
      step += 1;
    }
    const next = withNextActionAt(
      { ...followUpCase, escalationStep: step },
      nextActionAfter(policy, step, now),
    );
    await stores.cases.update(clinicId, next);
    return next;
  }

  async function notifyInTransaction(
    stores: TransactionalStores,
    writer: CaseWriter,
    current: FollowUpCase,
    actor: CaseEventActor,
    now: Date,
  ): Promise<FollowUpCase> {
    const notified = await writer.transition(current, {
      to: 'notified',
      type: 'notified',
      actor,
      at: now,
    });
    return restartWait(stores, current.clinicId, notified, now);
  }

  async function apply(
    clinicId: ClinicId,
    caseId: CaseId,
    action: CaseAction,
    actor: CaseEventActor,
  ): Promise<FollowUpCase> {
    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const now = deps.clock.now();
      const writer = new CaseWriter(stores, deps.ids, clinicId);
      const current = await requireCase(stores, clinicId, caseId);
      switch (action.type) {
        case 'notify':
          return notifyInTransaction(stores, writer, current, actor, now);
        case 'snooze': {
          if (action.until.getTime() <= now.getTime()) {
            throw new ValidationError('until', 'A case can only be snoozed until a future date');
          }
          return writer.transition(current, {
            to: 'snoozed',
            type: 'snoozed',
            actor,
            at: now,
            payload: {
              until: action.until.toISOString(),
              ...(action.note === undefined ? {} : { note: action.note }),
            },
            patch: { snoozedUntil: action.until, nextActionAt: action.until },
          });
        }
        case 'resolve':
          return resolveCase(writer, current, {
            kind: action.kind ?? 'handled_outside',
            actor,
            now,
            ...(action.note === undefined
              ? {}
              : { note: action.note, payload: { note: action.note } }),
          });
        case 'dismiss':
          return (await dismissInTransaction(stores, writer, current, action, actor, now))
            .followUpCase;
        case 'assign': {
          if (!isActiveCaseStatus(current.status)) {
            throw new ValidationError('status', 'Only active cases can be assigned');
          }
          const assigned = await writer.update(
            { ...current, assignee: action.assignee, updatedAt: now },
            { type: 'assigned', actor, payload: { assignee: action.assignee } },
          );
          return restartWait(stores, clinicId, assigned, now);
        }
      }
    });
  }

  /** Dismisses a case with its reason: feedback and suppressions in the same transaction. */
  async function dismissInTransaction(
    stores: TransactionalStores,
    writer: CaseWriter,
    current: FollowUpCase,
    input: DismissInput,
    actor: CaseEventActor,
    now: Date,
  ): Promise<DismissResult> {
    const reasons = await caseExpectations(stores, current.clinicId, current);
    validateDismissal(input, reasons);
    const note = input.note?.trim() === '' ? undefined : input.note;
    const dismissed = await writer.transition(withoutKey(current, 'nextActionAt'), {
      to: 'dismissed',
      type: 'dismissed',
      actor,
      at: now,
      payload: {
        reason: input.reason,
        ...(note === undefined ? {} : { note }),
        ...(input.suppressRuleIds === undefined || input.suppressRuleIds.length === 0
          ? {}
          : { suppressRuleIds: [...input.suppressRuleIds] }),
      },
      patch: {
        resolution: {
          kind: 'not_needed',
          resolvedAt: now,
          dismissReason: input.reason,
          ...(actor.id === undefined ? {} : { resolvedBy: actor.id }),
          ...(note === undefined ? {} : { note }),
        },
      },
    });
    await writer.emit('case.resolved', now, {
      caseId: dismissed.id,
      patientId: dismissed.patientId,
      resolution: 'not_needed',
    });
    // The reason is the case's feedback: the team answers once.
    const feedback: CaseFeedback = {
      id: feedbackId(deps.ids.next('feedback')),
      clinicId: current.clinicId,
      caseId: current.id,
      useful: false,
      reason: input.reason,
      ...(note === undefined ? {} : { comment: note }),
      ...(actor.id === undefined ? {} : { authorId: actor.id }),
      createdAt: now,
    };
    await stores.feedback.record(current.clinicId, feedback);
    await writer.audit(dismissed, 'feedback_recorded', actor, now, {
      feedbackId: feedback.id,
      useful: false,
      reason: input.reason,
      source: 'dismissal',
    });
    const suppressions: RuleSuppression[] = [];
    for (const ruleId of new Set(input.suppressRuleIds ?? [])) {
      const expectation = reasons.find((candidate) => candidate.ruleId === ruleId);
      if (expectation === undefined) {
        continue;
      }
      suppressions.push(
        await suppressRule(
          { stores, ids: deps.ids, clinicId: current.clinicId },
          {
            patientId: current.patientId,
            ruleId,
            reason: expectation.reason,
            dismissReason: input.reason,
            ...(note === undefined ? {} : { note }),
            caseId: current.id,
            actor,
            now,
          },
        ),
      );
    }
    return { followUpCase: dismissed, feedback, suppressions };
  }

  async function requestPatientContact(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
    note?: string,
  ): Promise<FollowUpCase> {
    const clinic = await deps.clinics.get(clinicId);
    const catalog = await deps.loadCatalog(clinicId);
    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const now = deps.clock.now();
      const current = await requireCase(stores, clinicId, caseId);
      if (!isActiveCaseStatus(current.status)) {
        throw new ValidationError('status', 'Only an active case can ask for patient contact');
      }
      const optedOut = await hasOptedOut(stores, clinicId, current.patientId);
      const lastContactAt = await lastPatientContactAt(stores, clinicId, current.patientId);
      const decision = decidePatientContact({
        clinicAllowsContact: clinic?.active === true && clinic.settings.allowPatientContact,
        patientOptedOut: optedOut,
        lowConfidence: false,
        ...(lastContactAt === undefined ? {} : { lastContactAt }),
        now,
        windowDays: deps.settings.patientContactWindowDays,
      });
      if (!decision.allowed) {
        throw new PatientContactNotAllowedError(decision.reason);
      }
      const writer = new CaseWriter(stores, deps.ids, clinicId);
      await openContactAttempt(
        { stores, writer, ids: deps.ids },
        {
          followUpCase: current,
          purpose: contactPurpose(catalog, await caseExpectations(stores, clinicId, current)),
          trigger: 'user',
          answerWindowDays: deps.settings.patientContactDueInDays,
          actor,
          now,
          ...(note === undefined ? {} : { note }),
        },
      );
      return current;
    });
  }

  async function requestPatientContactForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    actor: CaseEventActor,
    note?: string,
  ): Promise<PatientContactRequestResult> {
    const clinic = await deps.clinics.get(clinicId);
    const catalog = await deps.loadCatalog(clinicId);
    return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const now = deps.clock.now();
      // Most urgent first (the store's order); each one locked, in that order.
      const listed = await listPatientCases(stores, clinicId, patientId, {
        statuses: ACTIVE_CASE_STATUSES,
        releasedAsOf: now,
        orderBy: 'priority',
      });
      const locked: FollowUpCase[] = [];
      for (const item of listed) {
        const current = await stores.cases.get(clinicId, item.id, { forUpdate: true });
        if (current !== undefined && isActiveCaseStatus(current.status)) {
          locked.push(current);
        }
      }
      const [primary] = locked;
      if (primary === undefined) {
        throw new NotFoundError('FollowUpCase', `patient:${patientId}`);
      }
      const lastContactAt = await lastPatientContactAt(stores, clinicId, patientId);
      const decision = decidePatientContact({
        clinicAllowsContact: clinic?.active === true && clinic.settings.allowPatientContact,
        patientOptedOut: await hasOptedOut(stores, clinicId, patientId),
        lowConfidence: false,
        ...(lastContactAt === undefined ? {} : { lastContactAt }),
        now,
        windowDays: deps.settings.patientContactWindowDays,
      });
      if (!decision.allowed) {
        throw new PatientContactNotAllowedError(decision.reason);
      }
      const writer = new CaseWriter(stores, deps.ids, clinicId);
      const request = await openContactAttempt(
        { stores, writer, ids: deps.ids },
        {
          followUpCase: primary,
          purpose: contactPurpose(catalog, await caseExpectations(stores, clinicId, primary)),
          trigger: 'user',
          answerWindowDays: deps.settings.patientContactDueInDays,
          actor,
          now,
          ...(note === undefined ? {} : { note }),
        },
      );
      const cases: FollowUpCase[] = [];
      for (const current of locked) {
        if (current.id !== primary.id) {
          await writer.audit(current, 'patient_contact_requested', actor, now, {
            requestId: request.id,
            sharedFromCaseId: primary.id,
            trigger: 'user',
            ...(note === undefined ? {} : { note }),
          });
        }
        cases.push(
          current.status === 'open' || current.status === 'snoozed'
            ? await notifyInTransaction(stores, writer, current, actor, now)
            : current,
        );
      }
      return { request, primaryCaseId: primary.id, cases };
    });
  }

  return {
    apply,
    requestPatientContact,
    requestPatientContactForPatient,
    notify: (clinicId, caseId, actor) => apply(clinicId, caseId, { type: 'notify' }, actor),
    snooze: (clinicId, caseId, until, actor) =>
      apply(clinicId, caseId, { type: 'snooze', until }, actor),
    resolve: (clinicId, caseId, actor, options = {}) =>
      apply(clinicId, caseId, { type: 'resolve', ...options }, actor),
    dismiss: (clinicId, caseId, actor, input) =>
      deps.unitOfWork.withTransaction(clinicId, async (stores) =>
        dismissInTransaction(
          stores,
          new CaseWriter(stores, deps.ids, clinicId),
          await requireCase(stores, clinicId, caseId),
          input,
          actor,
          deps.clock.now(),
        ),
      ),
    assign: (clinicId, caseId, assignee, actor) =>
      apply(clinicId, caseId, { type: 'assign', assignee }, actor),
    async recordCallOutcome(clinicId, caseId, input, actor) {
      const request = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const current = await requireCase(stores, clinicId, caseId);
        if (!isActiveCaseStatus(current.status)) {
          throw new ValidationError('status', 'Only an active case has calls to record');
        }
        const calls = (await stores.contacts.listRequestsForCase(clinicId, caseId)).filter(
          (candidate) => candidate.channel === 'phone_call',
        );
        const found =
          input.requestId === undefined
            ? calls.at(-1)
            : calls.find((candidate) => candidate.id === input.requestId);
        if (found === undefined) {
          throw new NotFoundError('CommunicationRequest', input.requestId ?? `${caseId}:call`);
        }
        return found;
      });
      const now = deps.clock.now();
      const reached = input.outcome !== 'no_answer' && input.outcome !== 'wrong_number';
      return recordCommunication(
        deps,
        clinicId,
        {
          id: deps.ids.next('communication'),
          requestId: request.id,
          channel: 'phone_call',
          status: reached ? 'completed' : 'not-done',
          outcome: input.outcome,
          sentAt: now,
          sender: { type: 'user', ...(actor.id === undefined ? {} : { id: actor.id }) },
        },
        now,
      );
    },
    contactAttempts: (clinicId, caseId) =>
      deps.unitOfWork.withTransaction(clinicId, (stores) =>
        stores.contacts.listRequestsForCase(clinicId, caseId),
      ),
    async recordFeedback(clinicId, caseId, input) {
      if (!input.useful && input.reason === undefined) {
        throw new ValidationError('reason', 'A reason is required when the case was not useful');
      }
      return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
        const now = deps.clock.now();
        const current = await requireCase(stores, clinicId, caseId);
        const feedback: CaseFeedback = {
          id: feedbackId(deps.ids.next('feedback')),
          clinicId,
          caseId,
          useful: input.useful,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          ...(input.authorId === undefined ? {} : { authorId: input.authorId }),
          createdAt: now,
        };
        await stores.feedback.record(clinicId, feedback);
        const actor: CaseEventActor =
          input.authorId === undefined ? { type: 'user' } : { type: 'user', id: input.authorId };
        await new CaseWriter(stores, deps.ids, clinicId).audit(
          current,
          'feedback_recorded',
          actor,
          now,
          {
            feedbackId: feedback.id,
            useful: feedback.useful,
            ...(feedback.reason === undefined ? {} : { reason: feedback.reason }),
          },
        );
        return feedback;
      });
    },
  };
}
