import type {
  AdjudicationList,
  AdjudicationListQuery,
  AdjudicationOverrideRequest,
  AdjudicationOverrideResponse,
} from './adjudication-contract.ts';
import type { ClinicMetricsView, MetricsQuery } from '../features/metrics/contract.ts';
import type { SimulationResponse } from '../features/value/contract.ts';
import type { ApiConfig } from '../config.ts';
import { getLocale, messages } from '../i18n/index.ts';
import type { PatientDocumentView } from './why-contract.ts';
import type {
  ApiErrorBody,
  ApiFieldError,
  CalibrationReportView,
  CallOutcomeRequest,
  CaseActionRequest,
  CaseDetail,
  CaseListQuery,
  CaseView,
  ClinicInfo,
  ConditionView,
  DemoClock,
  DemoConsultationRequest,
  DemoConsultationResponse,
  EvaluatorEventView,
  EvaluatorIdentity,
  ClientEvaluatorEvent,
  EvaluatorsView,
  FeedbackRequest,
  InboxStats,
  LabDateImpact,
  LabDocumentResponse,
  LabDocumentUploadRequest,
  LabExpectationView,
  HeldLabReportDecision,
  HeldLabReportView,
  LabHistoryImportRequest,
  LabHistoryImportResponse,
  LabHistorySampleSet,
  LabPatient,
  LabPatientCreateRequest,
  LabRecordAddRequest,
  LabRecordResponse,
  OwnerView,
  Page,
  PatientDetail,
  PatientSummary,
  RecoveryPage,
  SuppressionView,
  WebhookDelivery,
} from './contract.ts';
import type {
  BeforeVisitView,
  FindingDetail,
  FindingFlagUpdate,
  FindingFlagView,
  FindingListQuery,
  FindingPage,
  FindingReviewRequest,
  FindingView,
  InboxFindingFilters,
  InboxFindingList,
  ReviewerScope,
  ReviewMetrics,
} from './reviewer-contract.ts';
import type {
  PatientQueueItem,
  PatientQueuePage,
  PatientQueueQuery,
  PlanItemReviewResponse,
} from './patient-queue-contract.ts';
import type { PlanItemCommand, PlanItemCorrectionRequest } from './plan-item-contract.ts';
import type {
  AgentMessageView,
  AgentPageView,
  AgentSampleName,
  AgentStoryRequest,
} from './agent-contract.ts';
import type {
  RuleDecisionResponse,
  RuleDraftRequest,
  RuleDraftResponse,
  RulesPageView,
} from './rules-contract.ts';
import type {
  EngineTestCatalog,
  EngineTestFreeformRequest,
  EngineTestStartResponse,
  EngineTestStepOutcome,
  EngineTestStepRequest,
  EngineTestVerdictRequest,
} from './engine-tests-contract.ts';

/** An HTTP error from the API, with the contract's `{ error: { code, message } }` body when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The invalid inputs of a 422, each with its message (in the request's language). */
  readonly fields: readonly ApiFieldError[];

  constructor(
    status: number,
    code: string,
    message: string,
    fields: readonly ApiFieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

type Query = Record<string, string | number | undefined>;

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/** `fields` of a 422 body, tolerating a path sent as segments (`['orders', 0]`). */
function readFields(error: object): ApiFieldError[] {
  if (!('fields' in error) || !Array.isArray(error.fields)) return [];
  return (error.fields as unknown[]).flatMap((field): ApiFieldError[] => {
    if (typeof field !== 'object' || field === null) return [];
    const { path, message } = field as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') return [];
    const joined = Array.isArray(path)
      ? path.map((segment) => String(segment as string | number)).join('.')
      : typeof path === 'string'
        ? path
        : '';
    return [{ path: joined, message }];
  });
}

async function readErrorBody(response: Response): Promise<ApiError> {
  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    // Not JSON (proxy error page, empty body): fall through to a generic error.
  }
  if (isErrorBody(body)) {
    return new ApiError(
      response.status,
      body.error.code,
      body.error.message,
      readFields(body.error),
    );
  }
  return new ApiError(
    response.status,
    `http_${String(response.status)}`,
    messages().errors.unexpected,
  );
}

