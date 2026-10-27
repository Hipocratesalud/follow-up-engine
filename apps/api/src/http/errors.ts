import {
  ConflictError,
  InvalidCaseTransitionError,
  InvalidIdentifierError,
  NotFoundError,
  TenantMismatchError,
  ValidationError,
} from '@follow-up-engine/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

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
    return new HttpError(
      409,
      'invalid_transition',
      `El caso no puede pasar de "${error.from}" a "${error.to}".`,
    );
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
