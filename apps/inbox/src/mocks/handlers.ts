import {
  delay,
  http,
  type HttpHandler,
  HttpResponse,
  type HttpResponseResolver,
  type JsonBodyType,
} from 'msw';
import {
  type ApiFieldError,
  CALL_OUTCOMES,
  type CallOutcomeRequest,
  DISMISS_REASONS,
  type CaseAction,
  type CaseActionRequest,
  type CaseListView,
  type DemoConsultationRequest,
  type FeedbackReason,
  type FeedbackRequest,
  FEEDBACK_REASONS,
  type Origin,
} from '../api/contract.ts';
import { PLAN_ITEM_KINDS, type PlanItemCommand } from '../api/plan-item-contract.ts';
import { MOCK_API_KEY } from '../config.ts';
import { mockMetrics } from '../features/metrics/mock.ts';
import { DEFAULT_LOCALE, isLocale, type Locale, messagesFor } from '../i18n/index.ts';
import { INPUT_LIMITS } from '../lib/limits.ts';
import { type MockApiCopy, mockApiCopy } from './api-copy.ts';
import { ReviewerMockError } from './reviewer.ts';
import { MockHttpError, type MockStore } from './store.ts';

export interface HandlerOptions {
  /** Simulated network latency in ms. Zero in tests. */
  readonly latencyMs?: number;
  /** Simulated model latency for the demo consultation, in ms. */
  readonly modelLatencyMs?: number;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  fields: readonly ApiFieldError[] = [],
): Response {
  return HttpResponse.json(
    { error: { code, message, ...(fields.length > 0 ? { fields } : {}) } },
    { status },
  );
}

/**
 * The request's language, as apps/api reads it: the first `Accept-Language`
 * tag whose primary language the API has (English or Spanish), else English.
 */
