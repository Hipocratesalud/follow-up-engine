import type { EscalationAction, EscalationPolicy } from '../../config/common.ts';
import {
  ACTIVE_CASE_STATUSES,
  type CaseEventActor,
  type CaseStatus,
  type FollowUpCase,
} from '../../domain/case.ts';
import type { CaseId, ClinicId } from '../../domain/ids.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores, UnitOfWork } from '../../ports/unit-of-work.ts';
import { CaseWriter, withoutKey } from '../case-manager/case-writer.ts';
import { isActiveCaseStatus } from '../case-manager/state-machine.ts';
import type { Catalog } from '../catalog.ts';
import { hasOptedOut, lastPatientContactAt } from '../patient-contact/history.ts';
import {
  decidePatientContact,
  isLowConfidenceCase,
  type PatientContactDecision,
  type PatientContactDenial,
} from '../patient-contact/policy.ts';
import type { EngineSettings } from '../settings.ts';
import { addDays } from '../support/time.ts';
import { caseExpectations, nextActionAfter, policyOf, withNextActionAt } from './schedule.ts';

export interface EscalationDeps {
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly clinics: ClinicDirectory;
  readonly loadCatalog: (clinicId: ClinicId) => Promise<Catalog>;
}

export interface EscalationStepRecord {
  readonly caseId: CaseId;
  readonly step: number;
  readonly action: EscalationAction;
}

export interface EscalationReport {
  readonly clinicId: ClinicId;
  readonly casesProcessed: number;
  readonly woken: readonly CaseId[];
  readonly steps: readonly EscalationStepRecord[];
  readonly contactsRequested: readonly CaseId[];
  readonly contactsSkipped: readonly {
    readonly caseId: CaseId;
    readonly reason: PatientContactDenial;
  }[];
}

interface MutableReport {
  readonly woken: CaseId[];
  readonly steps: EscalationStepRecord[];
  readonly contactsRequested: CaseId[];
  readonly contactsSkipped: { caseId: CaseId; reason: PatientContactDenial }[];
}

/**
 * The escalation sweep. For each active case whose next action is due, runs
 * the steps of its policy that are due (notify the owner, raise priority,
 * ask the host to contact the patient, escalate to coordination, mark lost
 * to follow-up) and wakes snoozed cases whose snooze ended. Every step is
 * audited and emitted through the outbox in the same transaction.
 */
export async function runEscalation(
  deps: EscalationDeps,
  clinicId: ClinicId,
  now: Date,
): Promise<EscalationReport> {
  const [catalog, clinic] = await Promise.all([
    deps.loadCatalog(clinicId),
    deps.clinics.get(clinicId),
  ]);
  const clinicAllowsContact = clinic?.active === true && clinic.settings.allowPatientContact;
  const report: MutableReport = {
    woken: [],
    steps: [],
    contactsRequested: [],
    contactsSkipped: [],
  };
  const processed = new Set<CaseId>();
  for (;;) {
    const handled = await deps.unitOfWork.withTransaction(clinicId, async (stores) => {
      const due = (
        await stores.cases.findDueForAction(clinicId, now, deps.settings.sweepBatchSize)
      ).filter((followUpCase) => !processed.has(followUpCase.id));
      const escalator = new CaseEscalator({
        stores,
        deps,
        catalog,
        clinicId,
        now,
        clinicAllowsContact,
        report,
      });
      for (const followUpCase of due) {
        processed.add(followUpCase.id);
        await escalator.advance(followUpCase);
      }
      return due.length;
    });
    if (handled === 0) {
      break;
    }
  }
  return { clinicId, casesProcessed: processed.size, ...report };
}

interface EscalatorInput {
  readonly stores: TransactionalStores;
  readonly deps: EscalationDeps;
  readonly catalog: Catalog;
  readonly clinicId: ClinicId;
  readonly now: Date;
  readonly clinicAllowsContact: boolean;
  readonly report: MutableReport;
}

