import type {
  AdjudicationDecision,
  AdjudicationReasonCode,
  AppointmentOriginType,
  CallOutcome,
  CaseResolutionKind,
  CaseStatus,
  ContactChannel,
  ContactOutcome,
  ContactSkipReason,
  DismissReason,
  EscalationAction,
  ExpectationLayer,
  FindingCategory,
  PatientContactDenial,
  PlanItemKind,
  QualityFindingKind,
  AnchorRole,
} from '@follow-up-engine/core';
import type { DocumentExtractionError } from '../lab/extract-document.ts';

/**
 * The shape of an API message catalog: every label and message the JSON API
 * produces for the clinic. `en.ts` and `es.ts` each `satisfies` it, so a key
 * missing from a locale (or a parameter of the wrong type) fails to compile.
 * Clinical content (note text, evidence quotes, the host's own displays,
 * names) never goes through a catalog: it is returned as written.
 */

/** "Why this?": the evidence behind each reason, in plain words (HIP-142). */
export interface WhyMessages {
  /** What a document is, by kind. */
  readonly kinds: Readonly<Record<WhyDocumentKind, string>>;
  /** What the due date counts from. */
  readonly anchorRoles: Readonly<Record<AnchorRole, string>>;
  /** "Due Jan 21, 2026 = last time done (HbA1c, Jun 10, 2025) + 90 days". */
  readonly dueMath: (due: string, anchor: string, date: string, days: number) => string;
  /** No anchor left in the record: only the due date. */
  readonly dueOnly: (due: string) => string;
  /** How the interval was chosen, per basis (parameters already formatted). */
  readonly basis: {
    readonly rule_days: (days: number) => string;
    readonly critical_result: (days: number) => string;
    readonly treatment_end: (treatmentDays: number | undefined, days: number) => string;
    readonly plan_date: string;
    readonly cadence: (multiplier: number, interval: number) => string;
    readonly protocol_interval: (days: number) => string;
    readonly protocol_treatment_change: string;
    readonly protocol_gestational_age: (weeks: number | undefined) => string;
    readonly protocol_gestational_window: string;
    readonly protocol_after_outcome: (days: number) => string;
    readonly protocol_ckd_stage: (stage: string | undefined) => string;
  };
  readonly bookingTolerance: (days: number) => string;
  /** A gestational window: due when the pregnancy reaches `week`. */
  readonly dueAtWeek: (due: string, week: number) => string;
  /** Done too soon after a treatment change to count as its control. */
  readonly tooEarly: (record: string, date: string) => string;
  readonly days: (count: number) => string;
  /** What would fulfill it. */
  readonly fulfill: {
    readonly result: (test: string, code: string, equivalents: number) => string;
    readonly orderResult: (test: string, code: string) => string;
    readonly anyResult: (kind: string) => string;
    readonly visit: (withBooking: boolean) => string;
    readonly session: (withBooking: boolean) => string;
    readonly other: (withBooking: boolean) => string;
  };
  readonly expectKinds: Readonly<Record<PlanItemKind, string>>;
  /** Why the patient is in the protocol. */
  readonly enrollment: {
    readonly diagnosis: (diagnosis: string, date: string) => string;
    readonly note: (diagnosis: string, date: string) => string;
    readonly medication: (medication: string, date: string, diagnosis: string) => string;
    readonly results: (count: number, test: string, threshold: string, diagnosis: string) => string;
    readonly record: (record: string, date: string, diagnosis: string) => string;
    readonly ended: (outcome: string, date: string) => string;
    readonly notEnrolled: string;
    readonly unknown: (diagnosis: string) => string;
    readonly activeTreatment: (medication: string, date: string) => string;
    readonly confirm: (count: number, days: number) => string;
    readonly outcomes: Readonly<Record<string, string>>;
  };
  readonly protocolVersion: (name: string, version: string) => string;
  readonly draft: string;
  readonly validated: string;
  /** "Every 90 days", per schedule type. */
  readonly schedule: {
    readonly interval: (days: number) => string;
    readonly treatment_change: (
      afterChange: number,
      every: number,
      titration: string | undefined,
    ) => string;
    readonly titration: (every: number, controls: number) => string;
    readonly gestational_age: (intervals: string) => string;
    readonly gestationalInterval: (untilWeek: number, every: number) => string;
    readonly gestational_window: (from: number, to: number) => string;
    readonly after_outcome: (outcome: string, days: number) => string;
    readonly ckd_stage: (fallback: number) => string;
  };
  readonly cadence: (
    visits: number,
    pattern: number,
    interval: number | undefined,
    multiplier: number | undefined,
    expected: string,
  ) => string;
  readonly noPattern: string;
  readonly closedBy: string;
  readonly noteBy: (author: string) => string;
  readonly value: (value: string, interpretation: string | undefined) => string;
  readonly interpretations: Readonly<
    Record<'normal' | 'abnormal' | 'unknown' | 'critical', string>
  >;
  readonly noKnownAllergy: string;
  readonly cancelled: string;
  readonly verification: Readonly<Record<'confirmed' | 'provisional', string>>;
  readonly durationDays: (days: number) => string;
}

