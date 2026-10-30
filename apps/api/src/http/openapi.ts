import { z } from 'zod';
import './schemas.ts';
import './reviewer-schemas.ts';
import './adjudication-schemas.ts';
import '../metrics/schemas.ts';
import './patient-queue-schemas.ts';
import './plan-item-schemas.ts';
import './admin-schemas.ts';
import './rule-authoring-schemas.ts';
import './why-schemas.ts';

/*
 * OpenAPI 3.1 document of the API. Component schemas are generated from the
 * same zod schemas that validate requests and type responses (everything
 * registered with `.meta({ id })` in schemas.ts), so the document cannot
 * drift from the code. FHIR payloads are described by reference to FHIR R4.
 */

interface Param {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly required?: boolean;
}

interface Operation {
  readonly method: 'get' | 'post' | 'put';
  readonly path: string;
  readonly tag: 'FHIR' | 'Inbox' | 'Admin' | 'Demo' | 'Health' | 'Jobs';
  readonly summary: string;
  readonly description?: string;
  readonly params?: readonly Param[];
  /** Component id of the JSON body, or `fhir` for a FHIR resource. */
  readonly body?: string;
  readonly response: string;
  /** Success status (default 200). */
  readonly status?: number;
  /** Other success statuses, with the same body. */
  readonly alsoOk?: readonly { readonly status: number; readonly description: string }[];
  /**
   * Error statuses specific to the operation. Every authenticated operation
   * also documents 400 (control characters in the URL), 401, 403 and 429;
   * every operation with a body 413.
   */
  readonly errors?: readonly number[];
  readonly public?: boolean;
}

const id = (description: string): Param => ({
  name: 'id',
  in: 'path',
  required: true,
  description,
});
const patientParam: Param = {
  name: 'patient',
  in: 'query',
  required: true,
  description: 'Patient id (or Patient/<id>)',
};
const preferHandling: Param = {
  name: 'Prefer',
  in: 'header',
  enum: ['handling=lenient', 'handling=strict'],
  description:
    'Unknown or repeated search parameters: a warning in the searchset outcome entry (lenient, ' +
    'default; repeats are ANDed) or 400 (strict). A comma inside a value is OR',
};
const preferSync: Param = {
  name: 'Prefer',
  in: 'header',
  enum: ['respond-async', 'respond-sync'],
  description: 'respond-sync runs the engine before answering (200), like ?sync=true',
};
const writeStatuses = [
  { status: 200, description: 'Updated, or unchanged (same content)' },
  {
    status: 202,
    description: 'Accepted for a patient whose consultation the engine processes later',
  },
] as const;