class CaseEscalator {
  readonly #input: EscalatorInput;
  readonly #writer: CaseWriter;

  constructor(input: EscalatorInput) {
    this.#input = input;
    this.#writer = new CaseWriter(input.stores, input.deps.ids, input.clinicId);
  }

  async advance(initial: FollowUpCase): Promise<void> {
    const { stores, clinicId, catalog, now } = this.#input;
    const reasons = await caseExpectations(stores, clinicId, initial);
    const policy = policyOf(catalog, reasons);
    let current = initial;
    if (current.status === 'snoozed') {
      if (current.snoozedUntil === undefined || current.snoozedUntil.getTime() > now.getTime()) {
        return;
      }
      current = await this.#wake(current, policy);
    }
    while (
      isActiveCaseStatus(current.status) &&
      current.nextActionAt !== undefined &&
      current.nextActionAt.getTime() <= now.getTime()
    ) {
      const scheduledAt = current.nextActionAt;
      const index = current.escalationStep;
      const step = policy.steps[index];
      let continueNow = false;
      if (step !== undefined) {
        const outcome = await this.#execute(current, policy, index, step);
        current = outcome.followUpCase;
        continueNow = outcome.continueNow;
        this.#input.report.steps.push({ caseId: current.id, step: index, action: step.action });
      }
      // A step that cannot happen (a patient who opted out cannot be
      // contacted) does not make the team wait for its answer: the next step
      // (coordinator) runs right away.
      const next = isActiveCaseStatus(current.status)
        ? continueNow
          ? now
          : nextActionAfter(policy, index + 1, scheduledAt)
        : undefined;
      current = withNextActionAt({ ...current, escalationStep: index + 1 }, next);
      await stores.cases.update(clinicId, current);
    }
  }

