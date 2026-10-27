import {
  ConflictError,
  InvalidCaseTransitionError,
  InvalidIdentifierError,
  NotFoundError,
  type PatientContactDenial,
  PatientContactNotAllowedError,
  TenantMismatchError,
  ValidationError,
} from '@follow-up-engine/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { invalidTransitionMessage } from '../inbox/labels.ts';

/** An error with an HTTP status and a stable code, rendered as `{ error: { code, message } }`. */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function notFound(message = 'No encontramos lo que buscas.'): HttpError {
  return new HttpError(404, 'not_found', message);
}

const CONTACT_DENIAL_MESSAGES: Record<PatientContactDenial, string> = {
  clinic_disallows_contact: 'El consultorio no tiene activado el contacto con pacientes.',
  patient_opted_out:
    'El paciente pidió no recibir mensajes del consultorio. Contáctalo por otra vía y luego resuelve el caso.',
  contact_window:
    'Ya se pidió contactar a este paciente hace pocos días. Espera a que responda o contáctalo por otra vía.',
  backfill_case:
    'Este caso viene de la revisión del historial: el equipo decide a quién contactar.',
  low_confidence: 'El caso se apoya en una condición sin confirmar: revísala antes de contactar.',
};

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/**
 * Maps any error to its HTTP answer. Domain errors keep their meaning:
 * invalid transition 409, business validation 422, unknown entity 404.
 * Unexpected errors are 500 with a generic message (details only in logs).
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new HttpError(422, 'validation_error', zodMessage(error));
  }
  if (error instanceof InvalidCaseTransitionError) {
    return new HttpError(409, 'invalid_transition', invalidTransitionMessage(error.from, error.to));
  }
  if (error instanceof PatientContactNotAllowedError) {
    return new HttpError(409, 'patient_contact_not_allowed', CONTACT_DENIAL_MESSAGES[error.reason]);
  }
  if (error instanceof ValidationError) {
    return new HttpError(422, 'validation_error', `${error.field}: ${error.message}`);
  }
  if (error instanceof NotFoundError) {
    return notFound();
  }
  if (error instanceof InvalidIdentifierError) {
    return new HttpError(400, 'invalid_identifier', 'Identificador no válido.');
  }
  if (error instanceof ConflictError) {
    return new HttpError(409, 'conflict', 'La operación entra en conflicto con el estado actual.');
  }
  if (error instanceof TenantMismatchError) {
    return notFound();
  }
  return new HttpError(500, 'internal_error', 'Ocurrió un error inesperado. Intenta de nuevo.');
}

export function errorResponse(c: Context, error: HttpError): Response {
  return c.json({ error: { code: error.code, message: error.message } }, error.status);
}

/** Reads and validates a JSON body: 400 when it is not JSON, 422 when it breaks the schema. */
export async function readJson<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'El cuerpo de la petición no es JSON válido.');
  }
  return schema.parse(body);
}

/** Validates the query string against a schema (422 on failure). */
export function readQuery<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): z.infer<TSchema> {
  return schema.parse(c.req.query());
}
