import type {
  ClinicalEvent,
  DueExplanation,
  EnrollmentExplanation,
  Expectation,
  ExpectationExplanation,
  FhirResourceJson,
  FulfillmentExplanation,
  JsonValue,
  ProtocolSchedule,
} from '@follow-up-engine/core';
import type { ProtocolRefView } from '../http/schemas.ts';
import type { DocumentRefView, PatientDocumentView, ReasonWhyView } from '../http/why-schemas.ts';
import type { ApiMessages, WhyDocumentKind } from '../i18n/index.ts';
import { excerptAround } from './fhir-display.ts';
import { icd10Label, loincLabel } from './terminology.ts';

/*
 * "Why this?" (HIP-142): words the engine's explanation of an expectation
 * (`engine.explain`) for the clinician, and lists the patient's documents
 * for the drawer the doctor verifies a case against. Everything cited is a
 * stored record of the patient; dates are the clinic's calendar days.
 */

type Json = JsonValue | undefined;

function record(value: Json): Readonly<Record<string, Json>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, Json>>)
    : undefined;
}

function str(value: Json): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Events that are documents the clinician can read (not engine derivations or flags). */
const DOCUMENT_EVENTS: ReadonlySet<ClinicalEvent['type']> = new Set([
  'note.received',
  'service_request.created',
  'result.received',
  'medication.prescribed',
  'encounter.finished',
  'appointment.booked',
  'appointment.cancelled',
  'condition.recorded',
  'allergy.recorded',
]);

function refKey(ref: { readonly resourceType: string; readonly id: string }): string {
  return `${ref.resourceType}/${ref.id}`;
}

function kindOf(event: ClinicalEvent): WhyDocumentKind {
  switch (event.type) {
    case 'note.received':
      return 'note';
    case 'service_request.created':
      return 'order';
    case 'result.received':
      return 'result';
    case 'medication.prescribed':
      return 'prescription';
    case 'encounter.finished':
      return 'visit';
    case 'appointment.booked':
    case 'appointment.cancelled':
      return 'appointment';
    case 'condition.recorded':
      return 'diagnosis';
    case 'allergy.recorded':
      return 'allergy';
    case 'plan.extracted':
    case 'patient.opted_out':
    case 'patient.language_recorded':
    case 'record.withdrawn':
      return 'other';
  }
}

function round(value: number): number {
  return Math.round(value);
}

export class WhyPresenter {
  readonly #t: ApiMessages;
  readonly #day: Intl.DateTimeFormat;
  readonly #resource: (key: string) => Promise<FhirResourceJson | undefined>;
  readonly #userName: (id: string) => Promise<string>;

  constructor(
    t: ApiMessages,
    timeZone: string,
    resource: (key: string) => Promise<FhirResourceJson | undefined>,
    userName: (id: string) => Promise<string>,
  ) {
    this.#t = t;
    let day: Intl.DateTimeFormat;
    try {
      day = new Intl.DateTimeFormat(t.intlLocale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone,
      });
    } catch {
      day = new Intl.DateTimeFormat(t.intlLocale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
    this.#day = day;
    this.#resource = resource;
    this.#userName = userName;
  }

  /** A calendar day in the clinic's zone, in the request's language ("Jan 21, 2026"). */
  date(date: Date): string {
    return this.#day.format(date);
  }

  #codeLabel(code: { readonly code: string; readonly display?: string }): string {
    return loincLabel(this.#t, code.code) ?? code.display ?? code.code;
  }

  /** Who wrote a note: the host's `author` display or Practitioner, else the visit's practitioner. */
  async #author(resource: FhirResourceJson | undefined): Promise<string | undefined> {
    const authors = resource?.['author'];
    const first = record(Array.isArray(authors) ? (authors[0] as Json) : undefined);
    const display = str(first?.['display']);
    if (display !== undefined) {
      return display;
    }
    const reference = str(first?.['reference']);
    if (reference?.startsWith('Practitioner/') === true) {
      return this.#userName(reference.slice('Practitioner/'.length));
    }
    return undefined;
  }