export interface ApiClient {
  getClinic(): Promise<ClinicInfo>;
  listCases(query: CaseListQuery): Promise<Page<CaseView>>;
  getCase(id: string): Promise<CaseDetail>;
  actOnCase(id: string, body: CaseActionRequest): Promise<CaseDetail>;
  sendFeedback(id: string, body: FeedbackRequest): Promise<unknown>;
  recordCallOutcome(id: string, body: CallOutcomeRequest): Promise<CaseDetail>;
  reactivateSuppression(id: string): Promise<SuppressionView>;
  getCalibration(): Promise<CalibrationReportView>;
  listOwners(): Promise<{ items: OwnerView[] }>;
  listPatients(query: { query?: string; limit?: number }): Promise<{ items: PatientSummary[] }>;
  getPatient(id: string): Promise<PatientDetail>;
  /** Every document of the patient, oldest first: the "View documents" drawer (HIP-142). */
  getPatientDocuments(id: string): Promise<{ items: PatientDocumentView[] }>;
  /** "Before the visit": the next appointment and what to raise then (HIP-112 V3). */
  getBeforeVisit(id: string): Promise<BeforeVisitView>;
  confirmCondition(id: string): Promise<ConditionView>;
  rejectCondition(id: string): Promise<ConditionView>;
  listRecovery(query: { cursor?: string; limit?: number }): Promise<RecoveryPage>;
  getStats(): Promise<InboxStats>;
  /** Clinic metrics over `[from, to)` (HIP-141). */
  getMetrics(query: MetricsQuery): Promise<ClinicMetricsView>;
  /** The 90-day outcome simulation (synthetic patients); `running` while a size is computed. */
  getValueSimulation(): Promise<SimulationResponse>;
  /** `undefined` when the API runs on a real clock (the demo endpoints answer 404). */
  getDemoClock(): Promise<DemoClock | undefined>;
  advanceClock(days: number): Promise<{ now: string }>;
  createDemoConsultation(body: DemoConsultationRequest): Promise<DemoConsultationResponse>;
  listWebhooks(limit: number, type?: string): Promise<{ items: WebhookDelivery[] }>;
  listFindings(query: FindingListQuery): Promise<FindingPage>;
  getFinding(id: string): Promise<FindingDetail>;
  reviewFinding(
    id: string,
    body: FindingReviewRequest,
    scope?: ReviewerScope,
  ): Promise<FindingView>;
  getReviewMetrics(): Promise<ReviewMetrics>;
  listFindingFlags(scope?: ReviewerScope): Promise<{ items: FindingFlagView[] }>;
  updateFindingFlag(body: FindingFlagUpdate, scope?: ReviewerScope): Promise<FindingFlagView>;
  /** The doctor's inbox cards: live, signed-off categories only. */
  listInboxFindings(
    scope?: ReviewerScope,
    filters?: InboxFindingFilters,
  ): Promise<InboxFindingList>;
  /** "Review this patient now" in the evaluator's lab. */
  reviewLabPatient(patientId: string): Promise<{ findings: FindingView[] }>;
  listPatientQueue(query: PatientQueueQuery): Promise<PatientQueuePage>;
  getPatientCard(patientId: string): Promise<PatientQueueItem>;
  requestPatientContact(patientId: string, body: { note?: string }): Promise<PatientQueueItem>;
  reviewPlanItem(
    expectationId: string,
    command: PlanItemCommand,
    body?: PlanItemCorrectionRequest,
  ): Promise<PlanItemReviewResponse>;
  /** The adjudicator's decisions on ambiguous plan items (PRD V2). */
  listAdjudications(query: AdjudicationListQuery): Promise<AdjudicationList>;
  overrideAdjudication(
    id: string,
    body: AdjudicationOverrideRequest,
  ): Promise<AdjudicationOverrideResponse>;
  /** `undefined` when the API runs on a real clock (the demo endpoints answer 404). */
  getEngineTests(): Promise<EngineTestCatalog | undefined>;
  /** Starts (or restarts) a scenario on a fresh fictitious patient, with every step's pre-filled suggestion. */
  startEngineTest(id: string): Promise<EngineTestStartResponse>;
  /** Applies one step's (possibly edited) input through the real engine. */
  submitEngineTestStep(
    id: string,
    step: number,
    body: EngineTestStepRequest,
  ): Promise<EngineTestStepOutcome>;
  /** "Try anything else": a free-form record or document action, outside any numbered step. */
  submitEngineTestFreeform(
    id: string,
    body: EngineTestFreeformRequest,
  ): Promise<EngineTestStepOutcome>;
  submitEngineTestVerdict(id: string, body: EngineTestVerdictRequest): Promise<unknown>;

