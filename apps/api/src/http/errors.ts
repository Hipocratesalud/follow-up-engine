import {
  ConflictError,
  InvalidCaseTransitionError,
  InvalidCursorError,
  InvalidIdentifierError,
  NotFoundError,
  type PatientContactDenial,
  PatientContactNotAllowedError,
  TenantMismatchError,
  ValidationError,
} from '@follow-up-engine/core';
import { sanitizeFhirJson } from '@follow-up-engine/fhir';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { CONTACT_LOOP_MESSAGES, invalidTransitionMessage } from '../inbox/labels.ts';
import { type FieldError, fieldErrors, SPANISH_ERRORS, validationSummary } from './validation.ts';

/**
 * An error with an HTTP status and a stable code, rendered as
 * `{ error: { code, message, fields? } }`: `fields` lists, for a validation
 * error, each field and what is wrong with it (Spanish).
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly fields?: readonly FieldError[];

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    fields?: readonly FieldError[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    if (fields !== undefined) {
      this.fields = fields;
    }
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
  contact_data_invalid:
    'El número del paciente está marcado como equivocado: corrígelo en el sistema del consultorio.',
};

/**
 * Spanish copy for the engine's business validations (`ValidationError`),
 * by field; the engine's own messages are English, for logs.
 */
const DOMAIN_VALIDATION_MESSAGES: Readonly<Record<string, string>> = {
  until: 'Solo puedes posponer un caso hasta una fecha futura.',
  status: 'El caso ya no está activo: no admite esta acción.',
  reason: 'Indica el motivo cuando el caso no fue útil.',
  note: 'Escribe una nota que explique el motivo.',
  suppressRuleIds: CONTACT_LOOP_MESSAGES.suppressNeedsNotApplicable,
  ruleId: 'Ese recordatorio no existe en el consultorio.',
  subject: 'La respuesta corresponde a otro paciente.',
  userId: 'Falta identificar a la persona del equipo que hace la revisión.',
};

function invalidRequest(fields: readonly FieldError[], message: string): HttpError {
  return new HttpError(422, 'invalid_request', message, fields);
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
    return invalidRequest(fieldErrors(error.issues), validationSummary(error.issues));
  }
  if (error instanceof InvalidCaseTransitionError) {
    return new HttpError(409, 'invalid_transition', invalidTransitionMessage(error.from, error.to));
  }
  if (error instanceof PatientContactNotAllowedError) {
    return new HttpError(409, 'patient_contact_not_allowed', CONTACT_DENIAL_MESSAGES[error.reason]);
  }
  if (error instanceof ValidationError) {
    const message =
      DOMAIN_VALIDATION_MESSAGES[error.field] ?? 'Los datos no son válidos para esta operación.';
    return invalidRequest([{ path: error.field, message }], message);
  }
  if (error instanceof NotFoundError) {
    return notFound();
  }
  if (error instanceof InvalidCursorError) {
    return new HttpError(
      400,
      'invalid_cursor',
      'El cursor de paginación no es válido para esta lista. Vuelve a pedir la primera página.',
    );
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
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields === undefined ? {} : { fields: error.fields }),
      },
    },
    error.status,
  );
}

/**
 * Reads and validates a JSON body: 400 when it is not JSON, 422
 * `invalid_request` (Spanish, field by field) when it breaks the schema.
 * Control characters (a NUL) are dropped from every string first: they
 * would never reach the clinic as text anyway.
 */
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
  return schema.parse(sanitizeFhirJson(body, 'body').value, SPANISH_ERRORS);
}

/** Validates the query string against a schema (422 `invalid_request` on failure, in Spanish). */
export function readQuery<TSchema extends z.ZodType>(
  c: Context,
  schema: TSchema,
): z.infer<TSchema> {
  return schema.parse(c.req.query(), SPANISH_ERRORS);
}