  /** One stored record of the patient as a cited document. */
  async documentRef(event: ClinicalEvent): Promise<DocumentRefView> {
    const t = this.#t;
    const resource = await this.#resource(refKey(event.source));
    const status = str(resource?.['status']);
    const kind = kindOf(event);
    const base = {
      resourceType: event.source.resourceType,
      id: event.source.id,
      kind,
      kindLabel: t.why.kinds[kind],
      at: event.occurredAt.toISOString(),
      ...(status === undefined ? {} : { status }),
      ...(event.encounterId === undefined ? {} : { encounterId: event.encounterId }),
    };
    switch (event.type) {
      case 'note.received': {
        const author = await this.#author(resource);
        return {
          ...base,
          at: event.authoredAt.toISOString(),
          title: t.why.kinds.note,
          documentId: event.documentId,
          ...(event.specialty === undefined ? {} : { specialty: event.specialty }),
          ...(author === undefined ? {} : { author }),
        };
      }
      case 'service_request.created':
        return { ...base, title: this.#codeLabel(event.code), code: event.code.code };
      case 'result.received': {
        const interpretation = event.severity === 'critical' ? 'critical' : event.interpretation;
        const value =
          event.value !== undefined
            ? `${String(event.value.value)}${event.value.unit === undefined ? '' : ` ${event.value.unit}`}`
            : event.valueDate === undefined
              ? undefined
              : this.date(event.valueDate);
        const interpretationLabel =
          interpretation === 'unknown' ? undefined : t.why.interpretations[interpretation];
        return {
          ...base,
          title: this.#codeLabel(event.code),
          code: event.code.code,
          interpretation,
          ...(value === undefined ? {} : { value }),
          ...(value === undefined && interpretationLabel === undefined
            ? {}
            : {
                detail:
                  value === undefined
                    ? (interpretationLabel ?? '')
                    : t.why.value(value, interpretationLabel),
              }),
        };
      }
      case 'medication.prescribed': {
        const parts = [
          event.dosageText,
          event.durationDays === undefined ? undefined : t.why.durationDays(event.durationDays),
        ].filter((part): part is string => part !== undefined && part !== '');
        return {
          ...base,
          at: event.startAt.toISOString(),
          title: event.medication.text,
          ...(event.medication.code === undefined ? {} : { code: event.medication.code.code }),
          ...(parts.length === 0 ? {} : { detail: parts.join(' · ') }),
        };
      }
      case 'encounter.finished':
        return {
          ...base,
          title: t.why.kinds.visit,
          ...(event.specialty === undefined ? {} : { specialty: event.specialty }),
        };
      case 'appointment.booked':
        return {
          ...base,
          at: event.scheduledFor.toISOString(),
          title: t.why.kinds.appointment,
          ...(event.specialty === undefined ? {} : { specialty: event.specialty }),
        };
      case 'appointment.cancelled':
        return {
          ...base,
          at: event.scheduledFor.toISOString(),
          title: t.why.kinds.appointment,
          detail: t.why.cancelled,
        };
      case 'condition.recorded':
        return {
          ...base,
          title: icd10Label(t, event.code.code, event.code.display),
          code: event.code.code,
          detail: t.why.verification[event.verification],
        };
      case 'allergy.recorded':
        return {
          ...base,
          title: event.noKnownAllergy
            ? t.why.noKnownAllergy
            : (event.text ?? event.code?.display ?? t.why.kinds.allergy),
          ...(event.code === undefined ? {} : { code: event.code.code }),
          ...(event.criticality === undefined ? {} : { detail: event.criticality }),
        };
      case 'plan.extracted':
      case 'patient.opted_out':
      case 'patient.language_recorded':
      case 'record.withdrawn':
        return { ...base, title: t.why.kinds.other };
    }
  }

  /**
   * Every document of the patient, oldest first: notes with their full
   * text, orders, results, prescriptions, visits, appointments, diagnoses,
   * allergies. The latest version of each resource; withdrawn ones flagged.
   */
  async documents(events: readonly ClinicalEvent[]): Promise<PatientDocumentView[]> {
    const withdrawnAt = new Map<string, number>();
    for (const event of events) {
      if (event.type === 'record.withdrawn') {
        const key = refKey(event.source);
        withdrawnAt.set(key, Math.max(withdrawnAt.get(key) ?? 0, event.occurredAt.getTime()));
      }
    }
    const latest = new Map<string, ClinicalEvent>();
    for (const event of events) {
      if (DOCUMENT_EVENTS.has(event.type)) {
        // A later version (a cancelled booking, a corrected result) replaces the earlier one.
        latest.set(
          `${refKey(event.source)}#${event.type === 'appointment.cancelled' ? 'appointment.booked' : event.type}`,
          event,
        );
      }
    }
    const views = await Promise.all(
      [...latest.values()].map(async (event) => {
        const view = await this.documentRef(event);
        const withdrawn = withdrawnAt.get(refKey(event.source));
        return {
          ...view,
          ...(event.type === 'note.received' ? { text: event.text } : {}),
          ...(withdrawn !== undefined && withdrawn >= event.occurredAt.getTime()
            ? { withdrawn: true }
            : {}),
        };
      }),
    );
    return views.sort(
      (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
  }

  #dueText(
    due: DueExplanation,
    anchor: DocumentRefView | undefined,
    schedule: ProtocolSchedule | undefined,
  ): string {
    const t = this.#t;
    if (schedule?.type === 'gestational_window') {
      return t.why.dueAtWeek(this.date(due.dueAt), schedule.toWeek);
    }
    if (anchor === undefined || due.anchorAt === undefined || due.days === undefined) {
      return t.why.dueOnly(this.date(due.dueAt));
    }
    const what = anchor.value === undefined ? anchor.title : `${anchor.title} ${anchor.value}`;
    return t.why.dueMath(
      this.date(due.dueAt),
      `${t.why.anchorRoles[due.anchorRole]}: ${what}`,
      this.date(due.anchorAt),
      due.days,
    );
  }

  #basisText(explanation: ExpectationExplanation): string {
    const t = this.#t;
    const { due } = explanation;
    const days = due.configuredDays ?? due.days ?? 0;
    switch (due.basis) {
      case 'rule_days':
        return t.why.basis.rule_days(days);
      case 'critical_result':
        return t.why.basis.critical_result(days);
      case 'treatment_end':
        return t.why.basis.treatment_end(due.treatmentDays, due.configuredDays ?? 0);
      case 'plan_date':
        return t.why.basis.plan_date;
      case 'cadence': {
        const cadence = explanation.cadence;
        return cadence?.multiplier === undefined || cadence.usualIntervalDays === undefined
          ? t.why.noPattern
          : t.why.basis.cadence(cadence.multiplier, round(cadence.usualIntervalDays));
      }
      case 'protocol_interval':
        return t.why.basis.protocol_interval(days);
      case 'protocol_treatment_change':
        return t.why.basis.protocol_treatment_change;
      case 'protocol_gestational_age':
        return t.why.basis.protocol_gestational_age(explanation.protocol?.gestationalWeeks);
      case 'protocol_gestational_window':
        return t.why.basis.protocol_gestational_window;
      case 'protocol_after_outcome':
        return t.why.basis.protocol_after_outcome(days);
      case 'protocol_ckd_stage': {
        const stage = explanation.protocol?.ckdStage;
        const text = [stage?.gfr, stage?.albuminuria].filter(Boolean).join(' ');
        return t.why.basis.protocol_ckd_stage(text === '' ? undefined : text);
      }
    }
  }

  #fulfillText(fulfilledBy: FulfillmentExplanation): string {
    const t = this.#t;
    const booking = fulfilledBy.events.includes('appointment.booked');
    if (fulfilledBy.code !== undefined) {
      const test = this.#codeLabel(fulfilledBy.code);
      return fulfilledBy.orderId === undefined
        ? t.why.fulfill.result(test, fulfilledBy.code.code, fulfilledBy.equivalentCodes.length)
        : t.why.fulfill.orderResult(test, fulfilledBy.code.code);
    }
    switch (fulfilledBy.expects) {
      case 'lab':
      case 'imaging':
        return t.why.fulfill.anyResult(t.why.expectKinds[fulfilledBy.expects]);
      case 'session':
        return t.why.fulfill.session(booking);
      case 'follow_up_visit':
        return t.why.fulfill.visit(booking);
      case 'other':
        return t.why.fulfill.other(booking);
    }
  }

