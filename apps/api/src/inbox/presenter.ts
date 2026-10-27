import {
  type Catalog,
  type ClinicId,
  conditionId,
  type Expectation,
  type FhirResourceJson,
  type FollowUpCase,
  type NoteReceivedEvent,
  type PatientCondition,
  type PatientContactStatus,
  type PatientId,
  practitionerId,
} from '@follow-up-engine/core';
import { taskPriority } from '@follow-up-engine/fhir';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type {
  CaseDetail,
  CaseReasonView,
  CaseTimelineEntry,
  CaseView,
  ConditionView,
  PatientContact,
  PatientDetail,
  PatientExpectationView,
} from '../http/schemas.ts';
import { excerptAround, humanName, patientSummary, sourceDisplay } from './fhir-display.ts';
import {
  COORDINATOR_LABEL,
  DEFAULT_SUGGESTED_ACTION,
  FRONT_DESK_LABEL,
  LAYER_FALLBACK_LABELS,
  QUALITY_FINDING_LABEL,
  timelineLabel,
} from './labels.ts';
import { icd10Label } from './terminology.ts';

const MS_PER_DAY = 86_400_000;

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

/** Display name → owner id, so the inbox can filter by what it shows. */
export function assigneeIdFromLabel(label: string): string {
  return Object.entries(ROLE_LABELS).find(([, name]) => name === label)?.[0] ?? label;
}

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

function contactView(status: PatientContactStatus): PatientContact {
  return {
    allowed: status.allowed,
    optedOut: status.optedOut,
    ...(status.lastContactAt === undefined
      ? {}
      : { lastContactAt: status.lastContactAt.toISOString() }),
  };
}

/** A condition the clinician rejected: closed with confidence 0 by a named user. */
function isRejected(condition: PatientCondition): boolean {
  return (
    condition.status === 'resolved' &&
    condition.confidence === 0 &&
    condition.confirmedBy !== undefined
  );
}

export function conditionView(condition: PatientCondition): ConditionView {
  return {
    id: conditionId(condition),
    code: condition.code.code,
    display: icd10Label(condition.code.code, condition.code.display),
    status: isRejected(condition) ? 'rejected' : condition.status,
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
 * Turns engine objects into the inbox contract (Spanish labels, display
 * names, evidence with the surrounding note). One presenter per request:
 * it caches what several cases of the same patient share.
 */
export class InboxPresenter {
  readonly #runtime: EngineRuntime;
  readonly #clinicId: ClinicId;
  readonly #catalog: Catalog;
  readonly now: Date;
  readonly #expectations = new Map<string, Expectation>();
  readonly resource: (key: string) => Promise<FhirResourceJson | undefined>;
  readonly #notes: (patientId: PatientId) => Promise<readonly NoteReceivedEvent[]>;
  readonly #contact: (patientId: PatientId) => Promise<PatientContactStatus>;

  private constructor(runtime: EngineRuntime, clinicId: ClinicId, catalog: Catalog) {
    this.#runtime = runtime;
    this.#clinicId = clinicId;
    this.#catalog = catalog;
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
  }

  static async create(runtime: EngineRuntime, clinicId: ClinicId): Promise<InboxPresenter> {
    return new InboxPresenter(runtime, clinicId, await runtime.engine.catalog(clinicId));
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
    const [patientResource, contact, assignee, reasons] = await Promise.all([
      this.resource(`Patient/${followUpCase.patientId}`),
      this.#contact(followUpCase.patientId),
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
      assignee,
      origin: followUpCase.origin,
      openedAt: followUpCase.createdAt.toISOString(),
      ...(followUpCase.nextActionAt === undefined
        ? {}
        : { nextActionAt: followUpCase.nextActionAt.toISOString() }),
      ...(followUpCase.releaseAt === undefined
        ? {}
        : { releaseAt: followUpCase.releaseAt.toISOString() }),
      ...(followUpCase.snoozedUntil === undefined
        ? {}
        : { snoozedUntil: followUpCase.snoozedUntil.toISOString() }),
      reasons,
      suggestedAction: this.#suggestedAction(expectations),
      patientContact: contactView(contact),
    };
  }

  async caseDetail(followUpCase: FollowUpCase): Promise<CaseDetail> {
    const { stores } = this.#runtime.storage;
    const [view, events, feedback] = await Promise.all([
      this.caseView(followUpCase, true),
      stores.audit.listForCase(this.#clinicId, followUpCase.id),
      stores.feedback.listForCase(this.#clinicId, followUpCase.id),
    ]);
    const names = new Map<string, string>();
    for (const event of events) {
      const assignee = event.payload['assignee'];
      if (event.type === 'assigned' && typeof assignee === 'string') {
        names.set(assignee, await this.personName(assignee));
      }
    }
    const timeline: CaseTimelineEntry[] = events.map((event) => ({
      at: event.at.toISOString(),
      type: event.type,
      actor: {
        type: event.actor.type,
        ...(event.actor.id === undefined ? {} : { id: event.actor.id }),
      },
      label: timelineLabel(
        event,
        (ruleId) => this.reasonLabel(ruleId),
        (id) => (id === undefined ? FRONT_DESK_LABEL : (names.get(id) ?? id)),
      ),
    }));
    const latest = feedback.at(-1);
    return {
      ...view,
      timeline,
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

  async reasonView(expectation: Expectation, withExcerpt: boolean): Promise<CaseReasonView> {
    const [source, evidence] = await Promise.all([
      this.resource(`${expectation.source.resourceType}/${expectation.source.id}`),
      this.#evidence(expectation, withExcerpt),
    ]);
    const overdueMs = this.now.getTime() - expectation.dueAt.getTime();
    return {
      expectationId: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: this.reasonLabel(expectation.ruleId, expectation),
      dueAt: expectation.dueAt.toISOString(),
      overdueDays: Math.max(0, Math.floor(overdueMs / MS_PER_DAY)),
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
    return {
      id: expectation.id,
      ruleId: expectation.ruleId,
      layer: expectation.layer,
      label: this.reasonLabel(expectation.ruleId, expectation),
      status: expectation.status,
      dueAt: expectation.dueAt.toISOString(),
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
    const [resource, conditions, ascending, findings, contact] = await Promise.all([
      this.resource(`Patient/${patientId}`),
      stores.conditions.listByPatient(this.#clinicId, patientId),
      stores.expectations.listByPatient(this.#clinicId, patientId),
      stores.qualityFindings.listByPatient(this.#clinicId, patientId),
      this.#contact(patientId),
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
    const contactInfo = contactView(contact);
    return {
      patient: { ...summary, contact: contactInfo },
      contact: contactInfo,
      conditions: conditions.map(conditionView),
      expectations: expectations.map((expectation) => this.expectationView(expectation)),
      qualityFindings: findings.map((finding) => ({
        id: finding.id,
        code: finding.kind,
        documentId: finding.source.id,
        at: finding.detectedAt.toISOString(),
        label: QUALITY_FINDING_LABEL,
      })),
    };
  }
}