/** Kinds of document the evidence and the documents drawer list. */
export type WhyDocumentKind =
  | 'note'
  | 'order'
  | 'result'
  | 'prescription'
  | 'visit'
  | 'appointment'
  | 'diagnosis'
  | 'allergy'
  | 'other';

/** Where a contact attempt stands (`ContactAttemptView.status`). */
export type AttemptStatus =
  'waiting' | 'answered' | 'unreached' | 'unanswered' | 'pending_call' | 'closed';

/** Display text of a rule or protocol item, keyed by its reason code. */
export interface RuleText {
  /** The reason, as the case card names it ("Lab result pending"). */
  readonly reason: string;
  /** What the team should do about it. */
  readonly action?: string;
}

export interface ReviewerMessages {
  readonly categories: Readonly<
    Record<FindingCategory, { readonly label: string; readonly description: string }>
  >;
  readonly noteFallbackTitle: string;
  readonly recordFallbackTitle: string;
  readonly activeCase: string;
  readonly findingNotFound: string;
  readonly patientNotFound: string;
  readonly reasonRequired: string;
  readonly reasonRequiredField: string;
  readonly reservedCategory: string;
  readonly reservedCategoryField: string;
  readonly signOffRequired: string;
  readonly signOffRequiredField: string;
}

/** Messages of the zod error map, per issue kind. */
export interface ValidationMessages {
  readonly required: string;
  readonly mustBe: (what: string) => string;
  readonly typeNames: Readonly<Record<string, string>>;
  readonly otherType: string;
  readonly notEmpty: string;
  readonly atMost: string;
  readonly atLeast: string;
  readonly characters: (count: number) => string;
  readonly elements: (count: number) => string;
  readonly sized: (limit: string, amount: string) => string;
  readonly dateTooLate: string;
  readonly dateTooEarly: string;
  readonly lessThan: (bound: string) => string;
  readonly greaterThan: (bound: string) => string;
  readonly bounded: (limit: string, bound: string) => string;
  readonly oneOf: (options: string) => string;
  readonly invalidValue: string;
  readonly invalidDate: string;
  readonly invalidFormat: string;
  readonly unrecognizedKeys: (keys: string) => string;
  readonly multipleOf: (divisor: string) => string;
  /** The summary line of an `invalid_request`. */
  readonly checkRequest: string;
  readonly checkRequestWith: (message: string) => string;
  readonly checkField: (field: string, message: string) => string;
  readonly moreFields: (head: string, count: number) => string;
  /** What the clinic team calls each request field. */
  readonly fields: Readonly<Record<string, string>>;
  /** Messages a schema `refine` names by key (`params: { message: key }`). */
  readonly custom: {
    readonly snoozeDaysRequired: string;
    readonly dismissReasonRequired: string;
    readonly dismissNoteRequired: string;
    readonly suppressNeedsNotApplicable: string;
    /** The evaluator lab's document upload: one of `patientId`/`newPatient` is required. */
    readonly labPatientRequired: string;
    /** The evaluator lab's document upload: one of `text`/`dataBase64` is required. */
    readonly labDocumentRequired: string;
  };
}

/** The rule configuration API (`/api/admin/rules`) and the `clinic:rules` CLI. */
export interface AdminMessages {
  /** By `ValidationError.field` of the rule override commands. */
  readonly fields: {
    readonly ruleId: string;
    readonly dueInDays: string;
    readonly enabled: string;
    readonly override: string;
    readonly reason: string;
    readonly actor: string;
    /** Any field an override does not have. */
    readonly unknownField: string;
  };
  /** Summary of a 422. */
  readonly invalid: string;
  /** 409: another change landed since the version the request was based on. */
  readonly staleVersion: string;
  /** The rule already runs like that: no change was made. */
  readonly unchanged: string;
  readonly layers: Readonly<Record<ExpectationLayer, string>>;
}