  // The evaluator lab (docs/deploy.md#hosted-demo) --------------------------

  /** Empty outside the hosted demo (no access gate configured). */
  getEvaluator(): Promise<EvaluatorIdentity>;
  /** "Change" in the header banner: back to the code page. */
  logoutEvaluator(): Promise<void>;
  /** Records a page view or an agent-page select for the signed-in evaluator. */
  trackEvaluatorEvent(event: ClientEvaluatorEvent): Promise<void>;
  /** The lab clinic's own "today" (never the shared clock's). */
  getLabClock(): Promise<DemoClock>;
  listLabPatients(): Promise<{ items: LabPatient[] }>;
  createLabPatient(body: LabPatientCreateRequest): Promise<LabPatient>;
  uploadLabDocument(body: LabDocumentUploadRequest): Promise<LabDocumentResponse>;
  addLabRecord(body: LabRecordAddRequest): Promise<LabRecordResponse>;
  getLabPatientExpectations(patientId: string): Promise<{ items: LabExpectationView[] }>;
  /** "See the impact on a date": moves the lab clinic's own clock forward. */
  advanceLabDate(date: string): Promise<LabDateImpact>;
  getLabCases(): Promise<{ items: CaseView[] }>;
  /** "Import history": several dated documents of one patient, replayed by the backfill. */
  importLabHistory(body: LabHistoryImportRequest): Promise<LabHistoryImportResponse>;
  getLabHistorySamples(): Promise<LabHistorySampleSet>;
  /** The lab's "To recover": backfill cases still held, as of the lab's own date. */
  getLabRecovery(): Promise<{ items: CaseView[]; total: number }>;
  /** Lab reports held for review (pending), one patient's when given. */
  listLabHeldReports(patientId?: string): Promise<{ items: HeldLabReportView[] }>;
  /** "It's this patient" / "Not this patient". */
  decideLabHeldReport(id: string, decision: 'confirm' | 'discard'): Promise<HeldLabReportDecision>;
  listEvaluators(): Promise<EvaluatorsView>;
  listEvaluatorEvents(query: {
    evaluatorEmail?: string;
    limit?: number;
  }): Promise<Page<EvaluatorEventView>>;
  /**
   * "Download CSV": fetched with the same Authorization header as every
   * other call (a bare link would need the key in the query), as a blob
   * the component saves with its own filename.
   */
  downloadEvaluatorEventsCsv(): Promise<Blob>;

  // The rule-authoring agent (docs/agent/rule-authoring.md), in the lab ----

  /** The lab clinic's own rules (drafts, enabled, switched off) and its patient count. */
  getLabRules(): Promise<RulesPageView>;
  /** The agent drafts a rule from the clinician's words (never live until enabled). */
  draftLabRule(body: RuleDraftRequest): Promise<RuleDraftResponse>;
  /** "Enable for this clinic" or "Discard" (a draft) / "Switch off" (an enabled rule). */
  decideLabRule(ruleId: string, decision: 'enable' | 'discard'): Promise<RuleDecisionResponse>;
  /** Adds the nine synthetic sample patients the example rules' dry runs count. */
  addLabRuleSamples(): Promise<{ added: number }>;

  // The order-to-completion agent (docs/agent/order-to-completion.md) -------

  /** The lab clinic's agent page: the given (or latest) patient's conversation, trace, orders and tasks. */
  getAgent(patientId?: string): Promise<AgentPageView>;
  startAgentStory(body: AgentStoryRequest): Promise<{ patientId: string }>;
  sendAgentText(
    patientId: string,
    text: string,
    source?: 'suggested' | 'typed',
  ): Promise<AgentMessageView>;
  /** A voice note (WAV) or a photo, as multipart. */
  sendAgentFile(patientId: string, file: File): Promise<AgentMessageView>;
  sendAgentSample(patientId: string, sample: AgentSampleName): Promise<AgentMessageView>;
  setAgentDelivery(
    messageId: string,
    status: 'delivered' | 'read' | 'undelivered',
  ): Promise<AgentMessageView>;
  fixAgentPhone(patientId: string): Promise<void>;
  /** The doctor confirms an order the engine created from a result. */
  confirmAgentOrder(patientId: string, orderId: string): Promise<void>;
  /** Jumps the lab clinic's own clock (the agent's ladder runs day by day). */
  advanceAgentClock(days: number): Promise<{ from: string; to: string }>;
  /** A voice note or photo, fetched with the API key (an <img> cannot send it). */
  getAgentMedia(mediaId: string): Promise<Blob>;
}