const OPERATIONS: readonly Operation[] = [
  {
    method: 'get',
    path: '/healthz',
    tag: 'Health',
    summary: 'Liveness',
    response: 'any',
    public: true,
  },
  {
    method: 'get',
    path: '/readyz',
    tag: 'Health',
    summary: 'Readiness (storage reachable)',
    response: 'any',
    public: true,
    errors: [503],
  },
  {
    method: 'post',
    path: '/fhir',
    tag: 'FHIR',
    summary: 'Ingest a transaction or batch Bundle (one saved consultation)',
    description:
      'Validates and stores the Bundle, then runs the engine: asynchronously by default (202, the ' +
      'engine runs in the worker; `X-FollowUp-Job` has the job id), synchronously with `?sync=true` ' +
      'or `Prefer: respond-sync` (200). An invalid transaction gets a 400 OperationOutcome; a ' +
      'batch is answered entry by entry (a batch-response, 200 when every entry failed). Entries ' +
      'with request.method DELETE, GET, HEAD or PATCH get 405 (a transaction with one is ' +
      'rejected). A version older than the stored one is not stored: `stale` warning in its ' +
      'entry and `X-FollowUp-Stale`.',
    params: [{ name: 'sync', in: 'query', enum: ['true'] }, preferSync],
    body: 'fhir',
    response: 'fhir',
    status: 202,
    alsoOk: [{ status: 200, description: 'Processed synchronously (?sync=true)' }],
    errors: [415],
  },
  {
    method: 'post',
    path: '/fhir/{type}',
    tag: 'FHIR',
    summary: 'Create (or, with an id in the body, update) a single resource',
    params: [{ name: 'type', in: 'path', required: true }, preferSync],
    body: 'fhir',
    response: 'fhir',
    status: 201,
    alsoOk: writeStatuses,
    errors: [404, 415],
  },
  {
    method: 'put',
    path: '/fhir/{type}/{id}',
    tag: 'FHIR',
    summary: 'Update (or create) a single resource; the body id must match the URL',
    params: [
      { name: 'type', in: 'path', required: true },
      { name: 'id', in: 'path', required: true },
      preferSync,
    ],
    body: 'fhir',
    response: 'fhir',
    status: 201,
    alsoOk: writeStatuses,
    errors: [404, 415],
  },
  {
    method: 'get',
    path: '/fhir/Task',
    tag: 'FHIR',
    summary: 'Search expectations and cases (Tasks)',
    params: [
      {
        name: 'patient',
        in: 'query',
        description: 'Expectations are returned only with a patient',
      },
      { name: 'subject', in: 'query', description: 'Same as patient' },
      { name: 'status', in: 'query', description: 'Task.status or engine businessStatus code' },
      {
        name: 'code',
        in: 'query',
        description: 'Token: rule id or follow-up-case, optionally system|code',
      },
      { name: '_count', in: 'query', description: 'Page size, 0 to 500 (0: only the total)' },
      { name: '_offset', in: 'query', description: 'Start of the page (link next has it)' },
      preferHandling,
    ],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/Task/{id}',
    tag: 'FHIR',
    summary: 'Read one Task',
    params: [id('Task id')],
    response: 'fhir',
    errors: [404],
  },
  {
    method: 'get',
    path: '/fhir/Condition',
    tag: 'FHIR',
    summary: 'Conditions the engine believes a patient has (refuted ones included)',
    params: [patientParam, preferHandling],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/DetectedIssue',
    tag: 'FHIR',
    summary: 'Documentation-quality findings of a patient',
    params: [patientParam, preferHandling],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/CommunicationRequest',
    tag: 'FHIR',
    summary: 'Contact attempts the engine asked for, for a patient (one per attempt)',
    params: [patientParam, preferHandling],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/CommunicationRequest/{id}',
    tag: 'FHIR',
    summary:
      'Read one contact attempt (the communicationRequest link of patient_contact.requested)',
    params: [id('CommunicationRequest id')],
    response: 'fhir',
    errors: [404],
  },
  {
    method: 'get',
    path: '/fhir/Communication',
    tag: 'FHIR',
    summary: 'What came of the contact attempts of a patient (host reports and calls)',
    params: [patientParam, preferHandling],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/Communication/{id}',
    tag: 'FHIR',
    summary: 'Read one contact outcome',
    params: [id('Communication id')],
    response: 'fhir',
    errors: [404],
  },
  {
    method: 'get',
    path: '/fhir/Flag',
    tag: 'FHIR',
    summary: 'Reminders stopped for a patient (category follow-up-suppression)',
    params: [patientParam, preferHandling],
    response: 'fhir',
    errors: [422],
  },
  {
    method: 'get',
    path: '/fhir/Flag/{id}',
    tag: 'FHIR',
    summary: 'Read one suppression Flag',
    params: [id('Flag id')],
    response: 'fhir',
    errors: [404],
  },
  {
    method: 'get',
    path: '/fhir/metadata',
    tag: 'FHIR',
    summary: 'CapabilityStatement (public)',
    response: 'fhir',
    public: true,
  },
  {
    method: 'get',
    path: '/jobs/{id}',
    tag: 'Jobs',
    summary: 'Status of an asynchronous ingestion (X-FollowUp-Job, Content-Location)',
    params: [id('Job id')],
    response: 'JobStatus',
    errors: [404],
  },
  {
    method: 'get',
    path: '/api/inbox/clinic',
    tag: 'Inbox',
    summary: 'The authenticated clinic',
    response: 'Clinic',
  },
  {
    method: 'get',
    path: '/api/inbox/cases',
    tag: 'Inbox',
    summary: 'List cases (active: released and in progress, by priority)',
    params: [
      { name: 'view', in: 'query', enum: ['active', 'closed', 'all'] },
      { name: 'origin', in: 'query', enum: ['live', 'backfill'] },
      { name: 'assignee', in: 'query', description: 'Owner id, from /api/inbox/owners' },
      { name: 'q', in: 'query', description: 'Patient name or id contains this text' },
      { name: 'patient', in: 'query', description: 'Only the cases of this patient id' },
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'CasePage',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/owners',
    tag: 'Inbox',
    summary: 'Owners of released cases, with display names and active case counts',
    response: 'OwnerList',
  },
  {
    method: 'get',
    path: '/api/inbox/cases/{id}',
    tag: 'Inbox',
    summary: 'Case detail with timeline',
    params: [id('Case id')],
    response: 'CaseDetail',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/cases/{id}/actions',
    tag: 'Inbox',
    summary: 'Notify, snooze, resolve or dismiss a case',
    description:
      'dismiss needs a reason (recorded as the case feedback too); other needs a note; with ' +
      'not_applicable_to_patient, suppress: true stops the case rules for this patient.',
    params: [id('Case id')],
    body: 'CaseActionRequest',
    response: 'CaseDetail',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/cases/{id}/call-outcome',
    tag: 'Inbox',
    summary: 'Record what came of the call the team made ("Llamar al paciente")',
    description:
      'Recorded as a FHIR Communication (medium phone, sender the user) on the case call, and ' +
      'sent to the host as contact.outcome_recorded.',
    params: [id('Case id')],
    body: 'CallOutcomeRequest',
    response: 'CaseDetail',
    errors: [404, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/suppressions/{id}/reactivate',
    tag: 'Inbox',
    summary: 'Reactivate a reminder stopped for a patient ("Volver a activar")',
    params: [id('Suppression id')],
    response: 'SuppressionView',
    errors: [404, 409],
  },
  {
    method: 'get',
    path: '/api/inbox/calibration',
    tag: 'Inbox',
    summary: 'Per rule: useful rate and dismissals by reason (rule calibration)',
    params: [{ name: 'since', in: 'query', description: 'ISO 8601 date-time' }],
    response: 'CalibrationReport',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/metrics',
    tag: 'Inbox',
    summary:
      'Clinic metrics: bookings attributed or organic, attendance, time to first action, AI cost',
    description:
      'Cohort numbers follow the cases that reached the inbox in [from, to) up to now; activity numbers (AI cost, review runs, extraction reviews) count what happened in the period. Definitions: docs/metrics.md.',
    params: [
      {
        name: 'from',
        in: 'query',
        description: 'ISO 8601 date-time, inclusive (default: to - 30 days)',
      },
      { name: 'to', in: 'query', description: 'ISO 8601 date-time, exclusive (default: now)' },
    ],
    response: 'ClinicMetrics',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/value/simulation',
    tag: 'Inbox',
    summary: '90-day outcome simulation: order agent vs fixed reminders (synthetic patients)',
    description:
      'Seeded simulation with synthetic patients and stated assumptions, not a clinical trial; the same for every clinic. Each metric per arm as the mean over seeds with a 95 % interval. The default size answers at once; another is computed in the background (202 with the progress) and cached. Method: docs/simulation.md.',
    params: [
      {
        name: 'patientsPerArm',
        in: 'query',
        description: 'Patients per arm, 50 to 400 (default 400)',
      },
      { name: 'seeds', in: 'query', description: 'Seeded runs, 1 to 20 (default 20)' },
    ],
    response: 'any',
    alsoOk: [{ status: 202, description: 'Computing this size; poll again' }],
    errors: [422],
  },
  {
    method: 'post',
    path: '/api/inbox/cases/{id}/feedback',
    tag: 'Inbox',
    summary: 'Was the case useful? (reason required when not)',
    params: [id('Case id')],
    body: 'FeedbackRequest',
    response: 'CaseDetail',
    errors: [404, 422],
  },
  {
    method: 'get',
    path: '/api/inbox/patients',
    tag: 'Inbox',
    summary: 'Search patients by id or name',
    params: [
      { name: 'query', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'PatientList',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/patients/{id}',
    tag: 'Inbox',
    summary: 'Patient: conditions, expectations, findings',
    params: [id('Patient id')],
    response: 'PatientDetail',
    errors: [404],
  },
  {
    method: 'get',
    path: '/api/inbox/patients/{id}/documents',
    tag: 'Inbox',
    summary: 'Every document of the patient, oldest first (the case\'s "View documents" drawer)',
    description:
      'Notes with their full text, orders, results with value and interpretation, ' +
      'prescriptions, visits, appointments, diagnoses and allergy records: the latest version ' +
      'of each resource, `withdrawn` when the host withdrew it later. What a clinician verifies ' +
      'a case against (HIP-142).',
    params: [id('Patient id')],
    response: 'PatientDocumentList',
    errors: [404],
  },
  {
    method: 'get',
    path: '/api/inbox/patients/{id}/before-visit',
    tag: 'Inbox',
    summary: "Before the visit: the patient's next appointment and what to raise then",
    description:
      'Open pre_visit_question and abnormal_result_no_followup findings, newest and most ' +
      'severe first. A demo or lab clinic also gets its shadow findings here, clearly ' +
      'labeled as not yet validated; every other clinic sees only live ones.',
    params: [id('Patient id')],
    response: 'BeforeVisitResponse',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/conditions/{id}/confirm',
    tag: 'Inbox',
    summary: 'Confirm an inferred condition',
    params: [id('Condition id')],
    response: 'ConditionView',
    errors: [400, 404],
  },
  {
    method: 'post',
    path: '/api/inbox/conditions/{id}/reject',
    tag: 'Inbox',
    summary: 'Reject an inferred condition (cancels its protocol expectations)',
    params: [id('Condition id')],
    response: 'ConditionView',
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/inbox/patients-queue',
    tag: 'Inbox',
    summary: 'The patient queue: one card per patient, all their cases and reasons grouped',
    description:
      'Cases are selected by the filters, then grouped by patient; a page never splits a ' +
      'patient. Ordered by the most urgent case of each patient (closed view: oldest first). ' +
      '`total` counts patients, `totalCases` their cases. `facets` has the counts for the ' +
      'filter bar, each ignoring only its own filter.',
    params: [
      { name: 'view', in: 'query', enum: ['active', 'closed', 'all'] },
      { name: 'origin', in: 'query', enum: ['live', 'backfill'] },
      { name: 'assignee', in: 'query', description: 'Owner id (from /api/inbox/owners)' },
      { name: 'q', in: 'query', description: 'Patient name or id contains this text' },
      {
        name: 'layer',
        in: 'query',
        description:
          'Comma-separated reason layers (universal, doctor_plan, cadence, protocol): a ' +
          'patient matches if any open reason is in one of them',
      },
      {
        name: 'protocol',
        in: 'query',
        description: 'Comma-separated protocol ids from the catalog; same OR-match rule as layer',
      },
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query', description: 'Patients per page (1-200, default 50)' },
    ],
    response: 'PatientQueuePage',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/patients-queue/{id}',
    tag: 'Inbox',
    summary: "One patient's card: active cases, then the latest closed ones",
    params: [id('Patient id')],
    response: 'PatientQueueItem',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/patients-queue/{id}/request-contact',
    tag: 'Inbox',
    summary: 'Ask the host to contact the patient once, for all their cases',
    description:
      'One contact attempt (`patient_contact.requested`) on the most urgent active case; the ' +
      'other cases record it and every open or snoozed case is marked notified. At most one ' +
      'message per patient per contact window, across cases (409).',
    params: [id('Patient id')],
    body: 'PatientContactRequest',
    response: 'PatientQueueItem',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/plan-items/{id}/confirm',
    tag: 'Inbox',
    summary: 'Confirm a plan item the AI read from a note',
    params: [id('Expectation id')],
    response: 'PlanItemReviewResponse',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/plan-items/{id}/correct',
    tag: 'Inbox',
    summary: 'Correct the due date or the kind of a plan item (supersedes it with the correction)',
    params: [id('Expectation id')],
    body: 'PlanItemCorrectionRequest',
    response: 'PlanItemReviewResponse',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/plan-items/{id}/reject',
    tag: 'Inbox',
    summary:
      'Reject a plan item: the note never asked for it (resolves a case left without reasons)',
    params: [id('Expectation id')],
    response: 'PlanItemReviewResponse',
    errors: [404, 409, 422],
  },
  {
    method: 'get',
    path: '/api/inbox/recovery',
    tag: 'Inbox',
    summary: 'Backfill cases not yet released ("pacientes por recuperar")',
    params: [
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'RecoveryPage',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/stats',
    tag: 'Inbox',
    summary: 'Inbox and LLM usage stats',
    response: 'InboxStats',
  },
  {
    method: 'get',
    path: '/api/inbox/findings',
    tag: 'Inbox',
    summary: 'Clinical reviewer findings for the batch review (shadow by default), newest first',
    description:
      'Shadow findings are only for the clinical staff validating the reviewer: never exported ' +
      'to /fhir nor sent as webhooks. `counts` covers the whole mode.',
    params: [
      { name: 'mode', in: 'query', enum: ['shadow', 'live'] },
      {
        name: 'status',
        in: 'query',
        enum: ['open', 'relevant', 'already_known', 'not_relevant', 'expired', 'reviewed'],
      },
      { name: 'category', in: 'query', description: 'Comma-separated categories' },
      { name: 'severity', in: 'query', description: 'Comma-separated: low, medium, high' },
      { name: 'patientId', in: 'query' },
      { name: 'cursor', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'FindingPage',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/inbox/adjudications',
    tag: 'Inbox',
    summary: "The adjudicator's decisions on ambiguous plan items, newest first",
    description:
      'By case (`caseId`: the decisions on its reasons) or across the clinic (optionally one ' +
      'patient or one decision). Each decision carries its probability, reason codes, rationale, ' +
      'the verbatim quotes the engine checked and its provenance (model, prompt version, cost).',
    params: [
      { name: 'caseId', in: 'query' },
      { name: 'patientId', in: 'query' },
      { name: 'decision', in: 'query', enum: ['open', 'discard', 'needs_human'] },
      { name: 'limit', in: 'query' },
    ],
    response: 'AdjudicationList',
    errors: [404, 422],
  },
  {
    method: 'post',
    path: '/api/inbox/adjudications/{id}/override',
    tag: 'Inbox',
    summary: "A doctor's override of a decision: open (keep and confirm) or discard (reject)",
    params: [id('Adjudication id')],
    body: 'AdjudicationOverrideRequest',
    response: 'AdjudicationOverrideResponse',
    errors: [404, 409, 422],
  },
  {
    method: 'get',
    path: '/api/inbox/findings/metrics',
    tag: 'Inbox',
    summary:
      'Reviewer metrics of the last 90 days: runs, findings per 100 patients, cost, precision',
    response: 'ReviewMetrics',
  },
  {
    method: 'get',
    path: '/api/inbox/findings/{id}',
    tag: 'Inbox',
    summary: "A finding with its citations, trend and the agent's run (tool trace, cost)",
    params: [id('Finding id')],
    response: 'FindingDetail',
    errors: [404],
  },
  {
    method: 'get',
    path: '/api/inbox/findings/{id}/fhir',
    tag: 'Inbox',
    summary: 'A finding as a FHIR R4 DetectedIssue (shadow ones included, for the staff)',
    params: [id('Finding id')],
    response: 'fhir',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/inbox/findings/{id}/review',
    tag: 'Inbox',
    summary: 'Verdict on a finding: relevant, already_known or not_relevant (reason required)',
    params: [id('Finding id')],
    body: 'FindingReviewRequest',
    response: 'Finding',
    errors: [404, 422],
  },
  {
    method: 'get',
    path: '/api/inbox/finding-flags',
    tag: 'Inbox',
    summary: 'Finding categories of the clinic: on/off, shadow/live, sign-off and shadow precision',
    response: 'FindingFlagList',
  },
  {
    method: 'put',
    path: '/api/inbox/finding-flags',
    tag: 'Inbox',
    summary:
      'Turn a category on or off, or move it between shadow and live (live needs validatedBy)',
    body: 'FindingFlagUpdate',
    response: 'FindingFlag',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/admin/rules',
    tag: 'Admin',
    summary:
      "The clinic's rules: defaults, the override in force and the version new expectations carry",
    response: 'AdminRuleList',
  },
  {
    method: 'put',
    path: '/api/admin/rules',
    tag: 'Admin',
    summary:
      'Change one rule for the clinic (override.dueInDays / override.enabled, or override: null ' +
      'to reset), with a reason; applies to expectations created afterwards',
    description:
      'Audited: who (X-FollowUp-User, required), when, old → new and why. Existing ' +
      'expectations keep their deadline and rule version.',
    body: 'AdminRuleUpdate',
    response: 'AdminRuleUpdateResult',
    errors: [409, 422],
  },
  {
    method: 'get',
    path: '/api/admin/rules/history',
    tag: 'Admin',
    summary: "History of the clinic's rule changes, newest first",
    params: [
      { name: 'ruleId', in: 'query' },
      { name: 'limit', in: 'query' },
    ],
    response: 'AdminRuleHistory',
    errors: [422],
  },
  {
    method: 'get',
    path: '/api/admin/rules/authored',
    tag: 'Admin',
    summary:
      "The clinic's own rules drafted by the rule-authoring agent: drafts, enabled and switched off",
    response: 'AuthoredRuleList',
  },
  {
    method: 'post',
    path: '/api/admin/rules/authored',
    tag: 'Admin',
    summary:
      'Draft a clinic rule from plain words (the rule-authoring agent): validated and dry-run by ' +
      'the engine, stored as a draft that never runs until enabled',
    description:
      'The clinician from X-FollowUp-User (required). `failed` when the agent abstained or code ' +
      'refused its draft. docs/agent/rule-authoring.md',
    body: 'AuthoredRuleDraftRequest',
    response: 'AuthoredRuleDraftResult',
    status: 201,
    alsoOk: [{ status: 200, description: 'No draft (`status: failed`): abstained or refused' }],
    errors: [422, 429],
  },
  {
    method: 'post',
    path: '/api/admin/rules/authored/{ruleId}/enable',
    tag: 'Admin',
    summary: 'Enable a drafted clinic rule (records validatedBy); applies to new events only',
    params: [{ name: 'ruleId', in: 'path' }],
    body: 'AuthoredRuleDecision',
    response: 'AuthoredRuleDecisionResult',
    errors: [404, 409, 422],
  },
  {
    method: 'post',
    path: '/api/admin/rules/authored/{ruleId}/discard',
    tag: 'Admin',
    summary: 'Discard a draft, or switch an enabled clinic rule off (its expectations still close)',
    params: [{ name: 'ruleId', in: 'path' }],
    body: 'AuthoredRuleDecision',
    response: 'AuthoredRuleDecisionResult',
    errors: [404, 409, 422],
  },
  {
    method: 'get',
    path: '/api/demo/clock',
    tag: 'Demo',
    summary: 'Fake clock (404 with a real clock)',
    response: 'DemoClock',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/demo/clock/advance',
    tag: 'Demo',
    summary:
      'Advance the fake clock day by day, running the sweeps and delivering webhooks (demo:clock)',
    body: 'AdvanceClockRequest',
    response: 'DemoClock',
    errors: [404, 422],
  },
  {
    method: 'post',
    path: '/api/demo/consultations',
    tag: 'Demo',
    summary:
      'Build a consultation Bundle, ingest it synchronously, return the extraction ' +
      '(demo:ingest; demo clinic only)',
    body: 'DemoConsultationRequest',
    response: 'DemoConsultationResponse',
    status: 201,
    errors: [404, 422, 502],
  },
  {
    method: 'get',
    path: '/api/demo/webhooks',
    tag: 'Demo',
    summary: 'Webhooks the sink received for this clinic (demo:clock)',
    params: [
      { name: 'limit', in: 'query' },
      { name: 'type', in: 'query' },
    ],
    response: 'WebhookList',
    errors: [404],
  },
  {
    method: 'post',
    path: '/api/demo/review/{patientId}',
    tag: 'Demo',
    summary: 'Review a patient now (no 10-minute debounce): the run and the findings it stored',
    params: [{ name: 'patientId', in: 'path', required: true }],
    response: 'DemoReviewResponse',
    errors: [404],
  },
];

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Bad request: invalid JSON or Bundle, invalid cursor, control characters in the URL, invalid X-FollowUp-User, unsupported or repeated search parameter with handling=strict',
  401: 'Missing or invalid API key',
  403: 'The API key lacks the scope this operation needs',
  404: 'Not found',
  409: 'Invalid case transition, or a stale expectedVersion',
  413: 'Body larger than 5 MB',
  415: 'Unsupported media type',
  422: 'Validation error: code invalid_request, message and fields (one per invalid field) in the response language',
  429: 'Too many requests for this key (Retry-After)',
  502: 'Upstream (LLM provider or webhook sink) failed',
  503: 'Not ready',
};

function content(ref: string): Record<string, unknown> {
  if (ref === 'any') {
    return { 'application/json': { schema: { type: 'object' } } };
  }
  if (ref === 'fhir') {
    return {
      'application/fhir+json': {
        schema: {
          type: 'object',
          description: 'A FHIR R4 resource (https://hl7.org/fhir/R4/); see docs/fhir.md',
          required: ['resourceType'],
        },
      },
    };
  }
  return { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } };
}

function operation(op: Operation): Record<string, unknown> {
  const statuses = new Set([
    ...(op.public === true ? [] : [400, 401, 403, 429]),
    ...(op.body === undefined ? [] : [400, 413]),
    ...(op.errors ?? []),
  ]);
  const errors = Object.fromEntries(
    [...statuses]
      .sort((left, right) => left - right)
      .map((status) => [
        String(status),
        {
          description: ERROR_DESCRIPTIONS[status] ?? 'Error',
          content: op.tag === 'FHIR' ? content('fhir') : content('Error'),
        },
      ]),
  );
  return {
    tags: [op.tag],
    summary: op.summary,
    ...(op.description === undefined ? {} : { description: op.description }),
    ...(op.public === true ? { security: [] } : {}),
    ...(op.params === undefined
      ? {}
      : {
          parameters: op.params.map((param) => ({
            name: param.name,
            in: param.in,
            required: param.required ?? param.in === 'path',
            ...(param.description === undefined ? {} : { description: param.description }),
            schema: { type: 'string', ...(param.enum === undefined ? {} : { enum: param.enum }) },
          })),
        }),
    ...(op.body === undefined
      ? {}
      : { requestBody: { required: true, content: content(op.body) } }),
    responses: {
      [String(op.status ?? 200)]: { description: 'OK', content: content(op.response) },
      ...Object.fromEntries(
        (op.alsoOk ?? []).map((ok) => [
          String(ok.status),
          { description: ok.description, content: content(op.response) },
        ]),
      ),
      ...errors,
    },
  };
}

/** The OpenAPI 3.1 document served at `/openapi.json`. */
export function openApiDocument(options: { readonly demo: boolean }): Record<string, unknown> {
  const { schemas } = z.toJSONSchema(z.globalRegistry, {
    uri: (schemaId) => `#/components/schemas/${schemaId}`,
    unrepresentable: 'any',
  });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPERATIONS) {
    if (op.tag === 'Demo' && !options.demo) {
      continue;
    }
    paths[op.path] = { ...paths[op.path], [op.method]: operation(op) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Follow-up Engine API',
      version: '0.1.0',
      description:
        'FHIR R4 in and out, the clinic inbox JSON API and demo controls. Authenticate with ' +
        '`Authorization: Bearer <clinic API key>`. Webhooks the engine sends are documented in ' +
        'docs/integration.md.',
    },
    servers: [{ url: '/' }],
    security: [{ apiKey: [] }],
    tags: [
      { name: 'FHIR', description: 'HL7 FHIR R4 (application/fhir+json)' },
      {
        name: 'Inbox',
        description:
          'JSON API of the clinic inbox (labels in the language of Accept-Language, else the clinic locale, else English)',
      },
      {
        name: 'Admin',
        description:
          "The clinic's rule configuration (scope admin:rules): deadlines and switches per rule, " +
          'versioned and audited',
      },
      {
        name: 'Demo',
        description:
          'Only when the engine runs on a fake clock. Scopes: inbox:read reads the clock, ' +
          'demo:clock moves it and reads the webhook feed, demo:ingest saves demo consultations ' +
          '(demo clinic only)',
      },
      { name: 'Jobs', description: 'Asynchronous work the clinic started' },
      { name: 'Health' },
    ],
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [
          name,
          Object.fromEntries(
            Object.entries(schema).filter(([key]) => key !== '$id' && key !== '$schema'),
          ),
        ]),
      ),
    },
  };
}

/**
 * The API reference UI: Scalar, pinned to one version and loaded with
 * Subresource Integrity, so the CDN can never serve other code on the API's
 * origin (where people type their API key into the reference). To upgrade,
 * change the version and recompute the hash:
 * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
export const DOCS_UI_SCRIPT = {
  url: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js',
  integrity: 'sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ',
} as const;

/** API reference UI (Scalar, pinned with SRI) over `/openapi.json`. */
export function docsPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Follow-up Engine API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script
      src="${DOCS_UI_SCRIPT.url}"
      integrity="${DOCS_UI_SCRIPT.integrity}"
      crossorigin="anonymous"
    ></script>
  </body>
</html>`;
}