export interface ApiMessages {
  /** The catalog's language (`en`, `es`). */
  readonly locale: 'en' | 'es';
  /** BCP-47 tag for `Intl` formatting and `Content-Language`. */
  readonly intlLocale: string;

  readonly people: {
    readonly frontDesk: string;
    readonly coordinator: string;
    readonly unknownPatient: string;
    readonly demoPatient: string;
  };
  readonly defaultSuggestedAction: string;
  readonly pendingFollowUp: string;
  readonly qualityFindings: Readonly<Record<QualityFindingKind, string>>;
  readonly layerFallbacks: Readonly<Record<ExpectationLayer, string>>;
  /** Reason type filter chips of the patient queue (HIP-141): one per engine layer. */
  readonly layerLabels: Readonly<Record<ExpectationLayer, string>>;
  readonly planItems: Readonly<Record<PlanItemKind, string>>;
  readonly planTest: string;
  readonly planTestNamed: (test: string) => string;
  /** What a plan item asks for, as the review of an AI reading names it (HIP-141). */
  readonly planItemKinds: Readonly<Record<PlanItemKind, string>>;
  readonly rules: Readonly<Record<string, RuleText>>;

  readonly channels: Readonly<Record<ContactChannel, string>>;
  readonly hostChannel: string;
  readonly outcomes: Readonly<Record<ContactOutcome, string>>;
  readonly callOutcomes: Readonly<Record<CallOutcome, string>>;
  readonly attemptStatuses: Readonly<Record<AttemptStatus, string>>;
  readonly dismissReasons: Readonly<Record<DismissReason, string>>;
  readonly contactFlag: string;
  readonly contactLoop: {
    readonly nothingToSuppress: string;
    readonly suppressionNotFound: string;
    readonly suppressionAlreadyActive: string;
  };
  readonly contactSkips: Readonly<Record<ContactSkipReason, string>>;
  readonly contactDenials: Readonly<Record<PatientContactDenial, string>>;
  readonly resolutions: Readonly<Record<CaseResolutionKind, string>>;
  /** Why the engine closed an expectation (`Expectation.closedReason`). */
  readonly closedReasons: Readonly<Record<string, string>>;
  readonly escalationSteps: Readonly<Record<EscalationAction, string>>;
  readonly phoneCallStep: string;
  readonly stepWithChannel: (step: string, channel: string) => string;
  readonly escalationActions: Readonly<Record<EscalationAction, string>>;

  readonly transitions: {
    readonly statusPhrases: Readonly<Record<CaseStatus, string>>;
    readonly verbs: Readonly<Record<CaseStatus, string>>;
    readonly requestContactVerb: string;
    readonly changeVerb: string;
    readonly changedState: string;
    readonly cannot: (action: string, state: string) => string;
  };

  readonly timeline: {
    readonly opened: (reason: string) => string;
    readonly reasonAdded: (reason: string) => string;
    readonly released: string;
    readonly notifiedByUser: string;
    readonly notifiedBySystem: string;
    readonly assigned: (person: string) => string;
    readonly snoozed: string;
    readonly snoozedUntil: (date: string) => string;
    readonly escalated: string;
    readonly callAfterWrongNumber: string;
    readonly call: string;
    readonly contactRequested: string;
    readonly contactRequestedVia: (channel: string) => string;
    readonly contactSkipped: string;
    readonly contactSkippedBecause: (why: string) => string;
    readonly contactOutcome: (outcome: string, channel: string | undefined) => string;
    readonly outcomeRecorded: string;
    readonly resolved: string;
    readonly resolvedBecause: (label: string, why: string) => string;
    readonly dismissed: string;
    readonly dismissedBecause: (reason: string) => string;
    readonly reopened: string;
    readonly lostToFollowUp: string;
    readonly useful: string;
    readonly notUseful: string;
    /** HIP-141: where a booking came from, as the case timeline says it. */
    readonly bookingOrigins: Readonly<Record<AppointmentOriginType, string>>;
    readonly appointmentBooked: (date: string, origin: string) => string;
    readonly appointmentBookedNoDate: (origin: string) => string;
    readonly appointmentAttended: string;
    /** A contact request made once for the patient from another of their cases (HIP-141). */
    readonly contactRequestedForPatient: string;
    /** A clinician's review of a plan item the AI read; the parameter names its kind. */
    readonly planItemReviews: {
      readonly plan_item_confirmed: (kind: string) => string;
      readonly plan_item_corrected: (kind: string) => string;
      readonly plan_item_rejected: (kind: string) => string;
    };
    /** The adjudicator decided on a reason (`decision` already labeled); `shadow`: nothing changed. */
    readonly adjudicated: (decision: string, shadow: boolean) => string;
    /** A doctor overrode the adjudicator (`decision` already labeled). */
    readonly adjudicationOverridden: (decision: string) => string;
  };

