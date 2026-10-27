import type {
  CaseEventActor,
  CaseFeedback,
  CaseFeedbackReason,
  CaseResolutionKind,
  FollowUpCase,
} from '../../domain/case.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import { type CaseId, type ClinicId, feedbackId } from '../../domain/ids.ts';
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
import { hasOptedOut, lastPatientContactAt } from '../patient-contact/history.ts';
import { decidePatientContact, PatientContactNotAllowedError } from '../patient-contact/policy.ts';
import type { EngineSettings } from '../settings.ts';
import { addDays } from '../support/time.ts';
import { CaseWriter, withoutKey } from './case-writer.ts';
import { resolveCase } from './reconcile.ts';
import { isActiveCaseStatus } from './state-machine.ts';

/** A clinic user's action on a case (the inbox "actions" endpoint). */
export type CaseAction =
  | { readonly type: 'notify' }
  | { readonly type: 'snooze'; readonly until: Date }
  | { readonly type: 'resolve'; readonly kind?: CaseResolutionKind; readonly note?: string }
  | { readonly type: 'dismiss'; readonly note?: string }
  | { readonly type: 'assign'; readonly assignee: string };

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
  dismiss(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
    note?: string,
  ): Promise<FollowUpCase>;
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
   * resting on probable conditions) do not apply.
   */
  requestPatientContact(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
  ): Promise<FollowUpCase>;
  /**
   * Records whether the case was useful. A "not useful" verdict needs a
   * reason (`ValidationError` otherwise): it is the ground truth for tuning
   * rules and evaluating extraction.
   */
  recordFeedback(clinicId: ClinicId, caseId: CaseId, input: FeedbackInput): Promise<CaseFeedback>;
}

async function requireCase(
  stores: TransactionalStores,
  clinicId: ClinicId,
  caseId: CaseId,
): Promise<FollowUpCase> {
  const found = await stores.cases.get(clinicId, caseId);
  if (found === undefined) {
    throw new NotFoundError('FollowUpCase', caseId);
  }
  return found;
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
        case 'notify': {
          const notified = await writer.transition(current, {
            to: 'notified',
            type: 'notified',
            actor,
            at: now,
          });
          return restartWait(stores, clinicId, notified, now);
        }
        case 'snooze': {
          if (action.until.getTime() <= now.getTime()) {
            throw new ValidationError('until', 'A case can only be snoozed until a future date');
          }
          return writer.transition(current, {
            to: 'snoozed',
            type: 'snoozed',
            actor,
            at: now,
            payload: { until: action.until.toISOString() },
            patch: { snoozedUntil: action.until, nextActionAt: action.until },
          });
        }
        case 'resolve':
          return resolveCase(writer, current, {
            kind: action.kind ?? 'handled_outside',
            actor,
            now,
            ...(action.note === undefined ? {} : { note: action.note }),
          });
        case 'dismiss': {
          const dismissed = await writer.transition(withoutKey(current, 'nextActionAt'), {
            to: 'dismissed',
            type: 'dismissed',
            actor,
            at: now,
            patch: {
              resolution: {
                kind: 'not_needed',
                resolvedAt: now,
                ...(actor.id === undefined ? {} : { resolvedBy: actor.id }),
                ...(action.note === undefined ? {} : { note: action.note }),
              },
            },
          });
          await writer.emit('case.resolved', now, {
            caseId: dismissed.id,
            patientId: dismissed.patientId,
            resolution: 'not_needed',
          });
          return dismissed;
        }
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

  async function requestPatientContact(
    clinicId: ClinicId,
    caseId: CaseId,
    actor: CaseEventActor,
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
      const [first] = await caseExpectations(stores, clinicId, current);
      const purpose =
        (first === undefined
          ? undefined
          : catalog.definition(first.ruleId)?.suggestedAction.patientContactPurpose) ??
        'schedule_follow_up';
      const writer = new CaseWriter(stores, deps.ids, clinicId);
      await writer.audit(current, 'patient_contact_requested', actor, now, { purpose });
      await writer.emit('patient_contact.requested', now, {
        caseId: current.id,
        patientId: current.patientId,
        purpose,
        dueBy: addDays(now, deps.settings.patientContactDueInDays),
      });
      return current;
    });
  }

  return {
    apply,
    requestPatientContact,
    notify: (clinicId, caseId, actor) => apply(clinicId, caseId, { type: 'notify' }, actor),
    snooze: (clinicId, caseId, until, actor) =>
      apply(clinicId, caseId, { type: 'snooze', until }, actor),
    resolve: (clinicId, caseId, actor, options = {}) =>
      apply(clinicId, caseId, { type: 'resolve', ...options }, actor),
    dismiss: (clinicId, caseId, actor, note) =>
      apply(clinicId, caseId, { type: 'dismiss', ...(note === undefined ? {} : { note }) }, actor),
    assign: (clinicId, caseId, assignee, actor) =>
      apply(clinicId, caseId, { type: 'assign', assignee }, actor),
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