/** The path prefix of the reviewer's inbox endpoints for a scope ({@link ReviewerScope}). */
function reviewerBase(scope: ReviewerScope | undefined): string {
  return scope === 'lab' ? '/demo/lab' : '/inbox';
}

export function createApiClient(config: ApiConfig): ApiClient {
  function url(path: string, query?: Query): string {
    const origin = config.baseUrl || globalThis.location.origin;
    const target = new URL(`/api${path}`, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') target.searchParams.set(key, String(value));
    }
    return target.toString();
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      // The labels the API writes (reasons, timeline, validation messages)
      // come back in the inbox's language.
      'Accept-Language': getLocale(),
      Authorization: `Bearer ${config.apiKey}`,
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetch(url(path, options.query), init);
    } catch {
      throw new ApiError(0, 'network_error', messages().errors.network);
    }
    if (!response.ok) throw await readErrorBody(response);
    // 204 (`POST /evaluator/logout`): no body to parse.
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  /** `fetch` with the same headers `request` uses, for a body `request` cannot send (multipart, blobs). */
  async function rawFetch(
    method: 'GET' | 'POST',
    path: string,
    init: { readonly query?: Query; readonly body?: BodyInit } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: '*/*',
      'Accept-Language': getLocale(),
      Authorization: `Bearer ${config.apiKey}`,
    };
    let response: Response;
    try {
      response = await fetch(
        url(path, init.query),
        init.body === undefined ? { method, headers } : { method, headers, body: init.body },
      );
    } catch {
      throw new ApiError(0, 'network_error', messages().errors.network);
    }
    if (!response.ok) throw await readErrorBody(response);
    return response;
  }

  async function importLabHistory(
    body: LabHistoryImportRequest,
  ): Promise<LabHistoryImportResponse> {
    const form = new FormData();
    if (body.patientId !== undefined) form.set('patientId', body.patientId);
    if (body.newPatient !== undefined) form.set('newPatient', JSON.stringify(body.newPatient));
    form.set(
      'documents',
      JSON.stringify(
        body.documents.map((document) => ({
          documentDate: document.documentDate,
          documentType: document.documentType,
          ...(document.specialty === undefined ? {} : { specialty: document.specialty }),
        })),
      ),
    );
    for (const document of body.documents) {
      form.append('files', document.file, document.file.name);
    }
    const response = await rawFetch('POST', '/demo/lab/history', { body: form });
    return (await response.json()) as LabHistoryImportResponse;
  }

  async function uploadLabDocument(body: LabDocumentUploadRequest): Promise<LabDocumentResponse> {
    const { file, newPatient, ...rest } = body;
    if (file === undefined) {
      return request('POST', '/demo/lab/documents', { body: { ...rest, newPatient } });
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(rest)) {
      form.set(key, value);
    }
    if (newPatient !== undefined) form.set('newPatient', JSON.stringify(newPatient));
    form.set('file', file, file.name);
    const response = await rawFetch('POST', '/demo/lab/documents', { body: form });
    return (await response.json()) as LabDocumentResponse;
  }

  return {
    getClinic: () => request('GET', '/inbox/clinic'),
    listCases: (query) => request('GET', '/inbox/cases', { query: { ...query } }),
    getCase: (id) => request('GET', `/inbox/cases/${encodeURIComponent(id)}`),
    actOnCase: (id, body) =>
      request('POST', `/inbox/cases/${encodeURIComponent(id)}/actions`, { body }),
    sendFeedback: (id, body) =>
      request('POST', `/inbox/cases/${encodeURIComponent(id)}/feedback`, { body }),
    recordCallOutcome: (id, body) =>
      request('POST', `/inbox/cases/${encodeURIComponent(id)}/call-outcome`, { body }),
    reactivateSuppression: (id) =>
      request('POST', `/inbox/suppressions/${encodeURIComponent(id)}/reactivate`),
    getCalibration: () => request('GET', '/inbox/calibration'),
    getMetrics: (query) => request('GET', '/inbox/metrics', { query: { ...query } }),
    getValueSimulation: () => request('GET', '/inbox/value/simulation'),
    listOwners: () => request('GET', '/inbox/owners'),
    listPatients: (query) => request('GET', '/inbox/patients', { query: { ...query } }),
    getPatient: (id) => request('GET', `/inbox/patients/${encodeURIComponent(id)}`),
    getPatientDocuments: (id) =>
      request('GET', `/inbox/patients/${encodeURIComponent(id)}/documents`),
    getBeforeVisit: (id) =>
      request('GET', `/inbox/patients/${encodeURIComponent(id)}/before-visit`),
    confirmCondition: (id) =>
      request('POST', `/inbox/conditions/${encodeURIComponent(id)}/confirm`),
    rejectCondition: (id) => request('POST', `/inbox/conditions/${encodeURIComponent(id)}/reject`),
    listRecovery: (query) => request('GET', '/inbox/recovery', { query: { ...query } }),
    getStats: () => request('GET', '/inbox/stats'),
    getDemoClock: async () => {
      try {
        return await request<DemoClock>('GET', '/demo/clock');
      } catch (error) {
        if (isApiError(error) && error.status === 404) return undefined;
        throw error;
      }
    },
    advanceClock: (days) => request('POST', '/demo/clock/advance', { body: { days } }),
    createDemoConsultation: (body) => request('POST', '/demo/consultations', { body }),
    listWebhooks: (limit, type) => request('GET', '/demo/webhooks', { query: { limit, type } }),
    listFindings: (query) => request('GET', '/inbox/findings', { query: { ...query } }),
    getFinding: (id) => request('GET', `/inbox/findings/${encodeURIComponent(id)}`),
    reviewFinding: (id, body, scope) =>
      request('POST', `${reviewerBase(scope)}/findings/${encodeURIComponent(id)}/review`, { body }),
    getReviewMetrics: () => request('GET', '/inbox/findings/metrics'),
    listFindingFlags: (scope) => request('GET', `${reviewerBase(scope)}/finding-flags`),
    updateFindingFlag: (body, scope) =>
      request('PUT', `${reviewerBase(scope)}/finding-flags`, { body }),
    listInboxFindings: (scope, filters) =>
      request('GET', `${reviewerBase(scope)}/live-findings`, { query: { ...filters } }),
    reviewLabPatient: (patientId) =>
      request('POST', `/demo/lab/patients/${encodeURIComponent(patientId)}/review`),
    listPatientQueue: (query) => request('GET', '/inbox/patients-queue', { query: { ...query } }),
    getPatientCard: (patientId) =>
      request('GET', `/inbox/patients-queue/${encodeURIComponent(patientId)}`),
    requestPatientContact: (patientId, body) =>
      request('POST', `/inbox/patients-queue/${encodeURIComponent(patientId)}/request-contact`, {
        body,
      }),
    reviewPlanItem: (expectationId, command, body) =>
      request(
        'POST',
        `/inbox/plan-items/${encodeURIComponent(expectationId)}/${command}`,
        body === undefined ? {} : { body },
      ),
    listAdjudications: (query) => request('GET', '/inbox/adjudications', { query: { ...query } }),
    overrideAdjudication: (id, body) =>
      request('POST', `/inbox/adjudications/${encodeURIComponent(id)}/override`, { body }),
    getEngineTests: async () => {
      try {
        return await request<EngineTestCatalog>('GET', '/demo/engine-tests');
      } catch (error) {
        if (isApiError(error) && error.status === 404) return undefined;
        throw error;
      }
    },
    startEngineTest: (id) => request('POST', `/demo/engine-tests/${encodeURIComponent(id)}/start`),
    submitEngineTestStep: (id, step, body) =>
      request('POST', `/demo/engine-tests/${encodeURIComponent(id)}/steps/${String(step)}`, {
        body,
      }),
    submitEngineTestFreeform: (id, body) =>
      request('POST', `/demo/engine-tests/${encodeURIComponent(id)}/freeform`, { body }),
    submitEngineTestVerdict: (id, body) =>
      request('POST', `/demo/engine-tests/${encodeURIComponent(id)}/verdict`, { body }),

    getEvaluator: async () => {
      try {
        return await request<EvaluatorIdentity>('GET', '/evaluator/me');
      } catch (error) {
        if (isApiError(error) && error.status === 404) return {};
        throw error;
      }
    },
    logoutEvaluator: () => request('POST', '/evaluator/logout'),
    trackEvaluatorEvent: (event) => request('POST', '/evaluator/events', { body: event }),
    getLabClock: async () => ({
      ...(await request<{ now: string }>('GET', '/demo/lab/clock')),
      fake: true,
    }),
    listLabPatients: () => request('GET', '/demo/lab/patients'),
    createLabPatient: (body) => request('POST', '/demo/lab/patients', { body }),
    uploadLabDocument,
    addLabRecord: (body) => request('POST', '/demo/lab/records', { body }),
    getLabPatientExpectations: (patientId) =>
      request('GET', `/demo/lab/patients/${encodeURIComponent(patientId)}/expectations`),
    advanceLabDate: (date) => request('POST', '/demo/lab/date', { body: { date } }),
    getLabCases: () => request('GET', '/demo/lab/cases'),
    importLabHistory,
    getLabHistorySamples: () => request('GET', '/demo/lab/history/samples'),
    getLabRecovery: () => request('GET', '/demo/lab/recovery'),
    listLabHeldReports: (patientId) =>
      request('GET', '/demo/lab/held-reports', {
        query: patientId === undefined ? {} : { patientId },
      }),
    decideLabHeldReport: (id, decision) =>
      request('POST', `/demo/lab/held-reports/${encodeURIComponent(id)}/${decision}`),
    listEvaluators: () => request('GET', '/demo/evaluators'),
    listEvaluatorEvents: (query) =>
      request('GET', '/demo/evaluator-events', { query: { ...query } }),
    downloadEvaluatorEventsCsv: async () =>
      (await rawFetch('GET', '/demo/evaluator-events', { query: { format: 'csv' } })).blob(),

    getLabRules: () => request('GET', '/demo/lab/rules'),
    draftLabRule: (body) => request('POST', '/demo/lab/rules/drafts', { body }),
    decideLabRule: (ruleId, decision) =>
      request('POST', `/demo/lab/rules/${encodeURIComponent(ruleId)}/${decision}`, { body: {} }),
    addLabRuleSamples: () => request('POST', '/demo/lab/rules/samples', { body: {} }),

    getAgent: (patientId) =>
      request('GET', '/demo/agent', { query: patientId === undefined ? {} : { patientId } }),
    startAgentStory: (body) => request('POST', '/demo/agent/story', { body }),
    sendAgentText: (patientId, text, source) =>
      request('POST', `/demo/agent/patients/${encodeURIComponent(patientId)}/messages`, {
        body: source === undefined ? { text } : { text, source },
      }),
    sendAgentFile: async (patientId, file) => {
      const form = new FormData();
      form.set('file', file, file.name);
      const response = await rawFetch(
        'POST',
        `/demo/agent/patients/${encodeURIComponent(patientId)}/messages`,
        { body: form },
      );
      return (await response.json()) as AgentMessageView;
    },
    sendAgentSample: (patientId, sample) =>
      request('POST', `/demo/agent/patients/${encodeURIComponent(patientId)}/samples`, {
        body: { sample },
      }),
    setAgentDelivery: (messageId, status) =>
      request('POST', `/demo/agent/messages/${encodeURIComponent(messageId)}/status`, {
        body: { status },
      }),
    fixAgentPhone: (patientId) =>
      request('POST', `/demo/agent/patients/${encodeURIComponent(patientId)}/phone-fixed`),
    confirmAgentOrder: (patientId, orderId) =>
      request(
        'POST',
        `/demo/agent/patients/${encodeURIComponent(patientId)}/orders/${encodeURIComponent(orderId)}/confirm`,
      ),
    advanceAgentClock: (days) => request('POST', '/demo/agent/clock', { body: { days } }),
    getAgentMedia: async (mediaId) =>
      (await rawFetch('GET', `/demo/agent/media/${encodeURIComponent(mediaId)}`)).blob(),
  };
}
