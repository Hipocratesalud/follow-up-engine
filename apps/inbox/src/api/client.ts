import type { ApiConfig } from '../config.ts';
import type {
  ApiErrorBody,
  CaseActionRequest,
  CaseDetail,
  CaseListQuery,
  CaseView,
  ClinicInfo,
  ConditionView,
  DemoClock,
  DemoConsultationRequest,
  DemoConsultationResponse,
  FeedbackRequest,
  InboxStats,
  OwnerView,
  Page,
  PatientDetail,
  PatientSummary,
  RecoveryPage,
  WebhookDelivery,
} from './contract.ts';

/** An HTTP error from the API, with the contract's `{ error: { code, message } }` body when present. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

async function readErrorBody(response: Response): Promise<ApiError> {
  let body: unknown = undefined;
  try {
    body = await response.json();
  } catch {
    // Not JSON (proxy error page, empty body): fall through to a generic error.
  }
  if (isErrorBody(body)) {
    return new ApiError(response.status, body.error.code, body.error.message);
  }
  return new ApiError(
    response.status,
    `http_${String(response.status)}`,
    'El servidor no respondió como esperábamos. Intenta de nuevo.',
  );
}

export interface ApiClient {
  getClinic(): Promise<ClinicInfo>;
  listCases(query: CaseListQuery): Promise<Page<CaseView>>;
  getCase(id: string): Promise<CaseDetail>;
  actOnCase(id: string, body: CaseActionRequest): Promise<CaseDetail>;
  sendFeedback(id: string, body: FeedbackRequest): Promise<unknown>;
  listOwners(): Promise<{ items: OwnerView[] }>;
  listPatients(query: { query?: string; limit?: number }): Promise<{ items: PatientSummary[] }>;
  getPatient(id: string): Promise<PatientDetail>;
  confirmCondition(id: string): Promise<ConditionView>;
  rejectCondition(id: string): Promise<ConditionView>;
  listRecovery(query: { cursor?: string; limit?: number }): Promise<RecoveryPage>;
  getStats(): Promise<InboxStats>;
  /** `undefined` when the API runs on a real clock (the demo endpoints answer 404). */
  getDemoClock(): Promise<DemoClock | undefined>;
  advanceClock(days: number): Promise<{ now: string }>;
  createDemoConsultation(body: DemoConsultationRequest): Promise<DemoConsultationResponse>;
  listWebhooks(limit: number, type?: string): Promise<{ items: WebhookDelivery[] }>;
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
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
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
      throw new ApiError(
        0,
        'network_error',
        'No pudimos conectar con el servidor. Revisa tu conexión.',
      );
    }
    if (!response.ok) throw await readErrorBody(response);
    return (await response.json()) as T;
  }

  return {
    getClinic: () => request('GET', '/inbox/clinic'),
    listCases: (query) => request('GET', '/inbox/cases', { query: { ...query } }),
    getCase: (id) => request('GET', `/inbox/cases/${encodeURIComponent(id)}`),
    actOnCase: (id, body) =>
      request('POST', `/inbox/cases/${encodeURIComponent(id)}/actions`, { body }),
    sendFeedback: (id, body) =>
      request('POST', `/inbox/cases/${encodeURIComponent(id)}/feedback`, { body }),
    listOwners: () => request('GET', '/inbox/owners'),
    listPatients: (query) => request('GET', '/inbox/patients', { query: { ...query } }),
    getPatient: (id) => request('GET', `/inbox/patients/${encodeURIComponent(id)}`),
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
  };
}
