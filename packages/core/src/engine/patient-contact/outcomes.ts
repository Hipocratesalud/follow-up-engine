import type { CaseEventActor, FollowUpCase } from '../../domain/case.ts';
import {
  ANSWERED_OUTCOMES,
  type CommunicationSender,
  type CommunicationStatus,
  type ContactChannel,
  type ContactCommunication,
  type ContactOutcome,
  type ContactRequest,
} from '../../domain/contact.ts';
import { NotFoundError, ValidationError } from '../../domain/errors.ts';
import type { ClinicId, ContactRequestId, PatientId } from '../../domain/ids.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { CaseWriter } from '../case-manager/case-writer.ts';
import { resolveCase } from '../case-manager/reconcile.ts';
import { isActiveCaseStatus } from '../case-manager/state-machine.ts';
import type { Catalog } from '../catalog.ts';
import { caseExpectations, policyOf } from '../escalation/schedule.ts';
import type { EngineSettings } from '../settings.ts';
import { callAlreadyRequested, contactPurpose, openContactAttempt } from './attempts.ts';
import { hasOptedOut } from './history.ts';
import { decidePatientContact, isLowConfidenceCase } from './policy.ts';

/**
 * What the host (a FHIR `Communication`) or a clinic user (a call) reports on
 * one contact attempt.
 */
export interface CommunicationInput {
  readonly id: string;
  /** The attempt it reports on (`Communication.basedOn`). */
  readonly requestId: ContactRequestId;
  /** `Communication.subject`, when given: must be the attempt's patient. */
  readonly patientId?: PatientId;
  readonly channel?: ContactChannel;
  readonly status: CommunicationStatus;
  readonly outcome?: ContactOutcome;
  readonly sentAt?: Date;
  readonly receivedAt?: Date;
  readonly sender: CommunicationSender;
  readonly versionId?: string;
  readonly lastUpdated?: Date;
}

/** What the engine did about an outcome. */
export type ContactReaction =
  | 'none'
  | 'case_resolved_handled_outside'
  | 'case_resolved_patient_declined'
  | 'contact_data_flagged'
  | 'call_requested';

export interface CommunicationRecordResult {
  readonly communication: ContactCommunication;
  /** False for a re-delivery of the stored version, or an older version (`stale`). */
  readonly changed: boolean;
  readonly stale: boolean;
  /** The outcome that took effect with this version (absent when nothing new was learned). */
  readonly outcome?: ContactOutcome;
  readonly reactions: readonly ContactReaction[];
}

export interface OutcomeDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly clinics: ClinicDirectory;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

/** The outcome a stored version stands for (one entered in error stands for nothing). */
function effectiveOutcome(
  communication: ContactCommunication | undefined,
): ContactOutcome | undefined {
  return communication?.status === 'entered-in-error' ? undefined : communication?.outcome;
}

/**
 * The attempt a communication reports on, in the clinic. Throws
 * `NotFoundError` for an unknown (or another clinic's) attempt and
 * `ValidationError` when the communication names another patient.
 */
export async function requireAttempt(
  stores: TransactionalStores,
  clinicId: ClinicId,
  requestId: ContactRequestId,
  patientId?: PatientId,
): Promise<ContactRequest> {
  const request = await stores.contacts.getRequest(clinicId, requestId, { forUpdate: true });
  if (request === undefined) {
    throw new NotFoundError('CommunicationRequest', requestId);
  }
  if (patientId !== undefined && patientId !== request.patientId) {
    throw new ValidationError('subject', 'The Communication is about another patient');
  }
  return request;
}

