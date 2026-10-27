import {
  delay,
  http,
  type HttpHandler,
  HttpResponse,
  type HttpResponseResolver,
  type JsonBodyType,
} from 'msw';
import {
  type CaseAction,
  type CaseActionRequest,
  type CaseListView,
  type DemoConsultationRequest,
  type FeedbackReason,
  type FeedbackRequest,
  FEEDBACK_REASONS,
  type Origin,
} from '../api/contract.ts';
import { MOCK_API_KEY } from '../config.ts';
import { MockHttpError, type MockStore } from './store.ts';

export interface HandlerOptions {
  /** Simulated network latency in ms. Zero in tests. */
  readonly latencyMs?: number;
  /** Simulated model latency for the demo consultation, in ms. */
  readonly modelLatencyMs?: number;
}

function errorResponse(status: number, code: string, message: string): Response {
  return HttpResponse.json({ error: { code, message } }, { status });
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
  throw new MockHttpError(400, 'invalid_json', 'El cuerpo de la petición no es JSON válido.');
}

const CASE_ACTIONS: readonly CaseAction[] = ['notify', 'snooze', 'resolve', 'dismiss'];

function parseAction(body: Record<string, unknown>): CaseActionRequest {
  const action = CASE_ACTIONS.find((candidate) => candidate === body['action']);
  if (!action) throw new MockHttpError(422, 'invalid_action', 'Acción no válida.');
  const snoozeDays = body['snoozeDays'];
  const note = body['note'];
  return {
    action,
    ...(typeof snoozeDays === 'number' ? { snoozeDays } : {}),
    ...(typeof note === 'string' ? { note } : {}),
  };
}

function parseFeedback(body: Record<string, unknown>): FeedbackRequest {
  const useful = body['useful'];
  if (typeof useful !== 'boolean') {
    throw new MockHttpError(422, 'invalid_feedback', 'Indica si el caso fue útil.');
  }
  const reason: FeedbackReason | undefined = FEEDBACK_REASONS.find(
    (candidate) => candidate === body['reason'],
  );
  const comment = body['comment'];
  return {
    useful,
    ...(reason ? { reason } : {}),
    ...(typeof comment === 'string' ? { comment } : {}),
  };
}

function parseConsultation(body: Record<string, unknown>): DemoConsultationRequest {
  const { patientId, patientName, specialty, noteText, orders } = body;
  if (typeof specialty !== 'string' || typeof noteText !== 'string') {
    throw new MockHttpError(422, 'invalid_consultation', 'Faltan la especialidad o la nota.');
  }
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
    }) => Promise<JsonBodyType> | JsonBodyType,
    extraLatency = 0,
  ): HttpResponseResolver {
    return async ({ request, params }) => {
      if (request.headers.get('Authorization') !== `Bearer ${MOCK_API_KEY}`) {
        return errorResponse(401, 'unauthorized', 'Clave de API no válida.');
      }
      const wait = latency + extraLatency;
      if (wait > 0) await delay(wait);
      try {
        return HttpResponse.json(await resolver({ request, params }));
      } catch (error) {
        if (error instanceof MockHttpError) {
          return errorResponse(error.status, error.code, error.message);
        }
        throw error;
      }
    };
  }

  return [
    http.get(
      '*/api/inbox/cases',
      route(({ request }) => {
        const url = new URL(request.url);
        const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view'));
        const origin = ORIGINS.find((candidate) => candidate === url.searchParams.get('origin'));
        const assignee = url.searchParams.get('assignee');
        const cursor = url.searchParams.get('cursor');
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listCases({
          ...(view ? { view } : {}),
          ...(origin ? { origin } : {}),
          ...(assignee ? { assignee } : {}),
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
      route(async ({ request, params }) =>
        store.act(param(params, 'id'), parseAction(await readJson(request))),
      ),
    ),
    http.post(
      '*/api/inbox/cases/:id/feedback',
      route(async ({ request, params }) =>
        store.feedback(param(params, 'id'), parseFeedback(await readJson(request))),
      ),
    ),
    http.get(
      '*/api/inbox/patients/:id',
      route(({ params }) => store.getPatient(param(params, 'id'))),
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
      '*/api/demo/clock',
      route(() => store.clock()),
    ),
    http.post(
      '*/api/demo/clock/advance',
      route(async ({ request }) => {
        const body = await readJson(request);
        const days = body['days'];
        if (typeof days !== 'number') {
          throw new MockHttpError(422, 'invalid_days', 'Indica cuántos días avanzar.');
        }
        return store.advance(days);
      }),
    ),
    http.post(
      '*/api/demo/consultations',
      route(
        async ({ request }) => store.createConsultation(parseConsultation(await readJson(request))),
        options.modelLatencyMs ?? 0,
      ),
    ),
    http.get(
      '*/api/demo/webhooks',
      route(({ request }) => {
        const limit = numberParam(new URL(request.url).searchParams.get('limit'));
        return store.listWebhooks(limit);
      }),
    ),
  ];
}