  /** The adjudicator of ambiguous plan items (PRD V2). */
  readonly adjudication: {
    readonly decisions: Readonly<Record<AdjudicationDecision, string>>;
    readonly reasons: Readonly<Record<AdjudicationReasonCode, string>>;
    readonly notFound: string;
    readonly alreadyOverridden: string;
  };

  /** The patient queue and the plan item review (HIP-141). */
  readonly patientQueue: {
    readonly noActiveCases: string;
    readonly planItemNotFound: string;
    readonly notAPlanItem: string;
    readonly alreadyReviewed: string;
    readonly planItemClosed: string;
    readonly nothingToCorrect: string;
    readonly invalidDueDate: string;
    readonly invalidKind: string;
  };

  /** "Why this?" evidence of every reason (HIP-142). */
  readonly why: WhyMessages;

  readonly sources: {
    readonly types: Readonly<Record<string, string>>;
    readonly onDate: (type: string, date: string) => string;
  };
  /** Name of each case priority band (`CaseView.priorityBand`). */
  readonly priorities: Readonly<Record<'low' | 'medium' | 'high' | 'urgent', string>>;
  /** Display names of the LOINC (and engine procedure) codes the inbox shows. */
  readonly loinc: Readonly<Record<string, string>>;
  /** Display names of ICD-10 codes and categories. */
  readonly icd10: Readonly<Record<string, string>>;

  readonly errors: {
    readonly notFound: string;
    readonly routeNotFound: string;
    readonly caseNotFound: string;
    readonly patientNotFound: string;
    readonly jobNotFound: string;
    readonly invalidConditionId: string;
    readonly invalidIdentifier: string;
    readonly invalidCursor: string;
    readonly conflict: string;
    readonly internal: string;
    readonly invalidJson: string;
    readonly invalidUrl: string;
    readonly controlCharacters: string;
    readonly missingApiKey: string;
    readonly invalidApiKey: string;
    readonly payloadTooLarge: (kilobytes: number) => string;
    readonly insufficientScope: (scope: string) => string;
    readonly rateLimited: string;
    readonly invalidUser: (maxLength: number) => string;
    readonly invalidData: string;
    readonly feedbackReasonRequired: string;
    readonly domainValidation: Readonly<Record<string, string>>;
    readonly webhookSinkUnavailable: string;
    readonly demoClinicOnly: string;
    readonly invalidConsultation: string;
    readonly noteNotRead: (model: string, error: string | undefined) => string;
    readonly labFutureDate: string;
    /** "See the impact on a date": the lab clinic's own clock only moves forward. */
    readonly labPastDate: string;
    /** Why the evaluator lab could not read an uploaded document (`DocumentExtractionError`). */
    readonly labDocumentErrors: Readonly<Record<DocumentExtractionError, string>>;
  };

  readonly validation: ValidationMessages;
  readonly reviewer: ReviewerMessages;
  readonly admin: AdminMessages;
  /** The shared access code page in front of a hosted demo (`DEMO_ACCESS_CODE`). */
  readonly accessGate: AccessGateMessages;
}

export interface AccessGateMessages {
  /** The page's `<title>`. */
  readonly title: string;
  readonly heading: string;
  readonly intro: string;
  readonly emailLabel: string;
  readonly codeLabel: string;
  readonly submit: string;
  readonly wrongCode: string;
  readonly invalidEmail: string;
  readonly tooManyAttempts: string;
  /** JSON error of an API call without the access cookie or evaluator identity. */
  readonly required: string;
}