/**
 * Records what came of a contact attempt and lets the engine react, in one
 * transaction (idempotent and version-aware: a re-delivered or older
 * version changes nothing):
 *
 * - `treated_elsewhere`: the case resolves as `handled_outside`;
 * - `declined`: the case resolves as `patient_declined`;
 * - `booked`: nothing more; the `Appointment` holds the expectation and the
 *   visit resolves the case, as usual;
 * - `wrong_number`: the patient's contact data is flagged (message attempts
 *   stop) and, when the policy still has a call to make, the call is
 *   requested now instead of on its day;
 * - `replied` / `booked` / `declined` / `treated_elsewhere` clear a contact
 *   data flag (the patient was reached), and stop later attempts that skip
 *   when answered;
 * - `no_answer` and `wrong_number` end the attempt's answer window at once.
 *
 * Every new outcome is audited on the case. One recorded by a clinic user
 * (a call) is also sent to the host (`contact.outcome_recorded`).
 */
export async function recordCommunication(
  deps: OutcomeDeps,
  clinicId: ClinicId,
  input: CommunicationInput,
  now: Date,
): Promise<CommunicationRecordResult> {
  const catalog = await deps.loadCatalog(clinicId);
  const clinic = await deps.clinics.get(clinicId);
  return deps.unitOfWork.withTransaction(clinicId, async (stores) => {
    const request = await requireAttempt(stores, clinicId, input.requestId, input.patientId);
    const followUpCase = await stores.cases.get(clinicId, request.caseId, { forUpdate: true });
    if (followUpCase === undefined) {
      throw new NotFoundError('FollowUpCase', request.caseId);
    }
    const channel = input.channel ?? request.channel;
    const saved = await stores.contacts.saveCommunication(clinicId, {
      id: input.id,
      clinicId,
      patientId: request.patientId,
      caseId: request.caseId,
      requestId: request.id,
      ...(channel === undefined ? {} : { channel }),
      status: input.status,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.sentAt === undefined ? {} : { sentAt: input.sentAt }),
      ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
      sender: input.sender,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
      ...(input.lastUpdated === undefined ? {} : { lastUpdated: input.lastUpdated }),
      recordedAt: now,
    });
    const outcome = effectiveOutcome(saved.communication);
    if (!saved.changed || outcome === undefined || outcome === effectiveOutcome(saved.previous)) {
      return {
        communication: saved.communication,
        changed: saved.changed,
        stale: saved.stale,
        reactions: [],
      };
    }
    const writer = new CaseWriter(stores, deps.ids, clinicId);
    const actor: CaseEventActor =
      input.sender.type === 'user'
        ? { type: 'user', ...(input.sender.id === undefined ? {} : { id: input.sender.id }) }
        : { type: 'patient', id: request.patientId };
    await writer.audit(followUpCase, 'contact_outcome_recorded', actor, now, {
      requestId: request.id,
      communicationId: saved.communication.id,
      outcome,
      status: saved.communication.status,
      ...(channel === undefined ? {} : { channel }),
    });
    const reactions = await react(
      { stores, writer, deps, catalog, now },
      {
        followUpCase,
        request,
        communication: saved.communication,
        outcome,
        actor,
        clinicAllowsContact: clinic?.active === true && clinic.settings.allowPatientContact,
      },
    );
    if (input.sender.type === 'user') {
      await writer.emit('contact.outcome_recorded', now, {
        caseId: followUpCase.id,
        patientId: followUpCase.patientId,
        requestId: request.id,
        communicationId: saved.communication.id,
        ...(channel === undefined ? {} : { channel }),
        outcome,
      });
    }
    return {
      communication: saved.communication,
      changed: true,
      stale: false,
      outcome,
      reactions,
    };
  });
}

interface ReactionContext {
  readonly stores: TransactionalStores;
  readonly writer: CaseWriter;
  readonly deps: OutcomeDeps;
  readonly catalog: Catalog;
  readonly now: Date;
}