export function requestLocale(request: Request): Locale {
  const header = request.headers.get('Accept-Language') ?? '';
  for (const part of header.split(',')) {
    const primary = part.split(';')[0]?.trim().split('-')[0]?.toLowerCase();
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/** The API's 422 for a too long input: `invalid_request` with one message per field. */
function checkLength(
  copy: MockApiCopy,
  locale: Locale,
  path: string,
  value: unknown,
  max: number,
  what: string,
): void {
  if (typeof value !== 'string' || value.length <= max) return;
  const message = copy.errors.tooLong(what, max.toLocaleString(locale));
  throw new MockHttpError(422, 'invalid_request', message, [{ path, message }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (isRecord(body)) return body;
  } catch {
    // Fall through to the validation error below.
  }
  throw new MockHttpError(
    400,
    'invalid_json',
    mockApiCopy(requestLocale(request)).errors.invalidJson,
  );
}

const CASE_ACTIONS: readonly CaseAction[] = ['notify', 'snooze', 'resolve', 'dismiss'];

function parseAction(body: Record<string, unknown>, locale: Locale): CaseActionRequest {
  const copy = mockApiCopy(locale);
  const action = CASE_ACTIONS.find((candidate) => candidate === body['action']);
  if (!action) throw new MockHttpError(422, 'invalid_action', copy.errors.invalidAction);
  const snoozeDays = body['snoozeDays'];
  const note = body['note'];
  checkLength(copy, locale, 'note', note, INPUT_LIMITS.note, copy.errors.fields.note);
  const reason = DISMISS_REASONS.find((candidate) => candidate === body['reason']);
  return {
    action,
    ...(typeof snoozeDays === 'number' ? { snoozeDays } : {}),
    ...(typeof note === 'string' ? { note } : {}),
    ...(reason ? { reason } : {}),
    ...(body['suppress'] === true ? { suppress: true } : {}),
  };
}

function parseCallOutcome(body: Record<string, unknown>, locale: Locale): CallOutcomeRequest {
  const outcome = CALL_OUTCOMES.find((candidate) => candidate === body['outcome']);
  if (!outcome) {
    const message = messagesFor(locale).validation.callOutcomeRequired;
    throw new MockHttpError(422, 'invalid_request', message, [{ path: 'outcome', message }]);
  }
  const requestId = body['requestId'];
  return { outcome, ...(typeof requestId === 'string' ? { requestId } : {}) };
}

function parseFeedback(body: Record<string, unknown>, locale: Locale): FeedbackRequest {
  const copy = mockApiCopy(locale);
  const useful = body['useful'];
  if (typeof useful !== 'boolean') {
    throw new MockHttpError(422, 'invalid_feedback', copy.errors.feedbackUseful);
  }
  const reason: FeedbackReason | undefined = FEEDBACK_REASONS.find(
    (candidate) => candidate === body['reason'],
  );
  const comment = body['comment'];
  checkLength(copy, locale, 'comment', comment, INPUT_LIMITS.comment, copy.errors.fields.comment);
  return {
    useful,
    ...(reason ? { reason } : {}),
    ...(typeof comment === 'string' ? { comment } : {}),
  };
}

function parseConsultation(body: Record<string, unknown>, locale: Locale): DemoConsultationRequest {
  const copy = mockApiCopy(locale);
  const { patientId, patientName, specialty, noteText, orders } = body;
  if (typeof specialty !== 'string' || typeof noteText !== 'string') {
    throw new MockHttpError(422, 'invalid_consultation', copy.errors.consultationIncomplete);
  }
  checkLength(
    copy,
    locale,
    'patientName',
    patientName,
    INPUT_LIMITS.patientName,
    copy.errors.fields.name,
  );
  checkLength(copy, locale, 'noteText', noteText, INPUT_LIMITS.noteText, copy.errors.fields.note);
  const parsedOrders = Array.isArray(orders)
    ? orders
        .filter(isRecord)
        .flatMap((order) =>
          typeof order['loinc'] === 'string' && typeof order['display'] === 'string'
            ? [{ loinc: order['loinc'], display: order['display'] }]
            : [],
        )
    : [];
  return {
    specialty,
    noteText,
    orders: parsedOrders,
    ...(typeof patientId === 'string' && patientId ? { patientId } : {}),
    ...(typeof patientName === 'string' && patientName ? { patientName } : {}),
  };
}

const VIEWS: readonly CaseListView[] = ['active', 'closed', 'all'];
const PLAN_ITEM_COMMANDS: readonly PlanItemCommand[] = ['confirm', 'correct', 'reject'];
const ORIGINS: readonly Origin[] = ['live', 'backfill'];

function numberParam(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function param(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : '';
}

/**
 * MSW handlers that serve the inbox contract from a {@link MockStore}. The
 * same handlers back the browser mock and the Vitest suite.
 */
export function createHandlers(store: MockStore, options: HandlerOptions = {}): HttpHandler[] {
  const latency = options.latencyMs ?? 0;

  function route(
    resolver: (args: {
      request: Request;
      params: Record<string, unknown>;
      locale: Locale;
    }) => Promise<JsonBodyType> | JsonBodyType,
    extraLatency = 0,
  ): HttpResponseResolver {
    return async ({ request, params }) => {
      const locale = requestLocale(request);
      if (request.headers.get('Authorization') !== `Bearer ${MOCK_API_KEY}`) {
        return errorResponse(401, 'unauthorized', messagesFor(locale).errors.generic);
      }
      const wait = latency + extraLatency;
      if (wait > 0) await delay(wait);
      // Labels in the request's language, like apps/api (which also answers Content-Language).
      store.setLocale(locale);
      try {
        const body = await resolver({ request, params, locale });
        return HttpResponse.json(body, { headers: { 'Content-Language': locale } });
      } catch (error) {
        if (error instanceof MockHttpError || error instanceof ReviewerMockError) {
          return errorResponse(error.status, error.code, error.message, error.fields);
        }
        throw error;
      }
    };
  }

  return [
    http.get(
      '*/api/inbox/clinic',
      route(() => store.clinic()),
    ),
    http.get(
      '*/api/inbox/cases',
      route(({ request, locale }) => {
        const url = new URL(request.url);
        const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view'));
        const origin = ORIGINS.find((candidate) => candidate === url.searchParams.get('origin'));
        const assignee = url.searchParams.get('assignee');
        const q = url.searchParams.get('q');
        const copy = mockApiCopy(locale);
        checkLength(copy, locale, 'q', q, INPUT_LIMITS.search, copy.errors.fields.search);
        const patient = url.searchParams.get('patient');
        const cursor = url.searchParams.get('cursor');
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listCases({
          ...(view ? { view } : {}),
          ...(origin ? { origin } : {}),
          ...(assignee ? { assignee } : {}),
          ...(q ? { q } : {}),
          ...(patient ? { patient } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
    ),
    http.get(
      '*/api/inbox/cases/:id',
      route(({ params }) => store.getCase(param(params, 'id'))),
    ),
    http.post(
      '*/api/inbox/cases/:id/actions',
      route(async ({ request, params, locale }) => {
        const body = parseAction(await readJson(request), locale);
        store.setLocale(locale);
        return store.act(param(params, 'id'), body);
      }),
    ),
    http.post(
      '*/api/inbox/cases/:id/call-outcome',
      route(async ({ request, params, locale }) => {
        const body = parseCallOutcome(await readJson(request), locale);
        store.setLocale(locale);
        return store.recordCallOutcome(param(params, 'id'), body);
      }),
    ),
    http.post(
      '*/api/inbox/suppressions/:id/reactivate',
      route(({ params }) => store.reactivateSuppression(param(params, 'id'))),
    ),
    http.get(
      '*/api/inbox/calibration',
      route(() => store.calibration()),
    ),
    http.post(
      '*/api/inbox/cases/:id/feedback',
      route(async ({ request, params, locale }) => {
        const body = parseFeedback(await readJson(request), locale);
        store.setLocale(locale);
        return store.feedback(param(params, 'id'), body);
      }),
    ),
    http.get(
      '*/api/inbox/owners',
      route(() => store.listOwners()),
    ),
    http.get(
      '*/api/inbox/patients',
      route(({ request }) => {
        const url = new URL(request.url);
        return store.listPatients(
          url.searchParams.get('query') ?? undefined,
          numberParam(url.searchParams.get('limit')),
        );
      }),
    ),
    http.get(
      '*/api/inbox/patients/:id',
      route(({ params }) => store.getPatient(param(params, 'id'))),
    ),
    http.get(
      '*/api/inbox/patients/:id/documents',
      route(({ params }) => store.getPatientDocuments(param(params, 'id'))),
    ),
    http.post(
      '*/api/inbox/conditions/:id/confirm',
      route(({ params }) => store.reviewCondition(param(params, 'id'), 'confirm')),
    ),
    http.post(
      '*/api/inbox/conditions/:id/reject',
      route(({ params }) => store.reviewCondition(param(params, 'id'), 'reject')),
    ),
    http.get(
      '*/api/inbox/patients-queue',
      route(({ request, locale }) => {
        const url = new URL(request.url);
        const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view'));
        const origin = ORIGINS.find((candidate) => candidate === url.searchParams.get('origin'));
        const assignee = url.searchParams.get('assignee');
        const q = url.searchParams.get('q');
        const copy = mockApiCopy(locale);
        checkLength(copy, locale, 'q', q, INPUT_LIMITS.search, copy.errors.fields.search);
        const cursor = url.searchParams.get('cursor');
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listPatientQueue({
          ...(view ? { view } : {}),
          ...(origin ? { origin } : {}),
          ...(assignee ? { assignee } : {}),
          ...(q ? { q } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
    ),
    http.get(
      '*/api/inbox/patients-queue/:id',
      route(({ params }) => store.getPatientCard(param(params, 'id'))),
    ),
    http.post(
      '*/api/inbox/patients-queue/:id/request-contact',
      route(async ({ request, params, locale }) => {
        const copy = mockApiCopy(locale);
        const body = await readJson(request);
        const note = body['note'];
        checkLength(copy, locale, 'note', note, INPUT_LIMITS.note, copy.errors.fields.note);
        return store.requestPatientContact(
          param(params, 'id'),
          typeof note === 'string' ? note : undefined,
        );
      }),
    ),
    http.post(
      '*/api/inbox/plan-items/:id/:command',
      route(async ({ request, params, locale }) => {
        const command = PLAN_ITEM_COMMANDS.find(
          (candidate) => candidate === param(params, 'command'),
        );
        if (!command) throw new MockHttpError(404, 'not_found', messagesFor(locale).errors.generic);
        const body = command === 'correct' ? await readJson(request) : {};
        const kind = PLAN_ITEM_KINDS.find((candidate) => candidate === body['kind']);
        const dueDate = body['dueDate'];
        return store.reviewPlanItem(param(params, 'id'), command, {
          ...(kind ? { kind } : {}),
          ...(typeof dueDate === 'string' ? { dueDate } : {}),
        });
      }),
    ),
    http.get(
      '*/api/inbox/recovery',
      route(({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listRecovery({
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
    ),
    http.get(
      '*/api/inbox/stats',
      route(() => store.stats()),
    ),
    http.get(
      '*/api/inbox/metrics',
      route(({ request }) => {
        const url = new URL(request.url);
        return mockMetrics(
          new Date(store.clock().now),
          url.searchParams.get('from') ?? undefined,
          url.searchParams.get('to') ?? undefined,
        );
      }),
    ),
    http.get(
      '*/api/inbox/findings',
      route(({ request }) => {
        const url = new URL(request.url);
        const value = (key: string): string | undefined => url.searchParams.get(key) ?? undefined;
        const mode = value('mode') === 'live' ? 'live' : 'shadow';
        const status = value('status');
        const limit = numberParam(url.searchParams.get('limit'));
        return store.reviewer.listFindings({
          mode,
          ...(status ? { status: status as 'open' } : {}),
          ...(value('category') ? { category: value('category') ?? '' } : {}),
          ...(value('severity') ? { severity: value('severity') ?? '' } : {}),
          ...(value('patientId') ? { patientId: value('patientId') ?? '' } : {}),
          ...(limit === undefined ? {} : { limit }),
        });
      }),
    ),
    http.get(
      '*/api/inbox/findings/metrics',
      route(() => store.reviewer.metrics()),
    ),
    http.get(
      '*/api/inbox/findings/:id',
      route(({ params }) => store.reviewer.getFinding(param(params, 'id'))),
    ),
    http.post(
      '*/api/inbox/findings/:id/review',
      route(async ({ request, params, locale }) => {
        const body = await readJson(request);
        store.setLocale(locale);
        const verdict = body['verdict'];
        const reason = body['reason'];
        if (verdict !== 'relevant' && verdict !== 'already_known' && verdict !== 'not_relevant') {
          throw new MockHttpError(
            422,
            'invalid_request',
            messagesFor(locale).errors.validationFallback,
          );
        }
        return store.reviewer.review(param(params, 'id'), {
          verdict,
          ...(typeof reason === 'string' && reason ? { reason } : {}),
        });
      }),
    ),
    http.get(
      '*/api/inbox/finding-flags',
      route(() => store.reviewer.listFlags()),
    ),
    http.put(
      '*/api/inbox/finding-flags',
      route(async ({ request, locale }) => {
        const body = await readJson(request);
        store.setLocale(locale);
        const validatedBy = body['validatedBy'];
        return store.reviewer.updateFlag({
          category: body['category'] as never,
          enabled: body['enabled'] === true,
          mode: body['mode'] === 'live' ? 'live' : 'shadow',
          ...(typeof validatedBy === 'string' && validatedBy ? { validatedBy } : {}),
        });
      }),
    ),
    http.get(
      '*/api/demo/clock',
      route(() => store.clock()),
    ),
    http.post(
      '*/api/demo/clock/advance',
      route(async ({ request, locale }) => {
        const body = await readJson(request);
        store.setLocale(locale);
        const days = body['days'];
        if (typeof days !== 'number') {
          throw new MockHttpError(422, 'invalid_days', mockApiCopy(locale).errors.invalidDays);
        }
        return store.advance(days);
      }),
    ),
    http.post(
      '*/api/demo/consultations',
      route(async ({ request, locale }) => {
        const body = parseConsultation(await readJson(request), locale);
        store.setLocale(locale);
        return store.createConsultation(body);
      }, options.modelLatencyMs ?? 0),
    ),
    http.get(
      '*/api/demo/webhooks',
      route(({ request }) => {
        const url = new URL(request.url);
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listWebhooks(limit, url.searchParams.get('type') ?? undefined);
      }),
    ),
    // The evaluator lab (docs/deploy.md#hosted-demo): no evaluator identity
    // by default, same as a plain deployment with no access gate. Tests of
    // the Lab and Evaluators pages override this through `renderApp`'s
    // `handlers` option.
    http.get(
      '*/api/evaluator/me',
      route(() => ({})),
    ),
  ];
}