  #scheduleText(schedule: ProtocolSchedule): string {
    const s = this.#t.why.schedule;
    switch (schedule.type) {
      case 'interval':
        return s.interval(schedule.everyDays);
      case 'treatment_change':
        return s.treatment_change(
          schedule.afterChangeDays,
          schedule.everyDays,
          schedule.untilStable === undefined
            ? undefined
            : s.titration(schedule.untilStable.everyDays, schedule.untilStable.controls),
        );
      case 'gestational_age':
        return s.gestational_age(
          schedule.intervals
            .map((interval) => s.gestationalInterval(interval.untilWeek, interval.everyDays))
            .join('; '),
        );
      case 'gestational_window':
        return s.gestational_window(schedule.fromWeek, schedule.toWeek);
      case 'after_outcome':
        return s.after_outcome(
          this.#t.why.enrollment.outcomes[schedule.outcome] ?? schedule.outcome,
          schedule.withinDays,
        );
      case 'ckd_stage':
        return s.ckd_stage(schedule.everyDays);
    }
  }

  async #enrollment(
    enrollment: EnrollmentExplanation,
  ): Promise<NonNullable<ReasonWhyView['protocol']>['enrollment']> {
    const t = this.#t;
    const evidence = await Promise.all(enrollment.evidence.map((event) => this.documentRef(event)));
    const activeTreatment =
      enrollment.activeTreatment === undefined
        ? undefined
        : await this.documentRef(enrollment.activeTreatment);
    const endedBy =
      enrollment.endedBy === undefined ? undefined : await this.documentRef(enrollment.endedBy);
    const condition = enrollment.condition;
    const diagnosis =
      condition === undefined
        ? ''
        : `${condition.code.code} ${icd10Label(t, condition.code.code, condition.code.display)}`;
    const first = evidence[0];
    const last = evidence.at(-1);
    let text = '';
    if (enrollment.episode === 'not_enrolled') {
      text = t.why.enrollment.notEnrolled;
    } else if (enrollment.episode === 'ended') {
      text = t.why.enrollment.ended(
        t.why.enrollment.outcomes[enrollment.outcome ?? ''] ?? enrollment.outcome ?? '',
        endedBy === undefined ? '' : this.date(new Date(endedBy.at)),
      );
    } else if (first === undefined || last === undefined) {
      text = t.why.enrollment.unknown(diagnosis);
    } else {
      const at = this.date(new Date(first.at));
      switch (enrollment.basis) {
        case 'diagnosis':
          text = t.why.enrollment.diagnosis(diagnosis, at);
          break;
        case 'note':
          text = t.why.enrollment.note(diagnosis, at);
          break;
        case 'medication':
          text = t.why.enrollment.medication(first.title, at, diagnosis);
          break;
        case 'results': {
          const threshold = enrollment.threshold;
          const bound =
            threshold === undefined
              ? ''
              : threshold.gte !== undefined
                ? `≥ ${String(threshold.gte)}`
                : `< ${String(threshold.lt ?? '')}`;
          const confirm =
            threshold?.confirm === undefined
              ? ''
              : ` (${t.why.enrollment.confirm(threshold.confirm.count, threshold.confirm.minDaysApart)})`;
          text = t.why.enrollment.results(
            evidence.length,
            threshold === undefined ? first.title : this.#codeLabel(threshold.code),
            `${bound}${confirm}`,
            diagnosis,
          );
          break;
        }
        case 'record':
        case undefined:
          text = t.why.enrollment.record(first.title, at, diagnosis);
          break;
      }
    }
    return {
      episode: enrollment.episode,
      ...(enrollment.basis === undefined ? {} : { basis: enrollment.basis }),
      ...(condition === undefined
        ? {}
        : {
            condition: {
              code: condition.code.code,
              display: icd10Label(t, condition.code.code, condition.code.display),
              status: condition.status,
              sourceType: condition.sourceType,
              ...(condition.evidence === undefined ? {} : { quote: condition.evidence.quote }),
            },
          }),
      evidence,
      ...(enrollment.threshold === undefined ? {} : { threshold: enrollment.threshold }),
      ...(activeTreatment === undefined ? {} : { activeTreatment }),
      ...(endedBy === undefined ? {} : { endedBy }),
      text,
      ...(activeTreatment === undefined
        ? {}
        : {
            activeTreatmentText: t.why.enrollment.activeTreatment(
              activeTreatment.title,
              this.date(new Date(activeTreatment.at)),
            ),
          }),
    };
  }

  /** The "Why this?" block of one reason or expectation. */
  async why(
    expectation: Expectation,
    explanation: ExpectationExplanation,
    protocolRef: ProtocolRefView | undefined,
  ): Promise<ReasonWhyView> {
    const t = this.#t;
    const { due, fulfilledBy } = explanation;
    const [anchor, closedBy, tooEarly] = await Promise.all([
      due.anchor === undefined ? undefined : this.documentRef(due.anchor),
      explanation.closedBy === undefined ? undefined : this.documentRef(explanation.closedBy),
      due.tooEarly === undefined ? undefined : this.documentRef(due.tooEarly),
    ]);
    const plan = explanation.plan;
    const note = plan?.note === undefined ? undefined : await this.documentRef(plan.note);
    const protocol = explanation.protocol;
    const cadence = explanation.cadence;
    return {
      layer: explanation.layer,
      due: {
        basis: due.basis,
        anchorRole: due.anchorRole,
        ...(anchor === undefined ? {} : { anchor }),
        ...(due.anchorAt === undefined ? {} : { anchorAt: due.anchorAt.toISOString() }),
        ...(due.days === undefined ? {} : { days: due.days }),
        ...(due.configuredDays === undefined ? {} : { configuredDays: due.configuredDays }),
        ...(due.treatmentDays === undefined ? {} : { treatmentDays: due.treatmentDays }),
        ...(due.bookingToleranceDays === undefined
          ? {}
          : { bookingToleranceDays: due.bookingToleranceDays }),
        dueAt: expectation.dueAt.toISOString(),
        text: this.#dueText(due, anchor, explanation.protocol?.schedule),
        basisText: this.#basisText(explanation),
        ...(due.bookingToleranceDays === undefined
          ? {}
          : { toleranceText: t.why.bookingTolerance(due.bookingToleranceDays) }),
        ...(tooEarly === undefined
          ? {}
          : {
              tooEarly,
              tooEarlyText: t.why.tooEarly(tooEarly.title, this.date(new Date(tooEarly.at))),
            }),
      },
      fulfilledBy: {
        expects: fulfilledBy.expects,
        ...(fulfilledBy.code === undefined ? {} : { code: fulfilledBy.code }),
        equivalentCodes: [...fulfilledBy.equivalentCodes],
        ...(fulfilledBy.orderId === undefined ? {} : { orderId: fulfilledBy.orderId }),
        events: [...fulfilledBy.events],
        specialties: [...fulfilledBy.specialties],
        text: this.#fulfillText(fulfilledBy),
      },
      ...(closedBy === undefined ? {} : { closedBy }),
      ...(plan === undefined
        ? {}
        : {
            plan: {
              documentId: plan.documentId,
              quote: plan.quote,
              ...(plan.note === undefined
                ? {}
                : { authoredAt: plan.note.authoredAt.toISOString() }),
              ...(note?.author === undefined ? {} : { author: note.author }),
              ...(plan.specialty === undefined ? {} : { specialty: plan.specialty }),
              ...(plan.note === undefined
                ? {}
                : { noteExcerpt: excerptAround(plan.note.text, plan.quote) }),
              ...(plan.item === undefined ? {} : { itemDescription: plan.item.description }),
              ...(note === undefined ? {} : { note }),
            },
          }),
      ...(protocol === undefined
        ? {}
        : {
            protocol: {
              id: protocol.protocolId,
              ...(protocolRef?.name === undefined ? {} : { name: protocolRef.name }),
              version: protocol.version,
              ...(protocol.currentVersion === undefined
                ? {}
                : { currentVersion: protocol.currentVersion }),
              ...(protocol.status === undefined
                ? {}
                : {
                    status: protocol.status,
                    statusText: protocol.status === 'draft' ? t.why.draft : t.why.validated,
                  }),
              title: t.why.protocolVersion(
                protocolRef?.name ?? protocol.protocolId,
                protocol.version,
              ),
              ...(protocol.itemKey === undefined ? {} : { itemKey: protocol.itemKey }),
              ...(protocol.schedule === undefined
                ? {}
                : { scheduleText: this.#scheduleText(protocol.schedule) }),
              enrollment: await this.#enrollment(protocol.enrollment),
              ...(protocol.ckdStage === undefined
                ? {}
                : {
                    ckdStage: {
                      ...(protocol.ckdStage.gfr === undefined
                        ? {}
                        : { gfr: protocol.ckdStage.gfr }),
                      ...(protocol.ckdStage.albuminuria === undefined
                        ? {}
                        : { albuminuria: protocol.ckdStage.albuminuria }),
                    },
                  }),
              ...(protocol.gestationalWeeks === undefined
                ? {}
                : { gestationalWeeks: protocol.gestationalWeeks }),
            },
          }),
      ...(cadence === undefined
        ? {}
        : {
            cadence: {
              ...(cadence.specialty === undefined ? {} : { specialty: cadence.specialty }),
              visits: cadence.visits.map((visit) => {
                const encounterId = visit.encounterId ?? visit.source.id;
                return {
                  at: visit.occurredAt.toISOString(),
                  encounterId,
                  inPattern: cadence.patternVisitIds.includes(encounterId),
                };
              }),
              ...(cadence.usualIntervalDays === undefined
                ? {}
                : { usualIntervalDays: round(cadence.usualIntervalDays) }),
              ...(cadence.multiplier === undefined ? {} : { multiplier: cadence.multiplier }),
              expectedBy: expectation.dueAt.toISOString(),
              text:
                cadence.visits.length === 0
                  ? t.why.noPattern
                  : t.why.cadence(
                      cadence.visits.length,
                      cadence.patternVisitIds.length,
                      cadence.usualIntervalDays === undefined
                        ? undefined
                        : round(cadence.usualIntervalDays),
                      cadence.multiplier,
                      this.date(expectation.dueAt),
                    ),
            },
          }),
    };
  }
}