  #actor(policy: EscalationPolicy): CaseEventActor {
    return { type: 'system', id: policy.id ?? 'escalation' };
  }

  async #wake(current: FollowUpCase, policy: EscalationPolicy): Promise<FollowUpCase> {
    const { now } = this.#input;
    const to = await this.#statusBeforeSnooze(current);
    const next = nextActionAfter(policy, current.escalationStep, now);
    const woken = await this.#writer.transition(
      withoutKey(withoutKey(current, 'snoozedUntil'), 'nextActionAt'),
      {
        to,
        type: 'reopened',
        actor: this.#actor(policy),
        at: now,
        payload: { reason: 'snooze_ended' },
        ...(next === undefined ? {} : { patch: { nextActionAt: next } }),
      },
    );
    this.#input.report.woken.push(current.id);
    return woken;
  }

  async #statusBeforeSnooze(current: FollowUpCase): Promise<CaseStatus> {
    const events = await this.#input.stores.audit.listForCase(this.#input.clinicId, current.id);
    const snoozed = events.filter((event) => event.type === 'snoozed').at(-1);
    const from = snoozed?.payload['from'];
    const resumable = ACTIVE_CASE_STATUSES.filter((status) => status !== 'snoozed');
    const match = resumable.find((status) => status === from);
    return match ?? (current.escalationStep > 0 ? 'notified' : 'open');
  }

  async #execute(
    current: FollowUpCase,
    policy: EscalationPolicy,
    index: number,
    step: EscalationPolicy['steps'][number],
  ): Promise<{ readonly followUpCase: FollowUpCase; readonly continueNow: boolean }> {
    if (step.action === 'request_patient_contact') {
      const decision = await this.#requestPatientContact(current, this.#actor(policy), {
        step: index,
        action: step.action,
      });
      return {
        followUpCase: current,
        continueNow: !decision.allowed && decision.reason === 'patient_opted_out',
      };
    }
    return { followUpCase: await this.#run(current, policy, index, step), continueNow: false };
  }

  async #run(
    current: FollowUpCase,
    policy: EscalationPolicy,
    index: number,
    step: EscalationPolicy['steps'][number],
  ): Promise<FollowUpCase> {
    const { now, deps } = this.#input;
    const actor = this.#actor(policy);
    const payload = { step: index, action: step.action };
    switch (step.action) {
      case 'notify_clinic':
        return current.status === 'open'
          ? this.#writer.transition(current, {
              to: 'notified',
              type: 'notified',
              actor,
              at: now,
              payload,
            })
          : current;
      case 'raise_priority': {
        const raised = await this.#writer.update(
          { ...current, priority: current.priority + (step.priorityDelta ?? 10), updatedAt: now },
          { type: 'escalated', actor, payload },
        );
        await this.#emitEscalated(raised, index + 1);
        return raised;
      }
      case 'request_patient_contact':
        return current;
      case 'escalate_to_coordinator': {
        const patch = { assignee: deps.settings.coordinatorOwner };
        const escalated =
          current.status === 'escalated'
            ? await this.#writer.update(
                { ...current, ...patch, updatedAt: now },
                { type: 'escalated', actor, payload },
              )
            : await this.#writer.transition(current, {
                to: 'escalated',
                type: 'escalated',
                actor,
                at: now,
                payload,
                patch,
              });
        await this.#emitEscalated(escalated, index + 1);
        return escalated;
      }
      case 'mark_lost_to_follow_up': {
        const lost = await this.#writer.transition(current, {
          to: 'lost_to_follow_up',
          type: 'lost_to_follow_up',
          actor,
          at: now,
          payload,
          patch: { resolution: { kind: 'patient_unreachable', resolvedAt: now } },
        });
        await this.#writer.emit('case.resolved', now, {
          caseId: lost.id,
          patientId: lost.patientId,
          resolution: 'patient_unreachable',
        });
        return lost;
      }
    }
  }

  async #emitEscalated(followUpCase: FollowUpCase, escalationStep: number): Promise<void> {
    await this.#writer.emit('case.escalated', this.#input.now, {
      caseId: followUpCase.id,
      patientId: followUpCase.patientId,
      escalationStep,
      priority: followUpCase.priority,
    });
  }

  async #requestPatientContact(
    current: FollowUpCase,
    actor: CaseEventActor,
    payload: { readonly step: number; readonly action: EscalationAction },
  ): Promise<PatientContactDecision> {
    const { stores, clinicId, catalog, now, deps, report } = this.#input;
    // One statement at a time: a transaction's connection is not concurrent.
    const reasons = await caseExpectations(stores, clinicId, current);
    const conditions = await stores.conditions.listByPatient(clinicId, current.patientId);
    const optedOut = await hasOptedOut(stores, clinicId, current.patientId);
    const lastContactAt = await lastPatientContactAt(stores, clinicId, current.patientId);
    const decision = decidePatientContact({
      clinicAllowsContact: this.#input.clinicAllowsContact,
      patientOptedOut: optedOut,
      backfill: current.origin === 'backfill',
      lowConfidence: isLowConfidenceCase(reasons, conditions, catalog),
      ...(lastContactAt === undefined ? {} : { lastContactAt }),
      now,
      windowDays: deps.settings.patientContactWindowDays,
    });
    if (!decision.allowed) {
      report.contactsSkipped.push({ caseId: current.id, reason: decision.reason });
      return decision;
    }
    const [first] = reasons;
    const purpose =
      (first === undefined
        ? undefined
        : catalog.definition(first.ruleId)?.suggestedAction.patientContactPurpose) ??
      'schedule_follow_up';
    const dueBy = addDays(now, deps.settings.patientContactDueInDays);
    await this.#writer.audit(current, 'patient_contact_requested', actor, now, {
      ...payload,
      purpose,
    });
    await this.#writer.emit('patient_contact.requested', now, {
      caseId: current.id,
      patientId: current.patientId,
      purpose,
      dueBy,
    });
    report.contactsRequested.push(current.id);
    return decision;
  }
}