async function react(
  context: ReactionContext,
  input: {
    readonly followUpCase: FollowUpCase;
    readonly request: ContactRequest;
    readonly communication: ContactCommunication;
    readonly outcome: ContactOutcome;
    readonly actor: CaseEventActor;
    readonly clinicAllowsContact: boolean;
  },
): Promise<ContactReaction[]> {
  const { stores, writer, now } = context;
  const { followUpCase, request, communication, outcome, actor } = input;
  const reactions: ContactReaction[] = [];
  const active = isActiveCaseStatus(followUpCase.status);
  if (ANSWERED_OUTCOMES.has(outcome)) {
    await clearContactFlags(stores, followUpCase.clinicId, followUpCase.patientId, now);
  }
  if (outcome === 'treated_elsewhere' && active) {
    await resolveCase(writer, followUpCase, {
      kind: 'handled_outside',
      actor,
      now,
      payload: { requestId: request.id, outcome },
    });
    reactions.push('case_resolved_handled_outside');
  } else if (outcome === 'declined' && active) {
    await resolveCase(writer, followUpCase, {
      kind: 'patient_declined',
      actor,
      now,
      payload: { requestId: request.id, outcome },
    });
    reactions.push('case_resolved_patient_declined');
  } else if (outcome === 'wrong_number') {
    await stores.contacts.saveFlag(followUpCase.clinicId, {
      clinicId: followUpCase.clinicId,
      patientId: followUpCase.patientId,
      issue: 'wrong_number',
      raisedAt: now,
      communicationId: communication.id,
      ...(communication.channel === undefined ? {} : { channel: communication.channel }),
    });
    reactions.push('contact_data_flagged');
    if (active && (await callNow(context, followUpCase, input.clinicAllowsContact))) {
      reactions.push('call_requested');
    }
  }
  if (reactions.length === 0) {
    reactions.push('none');
  }
  return reactions;
}

/** Clears the patient's standing contact data flags: an attempt reached them. */
export async function clearContactFlags(
  stores: TransactionalStores,
  clinicId: ClinicId,
  patientId: PatientId,
  now: Date,
): Promise<number> {
  const flags = await stores.contacts.listFlags(clinicId, patientId);
  let cleared = 0;
  for (const flag of flags) {
    if (flag.clearedAt === undefined) {
      await stores.contacts.saveFlag(clinicId, { ...flag, clearedAt: now });
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * A wrong number moves the front-desk call forward: when the case's policy
 * still has a call step ahead and the team has no call to make yet, the
 * call is requested now (the policy's own call step then has nothing left
 * to do). Respects the contact rules (clinic setting, opt-out, backfill,
 * probable-only cases).
 */
async function callNow(
  context: ReactionContext,
  followUpCase: FollowUpCase,
  clinicAllowsContact: boolean,
): Promise<boolean> {
  const { stores, writer, deps, catalog, now } = context;
  const { clinicId } = followUpCase;
  const reasons = await caseExpectations(stores, clinicId, followUpCase);
  const policy = policyOf(catalog, reasons, followUpCase);
  const callStep = policy.steps
    .slice(followUpCase.escalationStep)
    .find((step) => step.action === 'request_patient_contact' && step.channel === 'phone_call');
  if (callStep === undefined) {
    return false;
  }
  const requests = await stores.contacts.listRequestsForCase(clinicId, followUpCase.id);
  if (callAlreadyRequested(requests)) {
    return false;
  }
  const conditions = await stores.conditions.listByPatient(clinicId, followUpCase.patientId);
  const decision = decidePatientContact({
    clinicAllowsContact,
    patientOptedOut: await hasOptedOut(stores, clinicId, followUpCase.patientId),
    backfill: followUpCase.origin === 'backfill',
    lowConfidence: isLowConfidenceCase(reasons, conditions, catalog),
    channel: 'phone_call',
    now,
    windowDays: deps.settings.patientContactWindowDays,
  });
  if (!decision.allowed) {
    return false;
  }
  await openContactAttempt(
    { stores, writer, ids: deps.ids },
    {
      followUpCase,
      purpose: contactPurpose(catalog, reasons),
      channel: 'phone_call',
      trigger: 'wrong_number',
      answerWindowDays: callStep.answerWindowDays ?? deps.settings.patientContactDueInDays,
      actor: { type: 'system', id: policy.id ?? 'escalation' },
      now,
    },
  );
  return true;
}
