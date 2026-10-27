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
import { INPUT_LIMITS } from '../lib/limits.ts';
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

/** The API's 422 for a too long input: `invalid_request` with one Spanish message per field. */
function checkLength(path: string, value: unknown, max: number, what: string): void {
  if (typeof value !== 'string' || value.length <= max) return;
  const message = `${what} puede tener hasta ${max.toLocaleString('es')} caracteres.`;
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
  throw new MockHttpError(400, 'invalid_json', 'El cuerpo de la petición no es JSON válido.');
}

const CASE_ACTIONS: readonly CaseAction[] = ['notify', 'snooze', 'resolve', 'dismiss'];

function parseAction(body: Record<string, unknown>): CaseActionRequest {
  const action = CASE_ACTIONS.find((candidate) => candidate === body['action']);
  if (!action) throw new MockHttpError(422, 'invalid_action', 'Acción no válida.');
  const snoozeDays = body['snoozeDays'];
  const note = body['note'];
  checkLength('note', note, INPUT_LIMITS.note, 'La nota');
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
  checkLength('comment', comment, INPUT_LIMITS.comment, 'El comentario');
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
  checkLength('patientName', patientName, INPUT_LIMITS.patientName, 'El nombre');
  checkLength('noteText', noteText, INPUT_LIMITS.noteText, 'La nota');
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
      route(({ request }) => {
        const url = new URL(request.url);
        const view = VIEWS.find((candidate) => candidate === url.searchParams.get('view'));
        const origin = ORIGINS.find((candidate) => candidate === url.searchParams.get('origin'));
        const assignee = url.searchParams.get('assignee');
        const q = url.searchParams.get('q');
        checkLength('q', q, INPUT_LIMITS.search, 'La búsqueda');
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
      route(async ({ request, params }) => {
        const body = await readJson(request);
        const verdict = body['verdict'];
        const reason = body['reason'];
        if (verdict !== 'relevant' && verdict !== 'already_known' && verdict !== 'not_relevant') {
          throw new MockHttpError(422, 'invalid_request', 'Elige una calificación.');
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
      route(async ({ request }) => {
        const body = await readJson(request);
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
        const url = new URL(request.url);
        const limit = numberParam(url.searchParams.get('limit'));
        return store.listWebhooks(limit, url.searchParams.get('type') ?? undefined);
      }),
    ),
  ];
}
